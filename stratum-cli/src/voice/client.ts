/**
 * M25 (voz) — el cliente del worker de voz, en el proceso padre.
 *
 * Un proceso hijo por sesión de voz: se arranca con la primera petición, atiende
 * **una transcripción a la vez** (el decoder tiene una sola caché) y muere solo
 * tras `idleUnloadMinutes` sin uso. Matarlo es la única forma segura de devolver
 * la memoria de la GPU.
 *
 * Si el worker se cae, la petición en curso y las que esperaban se rechazan, y
 * la siguiente lo relanza: no poder transcribir es un fallo auxiliar, nunca
 * tumba el turno de nadie.
 *
 * Dos detalles que no deben perderse:
 * - el plazo de una petición se arma **antes** de arrancar al hijo, así que
 *   `spawn`, `init` y la espera del `ready` cuentan dentro: un modelo que no
 *   carga a tiempo tiene que fallar, no quedarse colgado;
 * - cada hijo lleva su **generación**: el cierre tardío de un hijo viejo (el que
 *   se mató por plazo) no puede tocar el estado del que lo reemplaza.
 */

import { execa } from 'execa';
import { fileURLToPath } from 'url';
import {
  VOICE_MAX_QUEUE,
  VOICE_REQUEST_TIMEOUT_MS,
  type VoiceDeviceChoice,
  type VoiceReadyDevice,
  type VoiceTranscript,
  type VoiceTranscriptDevice,
  type WorkerErrorCode,
  type WorkerOutbound,
} from './worker-protocol.js';

/** El worker no está `onnxruntime-node`: sin él no hay transcripción local. */
export class VoiceRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceRuntimeUnavailableError';
  }
}

/** El worker respondió un `error` del protocolo (código y mensaje del hijo). */
export class VoiceWorkerError extends Error {
  constructor(
    message: string,
    readonly code: WorkerErrorCode,
  ) {
    super(message);
    this.name = 'VoiceWorkerError';
  }
}

/** Ya hay `maxQueue` notas esperando: esta se rechaza sin encolarse. */
export class VoiceQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceQueueFullError';
  }
}

/** Se venció `requestTimeoutMs`: se rechaza y se mata el worker. */
export class VoiceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceTimeoutError';
  }
}

/** El worker se cayó, se cerró o lo cerró `close()`. */
export class VoiceWorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceWorkerCrashedError';
  }
}

/** Lo mínimo del proceso hijo que usa el cliente (`execa` con `ipc: true`). */
export interface VoiceWorkerChild {
  sendMessage(message: unknown): Promise<void>;
  getEachMessage(): AsyncIterableIterator<unknown>;
  kill(signal?: NodeJS.Signals): boolean;
  /** Lo último que escribió el hijo en stderr (para el mensaje de caída). */
  stderrTail?(): string;
}

export interface VoiceWorkerClientOptions {
  /** Directorio del modelo (`voiceModelDir()`). */
  dir: string;
  device?: VoiceDeviceChoice;
  /** Idioma de Canary: sale de la config y nunca se detecta solo. */
  language: string;
  /** Minutos sin uso antes de matar el worker. */
  idleUnloadMinutes: number;
  /** Peticiones que pueden esperar. Por encima, `VoiceQueueFullError`. */
  maxQueue?: number;
  /** Plazo de una transcripción de punta a punta, arranque del hijo incluido. */
  requestTimeoutMs?: number;
  /** Cómo se lanza el hijo (los tests pasan un worker falso). */
  spawnWorker?: () => VoiceWorkerChild;
}

/** Lo que el worker contó al cargar (todavía sin confirmar la GPU). */
interface ReadyInfo {
  device: VoiceReadyDevice;
  warning?: string;
  loadMs: number;
}

interface PendingRequest {
  id: number;
  pcm: Float32Array;
  resolve: (transcript: VoiceTranscript) => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
}

interface ReadyWait {
  /** Generación del hijo al que pertenece esta espera. */
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferredReady(generation: number): ReadyWait {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // El rechazo lo consume `ensureWorker`; si nadie llegara a esperarlo, no puede
  // tumbar el proceso con un unhandled rejection.
  promise.catch(() => undefined);
  return { generation, promise, resolve, reject };
}

/** Cuántos bytes del stderr del hijo se guardan para el mensaje de caída. */
const STDERR_TAIL_BYTES = 8 * 1024;

/** Los últimos `STDERR_TAIL_BYTES` de stderr, en un búfer circular. */
class StderrTail {
  private readonly buffer = Buffer.alloc(STDERR_TAIL_BYTES);
  private length = 0;
  private start = 0;

  push(chunk: Buffer): void {
    let data = chunk;
    if (data.length > STDERR_TAIL_BYTES) data = data.subarray(data.length - STDERR_TAIL_BYTES);
    if (data.length === 0) return;
    if (this.length + data.length <= STDERR_TAIL_BYTES) {
      this.buffer.set(data, (this.start + this.length) % STDERR_TAIL_BYTES);
      this.length += data.length;
      return;
    }
    // Se llena: lo más viejo se va pisando.
    for (const byte of data) {
      this.buffer[(this.start + this.length) % STDERR_TAIL_BYTES] = byte;
      if (this.length < STDERR_TAIL_BYTES) this.length++;
      else this.start = (this.start + 1) % STDERR_TAIL_BYTES;
    }
  }

  text(): string {
    if (this.start === 0) return this.buffer.subarray(0, this.length).toString('utf-8');
    return (
      this.buffer.subarray(this.start, STDERR_TAIL_BYTES).toString('utf-8') +
      this.buffer.subarray(0, this.length - (STDERR_TAIL_BYTES - this.start)).toString('utf-8')
    );
  }
}

/** Ruta del worker ya compilado: `dist/voice-worker.js`, al lado de `dist/index.js`. */
export function voiceWorkerPath(): string {
  return fileURLToPath(new URL('./voice-worker.js', import.meta.url));
}

/** El hijo por defecto: `node dist/voice-worker.js`, con IPC y serialización avanzada. */
function defaultSpawn(): VoiceWorkerChild {
  const child = execa(process.execPath, [voiceWorkerPath()], {
    ipc: true,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe'],
    // `buffer: false`: el stderr llega como stream mientras el hijo vive, que es
    // lo único que sirve para contarlo cuando se cae.
    buffer: false,
  });
  const tail = new StderrTail();
  child.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));
  // Matar el hijo con SIGKILL hace rechazar la promesa de `execa`. Sin este
  // oyente, el daemon se lleva un unhandledRejection y se cae entero.
  child.catch(() => undefined);
  // `execa` devuelve la promesa del proceso con los métodos de IPC; el cliente
  // solo usa esos y así los tests pueden inyectar un worker falso.
  const wrapped = child as unknown as VoiceWorkerChild;
  wrapped.stderrTail = () => tail.text();
  return wrapped;
}

export class VoiceWorkerClient {
  private readonly dir: string;
  private readonly deviceChoice: VoiceDeviceChoice;
  private readonly language: string;
  private readonly idleMs: number;
  private readonly maxQueue: number;
  private readonly requestTimeoutMs: number;
  private readonly spawn: () => VoiceWorkerChild;

  private child?: VoiceWorkerChild;
  /** Generación del hijo actual. Se incrementa cada vez que se suelta uno. */
  private childGeneration?: number;
  private generation = 0;
  private readyInfo?: ReadyInfo;
  private readyWait?: ReadyWait;
  private queue: PendingRequest[] = [];
  private inflight?: PendingRequest;
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private lastTranscript?: VoiceTranscript;

  constructor(opts: VoiceWorkerClientOptions) {
    this.dir = opts.dir;
    this.deviceChoice = opts.device ?? 'auto';
    this.language = opts.language;
    this.idleMs = Math.max(0, opts.idleUnloadMinutes) * 60_000;
    this.maxQueue = opts.maxQueue ?? VOICE_MAX_QUEUE;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? VOICE_REQUEST_TIMEOUT_MS;
    this.spawn = opts.spawnWorker ?? defaultSpawn;
  }

  /** Dispositivo **confirmado** del último resultado (si aún no hubo, `undefined`). */
  get device(): VoiceTranscriptDevice | undefined {
    return this.lastTranscript?.device;
  }

  /** Por qué no se está usando el dispositivo pedido. */
  get warning(): string | undefined {
    return this.lastTranscript ? this.lastTranscript.warning : this.readyInfo?.warning;
  }

  /** Milisegundos que tardó la última carga del modelo. */
  get loadMs(): number | undefined {
    return this.readyInfo?.loadMs;
  }

  /** ¿Hay un worker vivo ahora mismo? (arranca solo, al llegar audio) */
  get running(): boolean {
    return this.child !== undefined;
  }

  /** Peticiones esperando turno (la que se está atendiendo no cuenta). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Encola un PCM de 16 kHz. Se atiende una petición a la vez, en orden.
   *
   * @throws VoiceQueueFullError si ya hay `maxQueue` esperando.
   */
  async transcribe(pcm16k: Float32Array): Promise<VoiceTranscript> {
    if (this.closed) throw new VoiceWorkerCrashedError('el cliente de voz está cerrado');
    if (this.queue.length >= this.maxQueue) {
      throw new VoiceQueueFullError(
        `ya hay ${this.queue.length} notas de voz esperando; esta se rechaza`,
      );
    }
    return new Promise<VoiceTranscript>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, pcm: pcm16k, resolve, reject });
      void this.pump();
    });
  }

  /** Mata el worker y rechaza lo pendiente. */
  close(): void {
    this.closed = true;
    this.clearIdle();
    this.rejectAll(new VoiceWorkerCrashedError('el cliente de voz se ha cerrado'));
    this.unload();
  }

  // -------------------------------------------------------------------------
  // Cola
  // -------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.inflight || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.inflight = request;
    this.clearIdle();
    // El plazo se arma **antes** de arrancar al hijo: `spawn`, `init` y la
    // espera del `ready` también cuentan.
    request.timer = setTimeout(() => this.onTimeout(request), this.requestTimeoutMs);
    try {
      await this.ensureWorker();
      if (this.inflight !== request) return; // se cayó (o venció el plazo) mientras arrancaba
      await this.child?.sendMessage({ t: 'transcribe', id: request.id, pcm: request.pcm });
    } catch (err) {
      this.settleError(request, err);
    }
  }

  /** Arranca el hijo si no está y espera su `ready`. */
  private async ensureWorker(): Promise<void> {
    if (this.child) return;
    const child = this.spawn();
    const generation = ++this.generation;
    this.child = child;
    this.childGeneration = generation;
    this.readyInfo = undefined;
    const readyWait = deferredReady(generation);
    this.readyWait = readyWait;
    void this.watch(child, generation);
    try {
      await child.sendMessage({
        t: 'init',
        dir: this.dir,
        device: this.deviceChoice,
        language: this.language,
      });
      await readyWait.promise;
    } catch (err) {
      await this.killChild(generation);
      throw err;
    } finally {
      if (this.readyWait === readyWait) this.readyWait = undefined;
    }
  }

  /**
   * Lee los mensajes del hijo hasta que se cierra. Que el iterador termine es la
   * señal de que el proceso ya no está (caída, cierre o `kill`).
   */
  private async watch(child: VoiceWorkerChild, generation: number): Promise<void> {
    try {
      for await (const raw of child.getEachMessage()) {
        this.onMessage(child, generation, raw);
      }
    } catch {
      // Un hijo que muere con código distinto de 0 hace terminar el iterador con
      // error: es una caída, y se trata igual que el cierre.
    }
    this.onExit(generation);
  }

  /** ¿Sigue siendo el hijo actual? Un cierre tardío del viejo no cuenta. */
  private isCurrent(generation: number): boolean {
    return this.childGeneration === generation;
  }

  private onMessage(child: VoiceWorkerChild, generation: number, raw: unknown): void {
    if (this.child !== child || !this.isCurrent(generation)) return;
    const message = raw as WorkerOutbound;
    if (!message || typeof message !== 'object') return;
    if (message.t === 'ready') {
      const info: ReadyInfo = { device: message.device, loadMs: message.loadMs };
      if (message.warning !== undefined) info.warning = message.warning;
      this.readyInfo = info;
      if (this.readyWait?.generation === generation) this.readyWait.resolve();
      return;
    }
    if (message.t === 'result') {
      const request = this.inflight;
      if (!request || request.id !== message.id) return;
      this.settle(request, message.transcript);
      return;
    }
    if (message.t === 'error') {
      if (message.id === undefined) {
        // Fallo de `init`: el worker no sirve para nada, se tira.
        this.failReadyWait(generation, new VoiceWorkerError(message.message, message.code));
        void this.killChild(generation);
        return;
      }
      const request = this.inflight;
      if (!request || request.id !== message.id) return;
      // Un worker que se declara roto no atiende nada más: se tira antes de que
      // la cola avance, y la siguiente petición arranca uno nuevo.
      if (message.fatal) void this.killChild(generation);
      this.settleError(request, this.errorForCode(message.code, message.message));
    }
  }

  private errorForCode(code: WorkerErrorCode, message: string): Error {
    if (code === 'runtime_unavailable') return new VoiceRuntimeUnavailableError(message);
    return new VoiceWorkerError(message, code);
  }

  /** El hijo ya no está: lo pendiente se rechaza y el siguiente relanzará. */
  private onExit(generation: number): void {
    if (!this.isCurrent(generation)) return; // cierre tardío de un hijo reemplazado
    const child = this.child;
    this.child = undefined;
    this.childGeneration = undefined;
    this.generation++;
    this.readyInfo = undefined;
    const tail = child?.stderrTail?.().trim();
    const suffix = tail ? `\n--- stderr del worker ---\n${tail}` : '';
    this.failReadyWait(generation, new VoiceWorkerCrashedError('el worker de voz se ha caído'));
    this.rejectAll(new VoiceWorkerCrashedError(`el worker de voz se ha caído${suffix}`));
  }

  /** Suelta al que espera el `ready` (si hay alguno de esa generación). */
  private failReadyWait(generation: number, err: unknown): void {
    const wait = this.readyWait;
    if (!wait || wait.generation !== generation) return;
    this.readyWait = undefined;
    wait.reject(err);
  }

  private settle(request: PendingRequest, transcript: VoiceTranscript): void {
    this.lastTranscript = transcript;
    this.finish(request);
    request.resolve(transcript);
    void this.pump();
  }

  private settleError(request: PendingRequest, err: unknown): void {
    this.finish(request);
    request.reject(err);
    void this.pump();
  }

  private finish(request: PendingRequest): void {
    if (request.timer) clearTimeout(request.timer);
    request.timer = undefined;
    if (this.inflight === request) this.inflight = undefined;
    this.armIdle();
  }

  private rejectAll(err: unknown): void {
    const pending = [...this.queue];
    this.queue = [];
    if (this.inflight) pending.unshift(this.inflight);
    this.inflight = undefined;
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.timer = undefined;
      request.reject(err);
    }
  }

  // -------------------------------------------------------------------------
  // Temporizadores
  // -------------------------------------------------------------------------

  private armIdle(): void {
    this.clearIdle();
    if (this.idleMs <= 0 || this.closed || !this.child) return;
    // Con trabajo pendiente no se cuenta la inactividad.
    if (this.inflight || this.queue.length > 0) return;
    this.idleTimer = setTimeout(() => this.unload(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private onTimeout(request: PendingRequest): void {
    if (this.inflight !== request) return;
    this.inflight = undefined;
    request.timer = undefined;
    request.reject(
      new VoiceTimeoutError(
        `la transcripción no terminó en ${Math.round(this.requestTimeoutMs / 1000)} s; ` +
          'se ha cerrado el worker de voz',
      ),
    );
    // Muere también si el plazo venció arrancando: un hijo que no llega al
    // `ready` no sirve, y las que esperaban relanzan uno nuevo.
    this.unload();
    void this.pump();
  }

  /** Mata el worker (si estaba). La siguiente petición lo relanza. */
  private unload(): void {
    this.clearIdle();
    const child = this.child;
    this.child = undefined;
    this.childGeneration = undefined;
    this.generation++;
    this.readyInfo = undefined;
    if (this.readyWait) {
      const wait = this.readyWait;
      this.readyWait = undefined;
      wait.reject(new VoiceWorkerCrashedError('el worker de voz se ha cerrado'));
    }
    this.killProcess(child);
  }

  private async killChild(generation: number): Promise<void> {
    // Solo el hijo de esta generación: el que arrancó mientras tanto no se toca.
    if (!this.isCurrent(generation)) return;
    const child = this.child;
    this.child = undefined;
    this.childGeneration = undefined;
    this.generation++;
    this.readyInfo = undefined;
    if (this.readyWait?.generation === generation) this.readyWait = undefined;
    this.killProcess(child);
  }

  private killProcess(child: VoiceWorkerChild | undefined): void {
    try {
      child?.kill('SIGKILL');
    } catch {
      // Un hijo que ya no está no es un problema.
    }
  }
}

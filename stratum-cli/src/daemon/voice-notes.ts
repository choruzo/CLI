/**
 * M25 fase 3 — una nota de voz de Telegram, desde los bytes hasta el texto
 * (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Une las piezas que ya existen: decodificar el Opus en WASM (`voice/opus.ts`),
 * bajarlo a 16 kHz (`voice/resample.ts`), transcribir en local con el worker
 * (`voice/client.ts`) y descargar el modelo la primera vez (`voice/model-store.ts`).
 *
 * Cuatro reglas que no se rompen:
 * - **el audio solo vive en memoria**: los bytes entran, se decodifican y se
 *   sueltan; nunca van a disco, a un log ni a la traza;
 * - la admisión es **síncrona**: una nota que no cabe en la cola se rechaza en
 *   el acto, **sin descargar nada**; y los bytes de Telegram (`getBytes`) solo
 *   se piden cuando a esa nota le toca, así que una nota nunca frena a las
 *   demás ni el bucle de mensajes del canal;
 * - se atiende **una nota a la vez**, por orden de llegada. La descarga del
 *   modelo la hace la nota que está en curso (la primera que la necesita); las
 *   demás esperan detrás, porque ya están en la cola;
 * - no poder transcribir es un fallo **auxiliar**: lanza, y quien llama decide
 *   qué contestar en el chat. Aquí no se abre ni se toca ningún turno.
 */

import type { VoiceConfig } from '../config/schema.js';
import {
  VoiceQueueFullError,
  VoiceRuntimeUnavailableError,
  VoiceTimeoutError,
  VoiceWorkerClient,
  VoiceWorkerCrashedError,
  VoiceWorkerError,
} from '../voice/client.js';
import { decodeOggOpus, type DecodeOggOpus } from '../voice/opus.js';
import { resampleTo16k } from '../voice/resample.js';
import {
  downloadVoiceModel,
  voiceModelDir,
  voiceModelStatus,
  type VoiceModelState,
} from '../voice/model-store.js';
import { VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE, VoiceTooLongError } from '../voice/transcribe.js';
import type { VoiceTranscript, VoiceTranscriptDevice } from '../voice/worker-protocol.js';

/** La voz está apagada en la config (`voice.enabled: false`, que es el defecto). */
export class VoiceNotesDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceNotesDisabledError';
  }
}

/** El modelo no está y no se pudo descargar: la nota no se transcribe. */
export class VoiceModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelUnavailableError';
  }
}

/**
 * Las notas de voz están cerradas (`close()`): el daemon se apaga. La nota no se
 * transcribe y el canal no contesta nada.
 */
export class VoiceNotesClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceNotesClosedError';
  }
}

/** Lo mínimo que se le pide al cliente del worker (los tests pasan uno falso). */
export interface VoiceClientPort {
  transcribe(pcm16k: Float32Array): Promise<VoiceTranscript>;
  close(): void;
}

/** Fases de la descarga del modelo que se cuentan al chat de la nota. */
export type VoiceModelPhase = 'start' | 'progress' | 'done' | 'failed';

/** Lo que acompaña a una fase de la descarga. Sin rutas ni detalles internos. */
export interface VoiceModelHookInfo {
  /** Porcentaje ya emitido (25, 50 o 75); solo en `progress`. */
  percent?: number;
}

export interface VoiceNoteHooks {
  /** La primera vez: descarga del modelo (~4 GB), con su progreso. */
  onModelDownload?(phase: VoiceModelPhase, info: VoiceModelHookInfo): void;
}

/** Lo que sale de una nota, ya sin el audio. */
export interface VoiceNoteResult {
  text: string;
  /** Duración del audio **decodificado** (no la que declara Telegram). */
  durationSec: number;
  /** Algún trozo llegó al tope de tokens: el texto puede estar cortado. */
  capped: boolean;
  device: VoiceTranscriptDevice;
  /** Por qué no se usó el dispositivo pedido, si hubo que cambiar. */
  warning?: string;
  /** Milisegundos de punta a punta de la nota (descarga del modelo aparte). */
  ms: number;
  /** Milisegundos de decodificar el Opus y bajarlo a 16 kHz. */
  decodeMs: number;
  /** Trozos en que se partió el audio. */
  chunks: number;
  /** Trozos que no llegaron al modelo por estar casi mudos. */
  skipped: number;
}

/** Lo que el canal necesita de las notas de voz. */
export interface VoiceNotesPort {
  /**
   * Transcribe una nota. Los bytes se piden con `getBytes` **cuando a la nota le
   * toca** en la cola, no antes.
   *
   * Admisión síncrona: si la cola está llena, la voz está apagada o esto ya se
   * cerró, la promesa se rechaza ya y `getBytes` no llega a llamarse.
   */
  transcribe(getBytes: () => Promise<Uint8Array>, hooks?: VoiceNoteHooks): Promise<VoiceNoteResult>;
}

/** Un progreso de la descarga, tal como lo da `downloadVoiceModel`. */
interface DownloadProgress {
  bytes: number;
  total: number;
}

/** Firma de la descarga, para poder sustituirla en los tests. */
export type VoiceModelDownload = (opts: {
  dir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}) => Promise<void>;

export interface VoiceNotesOptions {
  /**
   * La sección `voice` de la config **global**. Se relee al empezar **cada**
   * nota: si alguien apaga la voz o cambia el dispositivo, la siguiente nota ya
   * lo sabe (la que está en curso termina con la config con la que empezó).
   */
  config: () => VoiceConfig;
  /** Directorio del modelo. Por defecto, `~/.stratum/models/canary-1b-v2/`. */
  dir?: string;
  /** El cliente del worker. Por defecto, un `VoiceWorkerClient` con la config. */
  client?: (cfg: VoiceConfig) => VoiceClientPort;
  /** Estado del modelo (sin `verify`: son 4 GB de sumas). */
  modelStatus?: (dir: string) => Promise<{ state: VoiceModelState }>;
  /** Descarga del modelo. Por defecto, la de verdad. */
  downloadModel?: VoiceModelDownload;
  /** Decodificador de OGG/Opus. Por defecto, el de WASM. */
  decode?: DecodeOggOpus;
  /** Reloj, para los tests. */
  now?: () => number;
}

/**
 * Por qué falló la última nota, solo si dice algo de la salud de la voz: el
 * modelo, el runtime o el worker. Una nota demasiado larga o un OGG roto son
 * de esa nota y no cuentan.
 */
export type VoiceFailureKind = 'model' | 'runtime' | 'load' | 'crashed' | 'timeout' | 'failed';

/** Lo que `doctor.run` sabe de las notas de este daemon. Solo en memoria. */
export interface VoiceNotesHealth {
  /** La última nota transcrita: en qué dispositivo y cuándo. */
  lastNote: { device: VoiceTranscriptDevice; at: number } | null;
  /** El último fallo de salud (ver {@link VoiceFailureKind}) y cuándo. */
  lastFailure: { kind: VoiceFailureKind; at: number } | null;
}

/** El tipo de fallo de salud de un error, o `null` si es de la propia nota. */
export function voiceFailureKind(err: unknown): VoiceFailureKind | null {
  if (err instanceof VoiceModelUnavailableError) return 'model';
  if (err instanceof VoiceRuntimeUnavailableError) return 'runtime';
  if (err instanceof VoiceWorkerCrashedError) return 'crashed';
  if (err instanceof VoiceTimeoutError) return 'timeout';
  if (err instanceof VoiceWorkerError) {
    if (err.code === 'too_long') return null;
    return err.code === 'load_failed' || err.code === 'model_not_ready' ? 'load' : 'failed';
  }
  return null;
}

/** Notas que pueden **esperar** detrás de la que está en curso. La siguiente, no. */
export const VOICE_MAX_WAITING = 3;

/** Los porcentajes que se cuentan del progreso: ni uno más. */
const PROGRESS_STEPS = [25, 50, 75] as const;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Una nota admitida en la cola. */
interface QueuedNote {
  getBytes: () => Promise<Uint8Array>;
  hooks?: VoiceNoteHooks;
  resolve: (result: VoiceNoteResult) => void;
  reject: (err: unknown) => void;
}

export class VoiceNotes {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly decode: DecodeOggOpus;
  private client?: VoiceClientPort;
  /** Con qué config se creó el cliente: si cambia, se tira y se hace otro. */
  private clientKey?: string;
  /** La descarga del modelo en curso (para abortarla al cerrar). */
  private download?: AbortController;
  /** La nota que se está transcribiendo ahora mismo. */
  private active?: QueuedNote;
  /** Las que esperan turno, en orden de llegada. */
  private readonly waiting: QueuedNote[] = [];
  private closed = false;
  private lastNote: VoiceNotesHealth['lastNote'] = null;
  private lastFailure: VoiceNotesHealth['lastFailure'] = null;

  constructor(private readonly opts: VoiceNotesOptions) {
    this.dir = opts.dir ?? voiceModelDir();
    this.now = opts.now ?? (() => Date.now());
    this.decode = opts.decode ?? decodeOggOpus;
  }

  /** Hay una nota activa, en espera o descargando el modelo (el daemon no se apaga por inactividad). */
  get busy(): boolean {
    return this.active !== undefined || this.waiting.length > 0;
  }

  /** Para `doctor.run`: la última nota y el último fallo de salud, sin texto ni audio. */
  health(): VoiceNotesHealth {
    return { lastNote: this.lastNote, lastFailure: this.lastFailure };
  }

  /**
   * Encola una nota de voz. La admisión es **síncrona**: todo lo que la rechaza
   * (cerrado, voz apagada, cola llena) se decide antes de cualquier espera, así
   * que `getBytes` no se llama ni una vez.
   *
   * @throws VoiceNotesClosedError si ya se cerró.
   * @throws VoiceNotesDisabledError si `voice.enabled` está apagado.
   * @throws VoiceQueueFullError si ya hay {@link VOICE_MAX_WAITING} notas esperando.
   */
  transcribe(
    getBytes: () => Promise<Uint8Array>,
    hooks?: VoiceNoteHooks,
  ): Promise<VoiceNoteResult> {
    const rejection = this.admit();
    if (rejection) return Promise.reject(rejection);
    return new Promise<VoiceNoteResult>((resolve, reject) => {
      this.waiting.push({ getBytes, ...(hooks ? { hooks } : {}), resolve, reject });
      void this.pump();
    });
  }

  /**
   * Cierra el worker y aborta la descarga en curso (el apagado del daemon).
   *
   * Las que esperan se rechazan con {@link VoiceNotesClosedError}; la que está
   * en curso se entera en su siguiente comprobación (y si estaba en el worker,
   * al cerrar el cliente). Nada de esto crea ya un worker nuevo.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.download?.abort();
    this.download = undefined;
    this.client?.close();
    this.client = undefined;
    this.clientKey = undefined;
    const rejected = new VoiceNotesClosedError('las notas de voz se han cerrado');
    const active = this.active;
    this.active = undefined;
    active?.reject(rejected);
    for (const note of this.waiting.splice(0)) note.reject(rejected);
  }

  // -------------------------------------------------------------------------

  /** Lo que impide admitir la nota, si es que hay algo. Todo síncrono. */
  private admit(): Error | undefined {
    if (this.closed) return new VoiceNotesClosedError('las notas de voz se han cerrado');
    if (!this.opts.config().enabled) {
      return new VoiceNotesDisabledError('la voz está apagada en la configuración');
    }
    if (this.waiting.length >= VOICE_MAX_WAITING) {
      return new VoiceQueueFullError(
        `ya hay ${this.waiting.length + (this.active ? 1 : 0)} notas de voz en curso; esta se rechaza`,
      );
    }
    return undefined;
  }

  /** Nada se ejecuta después de cerrar: ni un worker nuevo ni una descarga nueva. */
  private assertOpen(): void {
    if (this.closed) throw new VoiceNotesClosedError('las notas de voz se han cerrado');
  }

  /** Atiende la siguiente, de una en una y en orden de llegada. */
  private async pump(): Promise<void> {
    if (this.active || this.closed) return;
    const note = this.waiting.shift();
    if (!note) return;
    this.active = note;
    try {
      const result = await this.run(note);
      this.lastNote = { device: result.device, at: this.now() };
      note.resolve(result);
    } catch (err) {
      const kind = voiceFailureKind(err);
      if (kind) this.lastFailure = { kind, at: this.now() };
      note.reject(err);
    } finally {
      // Si `close()` ya la había soltado, esto no pisa nada: no hay nadie más.
      if (this.active === note) this.active = undefined;
      void this.pump();
    }
  }

  /** Una nota de principio a fin. El audio se suelta aquí. */
  private async run(note: QueuedNote): Promise<VoiceNoteResult> {
    // La config se lee **al empezar** la nota: un cambio a mitad no la rompe, y
    // la siguiente ya lo ve.
    const cfg = this.opts.config();
    await this.ensureModel(note.hooks);
    this.assertOpen();
    const startedAt = this.now();
    const audio = await note.getBytes();
    this.assertOpen();
    // Los bytes se sueltan al salir de aquí: nadie más los guarda.
    const decoded = await this.decode(audio, { maxSeconds: VOICE_MAX_SECONDS });
    this.assertOpen();
    const pcm16k = resampleTo16k(decoded.pcm, decoded.sampleRate);
    const decodeMs = this.now() - startedAt;
    const durationSec = pcm16k.length / VOICE_SAMPLE_RATE;
    // El decodificador ya corta en el tope; esto cubre a los que no lo hacen.
    if (pcm16k.length > VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE) {
      throw new VoiceTooLongError(
        `el audio dura ${durationSec.toFixed(1)} s y el máximo son ${VOICE_MAX_SECONDS} s`,
        durationSec,
      );
    }
    const client = this.clientFor(cfg);
    const transcript = await client.transcribe(pcm16k);
    this.assertOpen();
    const chunks = transcript.chunks.length;
    const skipped = transcript.chunks.filter((c) => c.skipped).length;
    return {
      text: transcript.text,
      durationSec,
      capped: transcript.capped,
      device: transcript.device,
      ...(transcript.warning !== undefined ? { warning: transcript.warning } : {}),
      ms: this.now() - startedAt,
      decodeMs,
      chunks,
      skipped,
    };
  }

  /**
   * El modelo, descargándolo si hace falta. La descarga la hace la nota que está
   * en curso; las demás esperan detrás en la cola y, cuando les toca, la
   * encuentran hecha.
   */
  private async ensureModel(hooks: VoiceNoteHooks | undefined): Promise<void> {
    this.assertOpen();
    const status = await (this.opts.modelStatus ?? defaultModelStatus)(this.dir);
    this.assertOpen();
    if (status.state === 'ready') return;
    const abort = new AbortController();
    this.download = abort;
    try {
      await this.runDownload(hooks, abort);
    } finally {
      if (this.download === abort) this.download = undefined;
    }
    this.assertOpen();
  }

  private async runDownload(
    hooks: VoiceNoteHooks | undefined,
    abort: AbortController,
  ): Promise<void> {
    const downloadModel = this.opts.downloadModel ?? downloadVoiceModel;
    hooks?.onModelDownload?.('start', {});
    let step = 0;
    try {
      await downloadModel({
        dir: this.dir,
        signal: abort.signal,
        // El progreso va como mucho a 25, 50 y 75 %: un mensaje por hito,
        // nunca uno por cada 150 ms de descarga.
        onProgress: (progress) => {
          if (progress.total <= 0) return;
          const percent = (progress.bytes / progress.total) * 100;
          while (step < PROGRESS_STEPS.length && percent >= PROGRESS_STEPS[step]!) {
            hooks?.onModelDownload?.('progress', { percent: PROGRESS_STEPS[step]! });
            step++;
          }
        },
      });
    } catch (err) {
      // Abortada por `close()`: no es un fallo de la descarga y no se cuenta en
      // el chat (el daemon se está apagando).
      this.assertOpen();
      hooks?.onModelDownload?.('failed', {});
      throw new VoiceModelUnavailableError(
        `no se pudo descargar el modelo de voz: ${reasonOf(err)}`,
      );
    }
    this.assertOpen();
    hooks?.onModelDownload?.('done', {});
  }

  /**
   * El cliente del worker. Se rehace **entre notas**, nunca con una en vuelo: si
   * la config cambió mientras la anterior trabajaba, se aplica al empezar esta.
   */
  private clientFor(cfg: VoiceConfig): VoiceClientPort {
    this.assertOpen();
    const key = `${cfg.device}|${cfg.language}|${cfg.idleUnloadMinutes}`;
    if (this.client && this.clientKey === key) return this.client;
    // Cambiar el dispositivo o el idioma exige un worker nuevo: los suyos son
    // del arranque y no se pueden reconfigurar en caliente.
    this.client?.close();
    this.client = this.opts.client
      ? this.opts.client(cfg)
      : new VoiceWorkerClient({
          dir: this.dir,
          device: cfg.device,
          language: cfg.language,
          idleUnloadMinutes: cfg.idleUnloadMinutes,
        });
    this.clientKey = key;
    return this.client;
  }
}

function defaultModelStatus(dir: string): Promise<{ state: VoiceModelState }> {
  return voiceModelStatus({ dir });
}

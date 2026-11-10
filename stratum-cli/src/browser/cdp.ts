/**
 * Cliente mínimo del Chrome DevTools Protocol sobre `--remote-debugging-pipe`:
 * el navegador lee órdenes del fd 3 y escribe respuestas y eventos en el fd 4,
 * mensajes JSON separados por `\0`. **No se abre ningún puerto** (el daemon no
 * escucha en TCP, y un puerto de depuración sería un control remoto del
 * navegador para cualquier proceso de la máquina).
 *
 * Aquí no se decide nada de política: eso es de `manager.ts`. Este módulo
 * lanza el proceso con argumentos fijos (nada del modelo entra en la línea de
 * órdenes), correla peticiones y respuestas con un plazo por orden, reparte los
 * eventos y acota lo que lee: un mensaje de más de `maxMessageBytes` cierra la
 * conexión, y el navegador queda muerto para la sesión (como el JSON-RPC de
 * `src/lsp/`).
 */
import { rmSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import {
  killProcessTreeSync,
  signalProcessTree,
  sweepProcessDescendants,
} from '../tools/exec/backends/local.js';

export const CDP_LIMITS = {
  /** Bytes de un mensaje entrante (una captura PNG grande cabe de sobra). */
  maxMessageBytes: 16 * 1024 * 1024,
  /** Plazo por orden. */
  commandTimeoutMs: 30_000,
} as const;

const IS_WINDOWS = process.platform === 'win32';

/** El navegador contestó con un error de protocolo. */
export class CdpError extends Error {
  override readonly name = 'CdpError';
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${method}: ${message}`);
  }
}

/** La conexión se cerró (el navegador salió, o se pasó un tope): no vuelve. */
export class CdpClosedError extends Error {
  override readonly name = 'CdpClosedError';
}

/** Una orden no tuvo respuesta en su plazo. */
export class CdpTimeoutError extends Error {
  override readonly name = 'CdpTimeoutError';
}

export interface CdpSendOptions {
  /** Sesión de un target (`Target.attachToTarget` con `flatten`). */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CdpEventHandler = (
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => void;

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface CdpConnectionOptions {
  maxMessageBytes?: number;
  timeoutMs?: number;
  /** Una sola vez, con el motivo del cierre. */
  onClose?: (reason: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private closedReason: string | null = null;
  private readonly maxMessageBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly options: CdpConnectionOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? CDP_LIMITS.maxMessageBytes;
    this.timeoutMs = options.timeoutMs ?? CDP_LIMITS.commandTimeoutMs;
    readable.on('data', (chunk: Buffer | string) => this.onData(chunk));
    readable.on('end', () => this.close('the browser closed the pipe'));
    readable.on('error', (err: Error) => this.close(`pipe error: ${err.message}`));
    writable.on('error', (err: Error) => this.close(`pipe error: ${err.message}`));
  }

  /** Motivo del cierre, o `null` si sigue abierta. */
  get closed(): string | null {
    return this.closedReason;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    opts: CdpSendOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) {
      return Promise.reject(
        new CdpClosedError(`The browser connection is closed: ${this.closedReason}`),
      );
    }
    if (opts.signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.settle(id)?.reject(abortError());
      };
      const timer = setTimeout(() => {
        this.settle(id)?.reject(
          new CdpTimeoutError(`${method} did not answer within ${Math.round(timeoutMs / 1000)} s`),
        );
      }, timeoutMs);
      timer.unref?.();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      });
      const message = {
        id,
        method,
        params,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      };
      try {
        this.writable.write(`${JSON.stringify(message)}\0`);
      } catch (err) {
        this.close(`could not write to the browser: ${(err as Error).message}`);
      }
    });
  }

  /** Escucha un evento; devuelve la forma de dejar de escucharlo. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Cierra la conexión y rechaza lo pendiente. Idempotente. */
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const id of [...this.pending.keys()]) {
      this.settle(id)?.reject(new CdpClosedError(`The browser connection closed: ${reason}`));
    }
    this.chunks = [];
    this.buffered = 0;
    try {
      this.writable.end();
    } catch {
      /* ya cerrado */
    }
    this.readable.destroy();
    this.options.onClose?.(reason);
  }

  /** Saca la petición del mapa y limpia su temporizador. */
  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    return entry;
  }

  private onData(chunk: Buffer | string): void {
    if (this.closedReason !== null) return;
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const end = data.indexOf(0);
      if (end === -1) {
        this.buffered += data.length;
        if (this.buffered > this.maxMessageBytes) {
          this.close(`a browser message exceeded ${this.maxMessageBytes} bytes`);
          return;
        }
        if (data.length > 0) this.chunks.push(data);
        return;
      }
      const head = data.subarray(0, end);
      if (this.buffered + head.length > this.maxMessageBytes) {
        this.close(`a browser message exceeded ${this.maxMessageBytes} bytes`);
        return;
      }
      const message = Buffer.concat([...this.chunks, head], this.buffered + head.length);
      this.chunks = [];
      this.buffered = 0;
      this.dispatch(message.toString('utf8'));
      if (this.closedReason !== null) return;
      data = data.subarray(end + 1);
    }
  }

  private dispatch(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.close('the browser sent a message that is not JSON');
      return;
    }
    if (!isRecord(msg)) return;
    if (typeof msg.id === 'number') {
      const entry = this.settle(msg.id);
      if (!entry) return;
      if (isRecord(msg.error)) {
        const message = typeof msg.error.message === 'string' ? msg.error.message : 'error';
        const code = typeof msg.error.code === 'number' ? msg.error.code : undefined;
        entry.reject(new CdpError(entry.method, message, code));
      } else {
        entry.resolve(isRecord(msg.result) ? msg.result : {});
      }
      return;
    }
    if (typeof msg.method !== 'string') return;
    const handlers = this.listeners.get(msg.method);
    if (!handlers) return;
    const params = isRecord(msg.params) ? msg.params : {};
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId);
      } catch {
        /* un oyente roto no tumba la conexión */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Proceso del navegador
// ---------------------------------------------------------------------------

/**
 * Argumentos **fijos**: headless, pipe de depuración, perfil efímero propio y
 * nada que sincronice, descargue componentes o abra otra cosa que `about:blank`.
 */
export function browserArgs(userDataDir: string): string[] {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,800',
    'about:blank',
  ];
}

export interface LaunchOptions {
  executable: string;
  userDataDir: string;
  /**
   * Solo para tests: argumentos delante de los fijos (el script de un navegador
   * falso, lanzado con `node`). Ningún llamador de producción lo pasa.
   */
  argsPrefix?: readonly string[];
  maxMessageBytes?: number;
  timeoutMs?: number;
  onClose?: (reason: string) => void;
}

export interface LaunchedBrowser {
  readonly connection: CdpConnection;
  readonly pid: number | undefined;
  /** Resuelve cuando el proceso termina (nunca rechaza). */
  readonly exited: Promise<void>;
  /** Mata el árbol de procesos y espera a que salga. Nunca rechaza. */
  kill(): Promise<void>;
  /** Lo mismo, síncrono: para el `exit` del proceso. */
  killSync(): void;
  /** Lo último del stderr del navegador (acotado), para el log. */
  stderrTail(): string;
}

/** Navegadores vivos del proceso: el `exit` los mata aunque nadie llame a `dispose`. */
const live = new Map<LaunchedBrowser, string>();
let exitHookInstalled = false;

function onProcessExit(): void {
  for (const [browser, dir] of live) {
    try {
      browser.killSync();
    } catch {
      /* en el `exit` no hay a quién contárselo */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* mejor esfuerzo */
    }
  }
}

/** Solo para tests. */
export function liveBrowsers(): number {
  return live.size;
}

const STDERR_TAIL = 4096;

export function launchBrowser(options: LaunchOptions): LaunchedBrowser {
  const spawnedAt = Date.now();
  const child = execa(
    options.executable,
    [...(options.argsPrefix ?? []), ...browserArgs(options.userDataDir)],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      buffer: false,
      reject: false,
      windowsHide: true,
      cleanup: true,
      // En POSIX, grupo propio: el árbol entero (renderers, GPU) muere de una vez.
      ...(!IS_WINDOWS && { detached: true }),
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
  });
  // El evento `exit` del proceso, no la promesa de execa: esa espera además a
  // que se cierren todos los pipes, y el de órdenes lo tenemos abierto nosotros.
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  // Un fallo al lanzar llega también como rechazo de la promesa: aquí solo se observa.
  void child.then(
    () => undefined,
    () => undefined,
  );

  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
    child.kill('SIGKILL');
    throw new Error('the browser pipes could not be opened');
  }
  const connection = new CdpConnection(fromBrowser, toBrowser, {
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onClose ? { onClose: options.onClose } : {}),
  });
  void exited.then(() => connection.close('the browser exited'));

  const pid = child.pid;
  const browser: LaunchedBrowser = {
    connection,
    pid,
    exited,
    async kill() {
      await signalProcessTree(pid, 'SIGKILL', () => child.kill('SIGKILL'));
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref?.())]);
      // Windows: si el proceso principal ya había salido, `taskkill /T` no ve a
      // sus hijos; el barrido los encuentra por su padre (aunque esté muerto).
      if (IS_WINDOWS && pid !== undefined) await sweepProcessDescendants(pid, spawnedAt);
      live.delete(browser);
    },
    killSync() {
      if (pid !== undefined) killProcessTreeSync(pid, spawnedAt);
      else child.kill('SIGKILL');
      live.delete(browser);
    },
    stderrTail: () => stderr,
  };
  live.set(browser, options.userDataDir);
  void exited.then(() => live.delete(browser));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', onProcessExit);
  }
  return browser;
}

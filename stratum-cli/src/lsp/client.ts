import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa, type ResultPromise } from 'execa';
import { getLogger } from '../logging/index.js';
import type { DiagnosticsReport, LspDiagnostic } from './format.js';
import { JsonRpcConnection, abortError } from './jsonrpc.js';

/**
 * Un language server, arrancado con `execa` y hablado por stdio (encargo
 * UX-2b). Aquí no se decide *cuándo* arrancar ni se sobrevive a los fallos: eso
 * es del `LspManager`. Este objeto es de un solo servidor y de un solo uso.
 *
 * Nada de `shell: true`: en Windows `execa` resuelve el `.cmd` del preset por sí
 * solo, y un shell de por medio rompería las rutas y el framing.
 */

const log = getLogger('lsp');

/** Servidor de una sola sesión: no reutiliza clientes entre procesos. */
export interface LspClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  /** Raíz del proyecto: `rootUri`/`workspaceFolders` del `initialize`. */
  cwd: string;
  /** Espera máxima del `initialize`. */
  startupTimeoutMs?: number;
  /** Tope del stderr que se guarda para el log (el resto se descarta). */
  stderrLimitBytes?: number;
  /** Cuando el proceso muere solo (no por `shutdown`), el manager lo desactiva. */
  onExit?: (info: { code?: number | null; signal?: string | null; error?: Error }) => void;
}

interface DocumentState {
  version: number;
  languageId: string;
}

interface StoredReport {
  report: DiagnosticsReport;
  /** Contador monótono de publicaciones: para servers que no mandan `version`. */
  at: number;
}

interface Waiter {
  accepts: (entry: StoredReport) => boolean;
  resolve: (report: DiagnosticsReport | null) => void;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.rs': 'rust',
};

/** `languageId` de LSP a partir de la extensión; `plaintext` si no se conoce. */
export function languageIdFor(absPath: string): string {
  const match = /\.[^.\\/]+$/.exec(absPath);
  if (match === null) return 'plaintext';
  return LANGUAGE_BY_EXTENSION[match[0].toLowerCase()] ?? match[0].slice(1).toLowerCase();
}

/** Primera línea de un mensaje de error: los de `execa` traen el comando detrás. */
function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

/** ¿Cancelación (del turno o del cierre) y no un servidor roto? */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Forma mínima de un `Diagnostic` de LSP. Lo que no la cumple se descarta al
 * recibirlo: el modelo solo verá diagnósticos que se pueden pintar.
 */
function isDiagnostic(value: unknown): value is LspDiagnostic {
  if (value === null || typeof value !== 'object') return false;
  const diagnostic = value as {
    message?: unknown;
    range?: { start?: { line?: unknown; character?: unknown } };
  };
  if (typeof diagnostic.message !== 'string') return false;
  const start = diagnostic.range?.start;
  return (
    start !== undefined &&
    typeof start.line === 'number' &&
    typeof start.character === 'number' &&
    Number.isFinite(start.line) &&
    Number.isFinite(start.character)
  );
}

export class LspClient {
  readonly name: string;
  private readonly options: LspClientOptions;
  private child?: ResultPromise;
  private connection?: JsonRpcConnection;
  private stderrTail = '';
  private readonly documents = new Map<string, DocumentState>();
  private readonly reports = new Map<string, StoredReport>();
  private readonly syncedAt = new Map<string, number>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private publishes = 0;
  private stopping = false;
  private disposed = false;

  constructor(options: LspClientOptions) {
    this.name = options.name;
    this.options = options;
  }

  /** `pid` del proceso, para tests y diagnóstico. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Lo último que escribió en stderr (acotado): va al log si algo va mal. */
  get stderr(): string {
    return this.stderrTail;
  }

  /**
   * Arranca el proceso, hace `initialize` y manda `initialized`. `signal` corta
   * la espera del `initialize` (cierre del manager o del turno): el proceso se
   * crea y se queda a medias si nadie lo apaga, así que quien aborta tiene que
   * llamar a `shutdown()` — el manager lo hace.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw abortError('lsp start aborted');
    const child = execa(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? {},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cleanup: true,
      reject: false,
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = '';

    child.stderr?.on('data', (chunk: Buffer | string) => this.appendStderr(chunk));
    // Un fallo de arranque llega como rechazo: aquí solo se observa, no se lanza
    // (el manager decide qué hacer y nunca propaga).
    void child.then(
      (result) => this.afterExit({ code: result.exitCode ?? null, signal: result.signal ?? null }),
      (error: Error) => this.afterExit({ error }),
    );

    this.connection = new JsonRpcConnection({
      readable: child.stdout!,
      writable: child.stdin!,
      onClose: (reason) => this.onTransportClosed(reason),
    });
    this.connection.onNotification('textDocument/publishDiagnostics', (params) =>
      this.onPublishDiagnostics(params),
    );

    const rootUri = pathToFileURL(this.options.cwd).href;
    if (child.stdout === null || child.stdin === null) {
      throw new Error(`"${this.options.command}" did not expose stdin/stdout`);
    }
    const initialize = this.connection.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'stratum' },
        rootUri,
        rootPath: this.options.cwd,
        workspaceFolders: [{ uri: rootUri, name: basename(this.options.cwd) }],
        capabilities: {
          textDocument: { publishDiagnostics: { relatedInformation: false } },
          workspace: { workspaceFolders: false, configuration: true },
          window: { workDoneProgress: false },
        },
        ...(this.options.initializationOptions === undefined
          ? {}
          : { initializationOptions: this.options.initializationOptions }),
      },
      { timeoutMs: this.options.startupTimeoutMs ?? 15000, signal },
    );
    // Si el proceso no llega ni a existir, no se espera el timeout entero: el
    // rechazo del hijo da el error real (ENOENT) enseguida.
    initialize.catch(() => undefined);
    const exitedEarly = new Promise<never>((_, reject) => {
      void child.then(
        (result) =>
          reject(
            new Error(`server exited during initialize (code ${result.exitCode ?? 'signal'})`),
          ),
        (error: Error) => reject(new Error(`server failed to start: ${firstLine(error.message)}`)),
      );
    });
    exitedEarly.catch(() => undefined);
    await Promise.race([initialize, exitedEarly]);
    this.connection.notify('initialized', {});
  }

  /**
   * Mantiene el servidor al día del fichero: `didOpen` la primera vez,
   * `didChange` (texto completo) las siguientes. Devuelve la versión enviada,
   * que es lo que hay que pasarle a `waitForDiagnostics`.
   */
  syncFile(absPath: string, text: string): number {
    const uri = pathToFileURL(absPath).href;
    // Lo publicado antes de esta edición ya no describe el fichero: fuera, para
    // que `waitForDiagnostics` no pueda devolver un informe viejo.
    this.reports.delete(uri);
    const current = this.documents.get(uri);
    if (current === undefined) {
      const state: DocumentState = { version: 1, languageId: languageIdFor(absPath) };
      this.documents.set(uri, state);
      this.syncedAt.set(uri, this.publishes);
      this.connection?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: state.languageId, version: state.version, text },
      });
      return state.version;
    }
    // Riesgo residual: un servidor con `diagnosticProvider` (pull) no publica
    // nada por su cuenta; aquí solo se escucha `publishDiagnostics` (push), así
    // que en ese modo `waitForDiagnostics` vencerá y devolverá `null`. No se
    // implementa `textDocument/diagnostic` en esta versión.
    current.version += 1;
    this.syncedAt.set(uri, this.publishes);
    this.connection?.notify('textDocument/didChange', {
      textDocument: { uri, version: current.version },
      contentChanges: [{ text }],
    });
    return current.version;
  }

  /**
   * Diagnósticos de la primera publicación **posterior** al cambio, o de una
   * con `version >= sinseVersion` (los servers que la mandan), o `null` si el
   * servidor no contesta antes de `timeoutMs`.
   */
  async waitForDiagnostics(
    absPath: string,
    sinceVersion: number,
    timeoutMs: number,
  ): Promise<DiagnosticsReport | null> {
    const uri = pathToFileURL(absPath).href;
    const accepts = (entry: StoredReport): boolean =>
      entry.report.version !== undefined
        ? entry.report.version >= sinceVersion
        : entry.at > (this.syncedAt.get(uri) ?? -1);

    const stored = this.reports.get(uri);
    if (stored !== undefined && accepts(stored)) return stored.report;
    if (this.disposed || this.connection === undefined) return null;

    return new Promise<DiagnosticsReport | null>((resolve) => {
      const waiter: Waiter = { accepts, resolve: () => undefined };
      const done = (report: DiagnosticsReport | null) => {
        clearTimeout(timer);
        const set = this.waiters.get(uri);
        set?.delete(waiter);
        if (set !== undefined && set.size === 0) this.waiters.delete(uri);
        resolve(report);
      };
      waiter.resolve = done;
      const timer = setTimeout(() => done(null), Math.max(1, timeoutMs));
      timer.unref?.();
      const set = this.waiters.get(uri) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(uri, set);
    });
  }

  /**
   * `shutdown` + `exit` y, si el proceso no sale en `graceMs`, se mata. Nunca
   * rechaza ni se queda colgado: es el último paso del turno.
   */
  async shutdown(graceMs = 2000): Promise<void> {
    if (this.disposed) return;
    this.stopping = true;
    this.disposed = true;
    try {
      await this.connection?.request('shutdown', null, { timeoutMs: Math.min(graceMs, 1000) });
    } catch {
      /* el servidor ya no está: da igual */
    }
    try {
      this.connection?.notify('exit');
    } catch {
      /* idem */
    }
    this.connection?.close();
    this.releaseWaiters(null);

    const child = this.child;
    if (child === undefined) return;
    const exited = await this.waitForExit(child, graceMs);
    if (!exited) {
      log.warn('lsp server did not exit, killing it', { server: this.name, pid: child.pid });
      try {
        child.kill();
      } catch {
        /* ya murió */
      }
      await this.waitForExit(child, 1000);
    }
  }

  private waitForExit(child: ResultPromise, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      void child.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        },
      );
    });
  }

  /**
   * El transporte se cerró sin que lo pidiéramos (framing roto, cuerpo
   * gigante, pipe cortado). Se mata el proceso para que el `onExit` del
   * manager lo desactive, en vez de dejar un cliente inutilizable colgado.
   */
  private onTransportClosed(reason: Error): void {
    if (this.stopping || this.disposed) return;
    log.warn('lsp transport closed; killing the server', {
      server: this.name,
      pid: this.child?.pid,
      error: reason.message,
    });
    try {
      this.child?.kill();
    } catch {
      /* ya murió */
    }
  }

  private afterExit(info: { code?: number | null; signal?: string | null; error?: Error }): void {
    // Un `shutdown` ordenado también llega aquí: solo avisa si no lo pedimos.
    if (this.stopping || this.disposed) return;
    this.options.onExit?.(info);
  }

  private appendStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const limit = this.options.stderrLimitBytes ?? 8 * 1024;
    this.stderrTail = (this.stderrTail + text).slice(-limit);
  }

  private onPublishDiagnostics(params: unknown): void {
    const payload = params as
      | { uri?: unknown; version?: unknown; diagnostics?: unknown }
      | undefined;
    const uri = typeof payload?.uri === 'string' ? payload.uri : undefined;
    if (uri === undefined) return;
    // Se filtra lo que no tiene la forma mínima que `formatDiagnostics` sabe
    // pintar: un server roto no puede reventar la salida de la tool.
    const diagnostics = Array.isArray(payload?.diagnostics)
      ? (payload.diagnostics as unknown[]).filter(isDiagnostic)
      : [];
    const version = typeof payload?.version === 'number' ? payload.version : undefined;
    const entry: StoredReport = {
      report: { server: this.name, uri, version, diagnostics },
      at: ++this.publishes,
    };
    this.reports.set(uri, entry);

    const waiters = this.waiters.get(uri);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) {
      if (!waiter.accepts(entry)) continue;
      waiter.resolve(entry.report);
    }
  }

  private releaseWaiters(report: DiagnosticsReport | null): void {
    for (const [, set] of this.waiters) {
      for (const waiter of [...set]) waiter.resolve(report);
    }
    this.waiters.clear();
  }
}

import { extname } from 'node:path';
import { getLogger } from '../logging/index.js';
import { LspClient, isAbortError } from './client.js';
import type { DiagnosticsReport } from './format.js';
import type { ResolvedLspServer } from './presets.js';

/**
 * Dueño de los language servers de una sesión (encargo UX-2b). Elige servidor
 * por extensión, lo arranca **la primera vez que hace falta** y, si el arranque
 * falla o el proceso se cae, desactiva ese servidor para el resto de la sesión
 * con un warning en el log.
 *
 * Invariante: `diagnose` no lanza nunca y no bloquea más que su timeout. Un
 * fallo de LSP no puede convertir una edición correcta en un error del agente.
 */

const log = getLogger('lsp');

/** `true` si el turno se canceló. Función aparte para no estrechar el tipo. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export interface LspManagerOptions {
  /** Servidores ya resueltos contra sus presets (`resolveLspServers`). */
  servers: ResolvedLspServer[];
  /** Raíz del proyecto: `cwd` del proceso y `rootUri` del `initialize`. */
  cwd: string;
  /** Espera máxima de diagnósticos por edición (default 3000). */
  timeoutMs?: number;
  /** Espera máxima del `initialize` (default 15000). */
  startupTimeoutMs?: number;
}

interface ServerState {
  server: ResolvedLspServer;
  client?: LspClient;
  starting?: Promise<LspClient | null>;
  disabled: boolean;
}

export class LspManager {
  private readonly options: LspManagerOptions;
  private readonly states = new Map<string, ServerState>();
  private disposed = false;
  /** Aborta los `initialize` en vuelo al cerrar la sesión. */
  private readonly shutdown = new AbortController();

  constructor(options: LspManagerOptions) {
    this.options = options;
    for (const server of options.servers) {
      this.states.set(server.name, { server, disabled: false });
    }
  }

  /** Nombres de los servidores configurados (los desactivados siguen aquí). */
  get serverNames(): string[] {
    return [...this.states.keys()];
  }

  /** Servidor que atiende la extensión del fichero, en el orden de la config. */
  serverFor(absPath: string): ResolvedLspServer | null {
    const extension = extname(absPath).toLowerCase();
    if (extension === '') return null;
    for (const state of this.states.values()) {
      if (state.server.extensions.includes(extension)) return state.server;
    }
    return null;
  }

  /**
   * Sincroniza el fichero y espera sus diagnósticos. `null` si no hay servidor
   * para esa extensión, si está desactivado, si no publica a tiempo o si algo
   * falla por el camino.
   */
  async diagnose(
    absPath: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<DiagnosticsReport | null> {
    if (this.disposed || isAborted(signal)) return null;
    const server = this.serverFor(absPath);
    if (server === null) return null;
    const state = this.states.get(server.name);
    if (state === undefined || state.disabled) return null;

    try {
      // El arranque también se cancela: un turno abortado no espera al
      // `initialize` de un servidor que acaba de despertar.
      const client = await this.withAbort(this.ensureStarted(state), signal);
      if (client === null || isAborted(signal)) return null;
      const version = client.syncFile(absPath, text);
      const pending = client.waitForDiagnostics(absPath, version, this.options.timeoutMs ?? 3000);
      return await this.withAbort(pending, signal);
    } catch (err) {
      this.disable(state, 'lsp diagnostics failed', err);
      return null;
    }
  }

  /** `shutdown` ordenado de todos los servidores arrancados. Nunca rechaza. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Un `initialize` en vuelo no puede quedarse a medias: se aborta y el
    // arranque en curso se apaga él mismo (ver `ensureStarted`).
    this.shutdown.abort();
    const starting: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      if (state.starting !== undefined) starting.push(state.starting);
    }
    await Promise.allSettled(starting);
    const clients: LspClient[] = [];
    for (const state of this.states.values()) {
      if (state.client !== undefined) clients.push(state.client);
      state.client = undefined;
    }
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  // --- internos -------------------------------------------------------------

  private async ensureStarted(state: ServerState): Promise<LspClient | null> {
    if (state.client !== undefined) return state.client;
    if (state.starting !== undefined) return state.starting;

    const starting = (async (): Promise<LspClient | null> => {
      const client = new LspClient({
        name: state.server.name,
        command: state.server.command,
        args: state.server.args,
        env: state.server.env,
        initializationOptions: state.server.initializationOptions,
        cwd: this.options.cwd,
        startupTimeoutMs: this.options.startupTimeoutMs,
        onExit: (info) => this.onServerExit(state, info),
      });
      try {
        await client.start(this.shutdown.signal);
      } catch (err) {
        // Abortar el arranque (cierre de la sesión) no es un servidor roto.
        if (isAbortError(err)) {
          void client.shutdown(500);
          return null;
        }
        this.disable(state, 'lsp server failed to start', err, client);
        return null;
      }
      // `dispose()` llegó mientras arrancábamos: el cliente no está en el mapa
      // todavía, así que sin este apagado quedaría huérfano.
      if (this.disposed) {
        void client.shutdown(500);
        return null;
      }
      state.client = client;
      return client;
    })();
    state.starting = starting;
    try {
      return await starting;
    } finally {
      state.starting = undefined;
    }
  }

  private onServerExit(state: ServerState, info: { code?: number | null; error?: Error }): void {
    if (state.disabled) return;
    this.disable(
      state,
      'lsp server exited; diagnostics disabled for this session',
      info.error,
      state.client,
      state.client === undefined ? {} : { code: info.code ?? null },
    );
  }

  private disable(
    state: ServerState,
    reason: string,
    error?: unknown,
    client?: LspClient,
    extra: Record<string, unknown> = {},
  ): void {
    if (state.disabled) return;
    state.disabled = true;
    state.client = undefined;
    // Un solo warning por servidor y sesión: la causa real está en stderr.
    log.warn(reason, {
      server: state.server.name,
      ...(error === undefined ? {} : { error: (error as Error).message }),
      ...(client?.stderr ? { stderr: client.stderr.trim() } : {}),
      ...extra,
    });
    if (client !== undefined) void client.shutdown(500);
  }

  /** Carrera contra el `AbortSignal` del turno: abortar no es un fallo. */
  private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (signal === undefined) return promise;
    if (signal.aborted) return null;
    return new Promise<T | null>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve(null);
        },
      );
    });
  }
}

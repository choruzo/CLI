/**
 * McpManager — ciclo de vida de los MCP servers (§12.8).
 *
 * Gestiona la conexión eager al arranque, el heartbeat periódico,
 * la reconexión con backoff exponencial y el shutdown graceful.
 *
 * El registro de tools se *sincroniza* por server: el manager recuerda qué
 * nombres registró cada cliente, así que tras una reconexión o un
 * `tools/list_changed` retira las que ya no existen, y nunca deja que un
 * server pise una tool de otro (o una built-in) con un nombre que colisiona.
 */

import type { McpServer, StratumConfig } from '../../config/schema.js';
import type { ToolRegistry } from '../registry.js';
import { McpClosedError, McpServerClient } from './client.js';
import { buildMcpTool } from './bridge.js';
import { expandHome } from '../../config/paths.js';
import type { McpRuntimeOptions } from './installer.js';
import { mcpLog } from './diagnostics.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('mcp');

/** Backoff de reconexión (§12.8): 2 s → 4 s → 8 s. */
const RECONNECT_DELAYS_MS = [2000, 4000, 8000];
/** Tope del ping del heartbeat: el del SDK (60 s) supera al intervalo. */
const PING_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface McpManagerWarning {
  serverName: string;
  message: string;
}

export interface McpStatusSummary {
  connected: number;
  reconnecting: number;
  disconnected: number;
  total: number;
}

export interface McpManagerOptions {
  /** Retardos del backoff de reconexión, en ms (tests). */
  reconnectDelaysMs?: number[];
  /**
   * Directorio de trabajo de los servers: el `cwd` de la sesión dueña de este
   * manager. Sin él nacen en el directorio del proceso.
   */
  cwd?: string;
  /**
   * M17 — las tools que no estén declaradas de solo lectura
   * (`mcp.readOnlyTools`) se confirman cada vez (o con una concesión). Lo pide
   * el `companion`: sus conectores actúan fuera de la caja.
   */
  confirmMutating?: boolean;
}

/**
 * M20 — un server que se suma o se quita en vida de la sesión (los conectores
 * del `companion`), con su comprobación previa a cada conexión.
 */
export interface DynamicMcpServer {
  config: McpServer;
  beforeConnect?: () => Promise<void>;
  /**
   * M27 — tools de este server con confirmación **forzada** (`forced` en el
   * manifiesto de un conector): ni allow-all ni concesiones, y la confirmación
   * enseña los argumentos enteros (`buildMcpTool`).
   */
  forcedTools?: readonly string[];
}

const NO_FORCED: ReadonlySet<string> = new Set();

/**
 * Huella de un server dinámico: su config y sus tools forzadas. Si cambian las
 * forzadas, el server se relanza y sus tools se registran otra vez.
 */
function dynamicKey(s: DynamicMcpServer): string {
  return JSON.stringify({ config: s.config, forced: [...(s.forcedTools ?? [])].sort() });
}

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

export class McpManager {
  private readonly clients: McpServerClient[] = [];
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private registry: ToolRegistry | null = null;
  private onWarn: ((w: McpManagerWarning) => void) | undefined;
  private readonly reconnectDelays: number[];
  private readonly confirmMutating: boolean;

  /** Nombres registrados por cada cliente, para retirarlos al cambiar. */
  private readonly registered = new Map<McpServerClient, Set<string>>();
  /** Dueño de cada nombre registrado: detecta colisiones entre servers. */
  private readonly owners = new Map<string, McpServerClient>();
  /** Clientes con un bucle de reconexión en marcha (uno como mucho). */
  private readonly reconnecting = new Set<McpServerClient>();
  /** Clientes con un ping en vuelo: un ping lento no se solapa con el siguiente. */
  private readonly pinging = new Set<McpServerClient>();
  /**
   * Abortado por `shutdownAll()`: corta las esperas del backoff y evita que
   * una reconexión relance un server después de cerrar.
   */
  private lifecycle = new AbortController();
  private readonly runtime: McpRuntimeOptions;
  private readonly onLog: (line: string) => void;
  /** M20 — servers dinámicos por nombre, con la huella de su config. */
  private readonly dynamic = new Map<
    string,
    { client: McpServerClient; key: string; forced: ReadonlySet<string> }
  >();
  /** M20 — `setDynamicServers` en serie: dos sincronizaciones nunca se solapan. */
  private dynamicChain: Promise<unknown> = Promise.resolve();

  /**
   * @param config configuración de Stratum
   * @param onLog sink para el diagnóstico de los servers (stderr, instalador).
   *   Por defecto va a `~/.stratum/logs/mcp.log` vía `mcpLog`; los tests pueden
   *   inyectar un sink propio (o un no-op).
   */
  constructor(
    private readonly config: StratumConfig,
    onLog: (line: string) => void = mcpLog,
    options: McpManagerOptions = {},
  ) {
    this.reconnectDelays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.confirmMutating = options.confirmMutating === true;
    this.runtime = {
      installDir: expandHome(config.mcp.installDir),
      autoInstall: config.mcp.autoInstall,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    this.onLog = onLog;
    for (const serverCfg of config.mcp.servers) {
      this.clients.push(this._newClient(serverCfg));
    }
  }

  private _newClient(serverCfg: McpServer, beforeConnect?: () => Promise<void>): McpServerClient {
    const client = new McpServerClient(serverCfg, this.runtime, this.onLog, beforeConnect);
    client.onConnectionLost = () => {
      log.warn('connection lost, reconnecting', { server: client.name });
      void this._reconnectWithBackoff(client);
    };
    client.onToolsChanged = () => {
      log.info('tool list changed', { server: client.name, tools: client.tools.length });
      this._emit(this._syncClientTools(client));
    };
    return client;
  }

  /**
   * M20 — deja los servers dinámicos en `servers`: quita (cierra y retira sus
   * tools) los que ya no están o cambiaron, añade los nuevos y conecta los que
   * no estén conectados. Un nombre que ya usa un server de la config se omite
   * con aviso. Devuelve los avisos (conexión fallida, colisiones). Necesita un
   * registry (`registerInto`); tras `shutdownAll` no hace nada.
   */
  setDynamicServers(servers: readonly DynamicMcpServer[]): Promise<McpManagerWarning[]> {
    const next = this.dynamicChain.then(() => this._setDynamic(servers));
    this.dynamicChain = next.catch(() => undefined);
    return next;
  }

  private async _setDynamic(servers: readonly DynamicMcpServer[]): Promise<McpManagerWarning[]> {
    if (this.lifecycle.signal.aborted || !this.registry) return [];
    const warnings: McpManagerWarning[] = [];
    const staticNames = new Set(this.clients.filter((c) => !this._isDynamic(c)).map((c) => c.name));
    const wanted = new Map<string, DynamicMcpServer>();
    for (const s of servers) {
      if (staticNames.has(s.config.name) || wanted.has(s.config.name)) {
        warnings.push({
          serverName: s.config.name,
          message: `MCP server '${s.config.name}' skipped: another server already uses that name.`,
        });
        continue;
      }
      wanted.set(s.config.name, s);
    }
    for (const [name, entry] of [...this.dynamic]) {
      const want = wanted.get(name);
      if (want && dynamicKey(want) === entry.key) continue;
      this._dropClient(entry.client);
      this.dynamic.delete(name);
      await entry.client.close();
    }
    for (const [name, s] of wanted) {
      if (this.dynamic.has(name)) continue;
      const client = this._newClient(s.config, s.beforeConnect);
      this.clients.push(client);
      this.dynamic.set(name, {
        client,
        key: dynamicKey(s),
        forced: new Set(s.forcedTools ?? []),
      });
    }
    const pending = [...this.dynamic.values()]
      .map((e) => e.client)
      .filter((c) => c.status !== 'connected' && !this.reconnecting.has(c));
    const results = await Promise.allSettled(pending.map((c) => c.connect()));
    results.forEach((r, i) => {
      const client = pending[i]!;
      if (r.status === 'rejected') {
        if (r.reason instanceof McpClosedError) return;
        log.warn('connect failed (dynamic)', { server: client.name, err: r.reason });
        warnings.push(connectWarning(client, r.reason));
      } else {
        warnings.push(...this._syncClientTools(client));
      }
    });
    if (this.dynamic.size > 0) this.startHeartbeat();
    return warnings;
  }

  /** M27 — las tools forzadas de un server dinámico; ninguna en uno de la config. */
  private _forcedOf(client: McpServerClient): ReadonlySet<string> {
    const entry = this.dynamic.get(client.name);
    return entry?.client === client ? entry.forced : NO_FORCED;
  }

  private _isDynamic(client: McpServerClient): boolean {
    return this.dynamic.get(client.name)?.client === client;
  }

  /** Retira las tools de un cliente y lo saca de la lista. */
  private _dropClient(client: McpServerClient): void {
    for (const name of this.registered.get(client) ?? []) {
      this.registry?.unregister(name);
      this.owners.delete(name);
    }
    this.registered.delete(client);
    const i = this.clients.indexOf(client);
    if (i >= 0) this.clients.splice(i, 1);
  }

  /**
   * Conecta a todos los servers en paralelo (arranque eager).
   * Un fallo individual emite un warning — no aborta el arranque (§12.8).
   * Devuelve la lista de warnings de conexión fallida.
   */
  async connectAll(): Promise<McpManagerWarning[]> {
    this._reopen();
    const warnings: McpManagerWarning[] = [];

    const results = await Promise.allSettled(this.clients.map((c) => c.connect()));

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const client = this.clients[i]!;
      if (result.status === 'rejected') {
        log.error('connect failed', { server: client.name, err: result.reason });
        warnings.push(connectWarning(client, result.reason));
      } else {
        log.info('connected', { server: client.name, tools: client.tools.length });
      }
    }

    return warnings;
  }

  /**
   * Arranque NO bloqueante (§12.8, opción 3 — modo `lazy`).
   *
   * Lanza la conexión de cada server en background y registra sus tools en
   * cuanto cada uno queda listo. Devuelve de inmediato para que la UI de `chat`
   * arranque sin esperar a la red. Los fallos (y las colisiones de nombres) se
   * notifican por `onWarn`.
   */
  startBackground(registry: ToolRegistry, onWarn?: (w: McpManagerWarning) => void): void {
    this._reopen();
    this.registry = registry;
    this.onWarn = onWarn;
    for (const client of this.clients) {
      void client
        .connect()
        .then(() => {
          log.info('connected (background)', { server: client.name, tools: client.tools.length });
          this._emit(this._syncClientTools(client));
        })
        .catch((reason) => {
          // Cerrado mientras conectaba (salida de chat, /mcp reload): no es un fallo.
          if (reason instanceof McpClosedError) return;
          log.error('connect failed (background)', { server: client.name, err: reason });
          this._emit([connectWarning(client, reason)]);
        });
    }
  }

  /**
   * Registra en el ToolRegistry todas las tools de los servers conectados.
   * Guarda referencia al registry para re-registrar tras una reconexión o un
   * cambio de catálogo. Devuelve los avisos de nombres que colisionan.
   */
  registerInto(registry: ToolRegistry): McpManagerWarning[] {
    this.registry = registry;
    const warnings: McpManagerWarning[] = [];
    for (const client of this.clients) {
      if (client.status === 'connected') {
        warnings.push(...this._syncClientTools(client));
      }
    }
    return warnings;
  }

  /**
   * `/mcp reload`: retira las tools MCP, cierra todos los servers y los vuelve
   * a conectar. Devuelve los avisos de conexión y de registro.
   */
  async reload(registry: ToolRegistry): Promise<McpManagerWarning[]> {
    this.registry = registry;
    this._unregisterAll();
    await this.shutdownAll();
    const warnings = await this.connectAll();
    warnings.push(...this.registerInto(registry));
    this.startHeartbeat();
    return warnings;
  }

  /**
   * Inicia el heartbeat periódico (§12.8).
   * Se llama después de connectAll() y registerInto().
   */
  startHeartbeat(): void {
    if (this.heartbeatHandle !== null) return;
    const interval = this.config.mcp.heartbeatInterval;
    this.heartbeatHandle = setInterval(() => {
      this._heartbeatTick();
    }, interval);
    // No bloquear el proceso Node si sólo queda este timer
    if (this.heartbeatHandle.unref) this.heartbeatHandle.unref();
  }

  /** Acceso de sólo lectura a los clientes, para listado y diagnóstico. */
  getClients(): ReadonlyArray<McpServerClient> {
    return this.clients;
  }

  /**
   * Nombre con el que quedó registrada cada tool de un server (puede llevar
   * hash si el original no era un nombre válido o era demasiado largo).
   */
  registeredNames(client: McpServerClient): ReadonlySet<string> {
    return this.registered.get(client) ?? new Set();
  }

  /**
   * Resumen de estado de conectividad para el status bar de la UI.
   */
  getStatusSummary(): McpStatusSummary {
    let connected = 0;
    let reconnecting = 0;
    let disconnected = 0;
    for (const c of this.clients) {
      if (c.status === 'connected') connected++;
      else if (c.status === 'reconnecting' || c.status === 'connecting') reconnecting++;
      else disconnected++;
    }
    return { connected, reconnecting, disconnected, total: this.clients.length };
  }

  /**
   * Cierre graceful de todos los servers y limpieza del heartbeat (§12.8).
   * Corta cualquier reconexión en curso: ninguna relanza un server después.
   */
  async shutdownAll(): Promise<void> {
    this.lifecycle.abort();
    if (this.heartbeatHandle !== null) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  /** Tras un shutdown, un nuevo arranque vuelve a permitir reconexiones. */
  private _reopen(): void {
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController();
  }

  private _emit(warnings: McpManagerWarning[]): void {
    for (const w of warnings) this.onWarn?.(w);
  }

  /**
   * Hace que el registro refleje el catálogo actual del cliente: registra las
   * tools nuevas o cambiadas y retira las que desaparecieron. Un nombre que ya
   * pertenece a otro server (o a una built-in), o repetido en el mismo
   * catálogo, se omite con aviso en vez de pisar al primero.
   */
  private _syncClientTools(client: McpServerClient): McpManagerWarning[] {
    const registry = this.registry;
    if (!registry) return [];
    const previous = this.registered.get(client) ?? new Set<string>();
    const next = new Set<string>();
    const warnings: McpManagerWarning[] = [];

    for (const mcpTool of client.tools) {
      const def = buildMcpTool(client, mcpTool, {
        confirmMutating: this.confirmMutating,
        forced: this._forcedOf(client).has(mcpTool.name),
      });
      const owner = this.owners.get(def.name);
      const takenByOther = owner !== undefined && owner !== client;
      const takenByBuiltin = owner === undefined && registry.get(def.name) !== undefined;
      if (next.has(def.name) || takenByOther || takenByBuiltin) {
        const who = takenByOther ? `server '${owner!.name}'` : 'another tool';
        const message = `MCP tool '${client.name}/${mcpTool.name}' skipped: its name '${def.name}' is already used by ${who}.`;
        log.warn('tool name collision', {
          server: client.name,
          tool: mcpTool.name,
          name: def.name,
        });
        warnings.push({ serverName: client.name, message });
        continue;
      }
      registry.register(def);
      next.add(def.name);
      this.owners.set(def.name, client);
    }

    for (const name of previous) {
      if (!next.has(name)) {
        registry.unregister(name);
        this.owners.delete(name);
      }
    }
    this.registered.set(client, next);
    return warnings;
  }

  private _unregisterAll(): void {
    for (const names of this.registered.values()) {
      for (const name of names) this.registry?.unregister(name);
    }
    this.registered.clear();
    this.owners.clear();
  }

  private _heartbeatTick(): void {
    for (const client of this.clients) {
      if (client.status !== 'connected' || this.pinging.has(client)) continue;
      this.pinging.add(client);
      const timeout = Math.min(this.config.mcp.heartbeatInterval, PING_TIMEOUT_MS);
      client
        .ping(timeout)
        .catch(() => {
          // Un server que no responde al ping está colgado o muerto: reconectar
          // relanza el proceso (connect() cierra el anterior).
          if (client.status !== 'connected' || this.lifecycle.signal.aborted) return;
          log.warn('heartbeat lost, reconnecting', { server: client.name });
          void this._reconnectWithBackoff(client);
        })
        .finally(() => this.pinging.delete(client));
    }
  }

  /**
   * Reconexión con backoff exponencial: 2s → 4s → 8s, máx 3 intentos (§12.8).
   * Uno por cliente a la vez; un `shutdownAll()` la corta en cualquier punto.
   * Agotados los intentos, el cliente queda `disconnected` (sus tools siguen
   * registradas y responden que el server no está disponible; `/mcp reload`
   * lo recupera).
   */
  private async _reconnectWithBackoff(client: McpServerClient): Promise<void> {
    if (this.reconnecting.has(client) || this.lifecycle.signal.aborted) return;
    this.reconnecting.add(client);
    const signal = this.lifecycle.signal;
    try {
      for (const delay of this.reconnectDelays) {
        if (!(await sleep(delay, signal))) return;
        try {
          await client.reconnect();
        } catch (err) {
          if (signal.aborted) return;
          log.warn('reconnect attempt failed', { server: client.name, err });
          continue;
        }
        if (signal.aborted) {
          // Se cerró mientras conectaba y el connect llegó a terminar.
          await client.close();
          return;
        }
        log.info('reconnected', { server: client.name, afterMs: delay });
        this._emit(this._syncClientTools(client));
        return;
      }
      log.error('reconnect exhausted', { server: client.name });
    } finally {
      this.reconnecting.delete(client);
    }
  }
}

function connectWarning(client: McpServerClient, reason: unknown): McpManagerWarning {
  return {
    serverName: client.name,
    message: `MCP server '${client.name}' failed to connect: ${reason instanceof Error ? reason.message : String(reason)}`,
  };
}

/**
 * Espera `ms` o hasta que `signal` aborte. Devuelve false si abortó. El timer
 * no mantiene vivo el proceso: una reconexión pendiente no retrasa la salida.
 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

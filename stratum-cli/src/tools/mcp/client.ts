/**
 * MCP server client wrapper — stdio transport (§12.8).
 *
 * Un McpServerClient encapsula la conexión a un único MCP server y expone
 * estado observable, el catálogo de tools descubierto y métodos para hacer
 * llamadas y verificar la conectividad.
 *
 * Ciclo de vida: cada `connect()` abre una *generación* nueva (proceso hijo +
 * `Client` del SDK nuevos). `close()` también la invalida, así que un connect
 * que estaba en vuelo cuando se cerró mata su propio proceso en vez de dejar
 * un server huérfano marcado como conectado. Los eventos del transport de una
 * generación vieja (su `onclose` llega tarde) se ignoran.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '../../config/schema.js';
import { resolveServerCommand, type McpRuntimeOptions } from './installer.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type McpServerStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Tope de páginas de `tools/list`: un cursor que no termina no cuelga el arranque. */
const MAX_TOOL_PAGES = 50;
/** Timeout de tool por defecto si la config no lo trae (tests con config parcial). */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/**
 * Holgura del timeout del SDK sobre el de la tool: manda el del dispatcher,
 * que aborta la señal y hace que el SDK notifique la cancelación al server.
 */
const SDK_TIMEOUT_SLACK_MS = 5_000;

/** Error de conexión abortada porque el cliente se cerró mientras conectaba. */
export class McpClosedError extends Error {
  constructor(server: string) {
    super(`MCP server '${server}' was closed while connecting`);
    this.name = 'McpClosedError';
  }
}

// ---------------------------------------------------------------------------
// McpServerClient
// ---------------------------------------------------------------------------

export class McpServerClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private _status: McpServerStatus = 'connecting';
  private _tools: McpToolInfo[] = [];
  /** Conexión en vuelo, para deduplicar llamadas concurrentes (lazy/§12.8). */
  private connectInFlight: Promise<void> | null = null;
  /** Invalida conexiones en vuelo y eventos de transports anteriores. */
  private generation = 0;

  readonly name: string;

  /**
   * El server cerró la conexión sin que se lo pidiésemos (se cayó, lo mataron).
   * El `McpManager` lo usa para reconectar: sin esto el cliente se quedaba en
   * `reconnecting` para siempre, porque el heartbeat solo sondea los conectados.
   */
  onConnectionLost?: () => void;
  /** El catálogo de tools cambió (`notifications/tools/list_changed`). */
  onToolsChanged?: () => void;

  /**
   * @param serverConfig configuración del server en `.stratumrc.json`
   * @param runtime opciones de la carpeta gestionada (installDir, autoInstall).
   *   Por defecto desactiva la carpeta gestionada (modo `command`/`args` puro),
   *   útil en tests; el `McpManager` siempre las inyecta desde la config.
   */
  constructor(
    private readonly serverConfig: McpServer,
    private readonly runtime: McpRuntimeOptions = {
      installDir: '~/.stratum/mcp',
      autoInstall: true,
    },
    private readonly onLog?: (line: string) => void,
  ) {
    this.name = serverConfig.name;
  }

  get status(): McpServerStatus {
    return this._status;
  }

  get tools(): McpToolInfo[] {
    return this._tools;
  }

  /** Timeout de cada llamada a una tool de este server, en ms. */
  get toolTimeout(): number {
    return this.serverConfig.toolTimeout ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  /**
   * Conecta al server y descubre su catálogo de tools.
   * Lanza excepción si la conexión falla — el llamador (McpManager) la captura.
   * Pase lo que pase, al fallar no queda proceso hijo vivo y el estado es
   * `disconnected`.
   */
  async connect(): Promise<void> {
    const gen = ++this.generation;
    this._status = this._status === 'reconnecting' ? 'reconnecting' : 'connecting';
    await this.disposeTransport();

    const client = this.newClient();
    let transport: StdioClientTransport | null = null;
    try {
      // Resuelve el ejecutable: con `package`, instala en la carpeta gestionada
      // (si procede) y devuelve `node <entry>`, evitando npx (§12.8, opción 2).
      const resolved = await resolveServerCommand(this.serverConfig, this.runtime, this.onLog);
      this.assertCurrent(gen);

      transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        env: resolved.env,
        // Por defecto el SDK usa 'inherit', lo que vuelca el stderr del server
        // (banners, avisos de telemetría, etc.) directamente a la terminal de
        // Stratum y ensucia la UI de arranque. Lo capturamos con 'pipe' para que
        // no llegue a la consola y lo drenamos hacia onLog (diagnóstico).
        stderr: 'pipe',
      });
      this.transport = transport;
      this.client = client;

      // Cierre inesperado: solo cuenta si es de la generación actual y estaba
      // conectado (un close() propio ya ha movido el estado a disconnected).
      transport.onclose = () => {
        if (gen !== this.generation || this._status !== 'connected') return;
        this._status = 'reconnecting';
        this.onConnectionLost?.();
      };

      // startupTimeout: un server que no arranca a tiempo no debe colgar el
      // proceso (§12.8, opción 3). Cubre también el descubrimiento de tools.
      const started = transport;
      const tools = await withTimeout(
        (async () => {
          await client.connect(started);
          this._drainStderr(started);
          return discoverTools(client);
        })(),
        this.serverConfig.startupTimeout,
        `MCP server '${this.name}' no arrancó en ${this.serverConfig.startupTimeout}ms`,
      );
      this.assertCurrent(gen);
      this._tools = tools;
      this._status = 'connected';
    } catch (err) {
      // Solo la generación vigente toca el estado compartido: una vieja que
      // falla tarde no debe desconectar a la que la sustituyó.
      if (gen === this.generation) {
        this._status = 'disconnected';
        await this.disposeTransport();
      } else if (transport) {
        await closeQuietly(transport);
      }
      throw err;
    }
  }

  /**
   * Conecta sólo si no está ya conectado/conectando. Idempotente y seguro ante
   * llamadas concurrentes: usado por el modo lazy y por la conexión bajo demanda.
   */
  async ensureConnected(): Promise<void> {
    if (this._status === 'connected') return;
    if (this.connectInFlight) return this.connectInFlight;
    this.connectInFlight = this.connect().finally(() => {
      this.connectInFlight = null;
    });
    return this.connectInFlight;
  }

  /**
   * Llama a una tool del server por su nombre MCP (sin prefijo).
   * Devuelve el resultado crudo del SDK.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = this.toolTimeout,
  ): Promise<McpCallResult> {
    const client = this.requireClient();
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: timeoutMs + SDK_TIMEOUT_SLACK_MS,
    });
    return result as McpCallResult;
  }

  /**
   * Heartbeat: lanza si el server no responde (§12.8). Con timeout propio: el
   * del SDK es de 60 s, más que el intervalo del heartbeat.
   */
  async ping(timeoutMs?: number): Promise<void> {
    await this.requireClient().ping(timeoutMs ? { timeout: timeoutMs } : undefined);
  }

  /**
   * Cierre graceful: el transport cierra stdin, luego SIGTERM y SIGKILL si el
   * server no sale (§12.8/§12.12). Invalida cualquier connect en vuelo.
   */
  async close(): Promise<void> {
    this.generation++;
    this._status = 'disconnected';
    await this.disposeTransport();
  }

  /**
   * Re-conecta desde cero (usado por el backoff de McpManager).
   */
  async reconnect(): Promise<void> {
    this._status = 'reconnecting';
    await this.connect();
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private newClient(): Client {
    return new Client(
      { name: 'stratum', version: '1' },
      {
        // El SDK solo instala el handler si el server anuncia
        // `tools.listChanged`. Sin autoRefresh: su refresco no pagina.
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 300,
            onChanged: () => void this.refreshTools(),
          },
        },
      },
    );
  }

  /** Relee el catálogo tras un `list_changed` y avisa al manager. */
  private async refreshTools(): Promise<void> {
    const gen = this.generation;
    const client = this.client;
    if (!client || this._status !== 'connected') return;
    try {
      const tools = await discoverTools(client);
      if (gen !== this.generation) return;
      this._tools = tools;
      this.onToolsChanged?.();
    } catch (err) {
      this.onLog?.(
        `[${this.name}] tools/list after list_changed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private requireClient(): Client {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server '${this.name}' is not connected`);
    }
    return this.client;
  }

  private assertCurrent(gen: number): void {
    if (gen !== this.generation) throw new McpClosedError(this.name);
  }

  /**
   * Drena el stderr del proceso hijo (disponible cuando stderr='pipe'),
   * reenviando cada línea no vacía a onLog en vez de a la consola.
   */
  private _drainStderr(transport: StdioClientTransport): void {
    const childStderr = transport.stderr;
    if (!childStderr) return;
    childStderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) this.onLog?.(`[${this.name}] ${line}`);
      }
    });
    // Evitar que un error en el stream tumbe el proceso.
    childStderr.on('error', () => {});
  }

  /** Cierra el transport actual (y su proceso) sin propagar errores. */
  private async disposeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    if (transport) await closeQuietly(transport);
  }
}

/**
 * Lista todas las tools del server siguiendo `nextCursor`. Antes solo se leía
 * la primera página y un server con muchas tools perdía el resto sin aviso.
 */
async function discoverTools(client: Client): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of result.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      });
    }
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return tools;
}

async function closeQuietly(transport: StdioClientTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // ignorar — el proceso pudo no haber arrancado o ya haber muerto
  }
}

/**
 * Envuelve una promesa con un timeout. Si vence, rechaza con `message`.
 * La promesa original se deja correr (su rechazo se ignora).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

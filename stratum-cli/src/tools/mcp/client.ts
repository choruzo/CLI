/**
 * MCP server client wrapper — stdio transport (§12.8).
 *
 * Un McpServerClient encapsula la conexión a un único MCP server y expone
 * estado observable, el catálogo de tools descubierto y métodos para hacer
 * llamadas y verificar la conectividad.
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

// ---------------------------------------------------------------------------
// McpServerClient
// ---------------------------------------------------------------------------

export class McpServerClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private _status: McpServerStatus = 'connecting';
  private _tools: McpToolInfo[] = [];
  /** Conexión en vuelo, para deduplicar llamadas concurrentes (lazy/§12.8). */
  private connectInFlight: Promise<void> | null = null;

  readonly name: string;

  /**
   * @param serverConfig configuración del server en `.stratumrc.json`
   * @param runtime opciones de la carpeta gestionada (installDir, autoInstall).
   *   Por defecto desactiva la carpeta gestionada (modo `command`/`args` puro),
   *   útil en tests; el `McpManager` siempre las inyecta desde la config.
   */
  constructor(
    private readonly serverConfig: McpServer,
    private readonly runtime: McpRuntimeOptions = { installDir: '~/.stratum/mcp', autoInstall: true },
    private readonly onLog?: (line: string) => void,
  ) {
    this.name = serverConfig.name;
    this.client = new Client({ name: 'stratum', version: '1' });
  }

  get status(): McpServerStatus {
    return this._status;
  }

  get tools(): McpToolInfo[] {
    return this._tools;
  }

  /**
   * Conecta al server y descubre su catálogo de tools.
   * Lanza excepción si la conexión falla — el llamador (McpManager) la captura.
   */
  async connect(): Promise<void> {
    this._status = 'connecting';

    // Resuelve el ejecutable: con `package`, instala en la carpeta gestionada
    // (si procede) y devuelve `node <entry>`, evitando npx (§12.8, opción 2).
    const resolved = await resolveServerCommand(this.serverConfig, this.runtime, this.onLog);

    this.transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      // Por defecto el SDK usa 'inherit', lo que vuelca el stderr del server
      // (banners, avisos de telemetría, etc.) directamente a la terminal de
      // Stratum y ensucia la UI de arranque. Lo capturamos con 'pipe' para que
      // no llegue a la consola y lo drenamos hacia onLog (diagnóstico).
      stderr: 'pipe',
    });

    // Registrar el handler de cierre inesperado del transport antes de connect()
    this.transport.onclose = () => {
      if (this._status === 'connected') {
        this._status = 'reconnecting';
      }
    };

    // startupTimeout: un server que no arranca a tiempo no debe colgar el
    // proceso (§12.8, opción 3). Si vence, abortamos y matamos el hijo.
    try {
      await withTimeout(
        this.client.connect(this.transport),
        this.serverConfig.startupTimeout,
        `MCP server '${this.name}' no arrancó en ${this.serverConfig.startupTimeout}ms`,
      );
    } catch (err) {
      await this._killTransport();
      this._status = 'disconnected';
      throw err;
    }

    // El proceso hijo ya está spawneado: drenamos su stderr (capturado con
    // stderr='pipe') para que no quede bufferizado ni aparezca en la UI.
    this._drainStderr();

    await this._discoverTools();
    this._status = 'connected';
  }

  /**
   * Drena el stderr del proceso hijo (disponible cuando stderr='pipe'),
   * reenviando cada línea no vacía a onLog en vez de a la consola.
   */
  private _drainStderr(): void {
    const childStderr = this.transport?.stderr;
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
  ): Promise<{ content: { type: string; [k: string]: unknown }[]; isError?: boolean }> {
    const result = await this.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    // El SDK puede devolver content como array de ContentBlock
    return result as { content: { type: string; [k: string]: unknown }[]; isError?: boolean };
  }

  /**
   * Heartbeat: lanza si el server no responde (§12.8).
   */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  /**
   * Cierre graceful: el transport envía SIGTERM al proceso hijo.
   * Esperamos 2 s antes de forzar SIGKILL (§12.8/§12.12).
   */
  async close(): Promise<void> {
    this._status = 'disconnected';
    if (!this.transport) return;

    const killTimer = setTimeout(() => {
      // SIGKILL si el transport no terminó a tiempo
      try {
        (
          this.transport as StdioClientTransport & { _process?: { kill(s: string): void } }
        )._process?.kill('SIGKILL');
      } catch {
        // ignorar — el proceso ya terminó
      }
    }, 2000);

    try {
      await this.transport.close();
    } finally {
      clearTimeout(killTimer);
      this.transport = null;
    }
  }

  /**
   * Re-conecta desde cero (usado por el backoff de McpManager).
   */
  async reconnect(): Promise<void> {
    this._status = 'reconnecting';
    // Cerrar la conexión anterior sin cambiar el estado a disconnected
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignorar errores al cerrar una conexión ya rota
      }
      this.transport = null;
    }
    // Crear un nuevo Client para que no quede en estado inconsistente
    this.client = new Client({ name: 'stratum', version: '1' });
    await this.connect();
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private async _discoverTools(): Promise<void> {
    const { tools } = await this.client.listTools();
    this._tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
  }

  /** Cierra/mata el transport tras un fallo de arranque, sin propagar errores. */
  private async _killTransport(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.transport.close();
    } catch {
      // ignorar — el proceso pudo no haber arrancado
    }
    this.transport = null;
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

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

  readonly name: string;

  constructor(private readonly serverConfig: McpServer) {
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

    this.transport = new StdioClientTransport({
      command: this.serverConfig.command,
      args: this.serverConfig.args,
      env: this.serverConfig.env,
    });

    // Registrar el handler de cierre inesperado del transport antes de connect()
    this.transport.onclose = () => {
      if (this._status === 'connected') {
        this._status = 'reconnecting';
      }
    };

    await this.client.connect(this.transport);
    await this._discoverTools();
    this._status = 'connected';
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
}

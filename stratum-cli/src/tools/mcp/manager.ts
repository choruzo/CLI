/**
 * McpManager — ciclo de vida de los MCP servers (§12.8).
 *
 * Gestiona la conexión eager al arranque, el heartbeat periódico,
 * la reconexión con backoff exponencial y el shutdown graceful.
 */

import type { StratumConfig } from '../../config/schema.js';
import type { ToolRegistry } from '../registry.js';
import { McpServerClient } from './client.js';
import { buildMcpTool } from './bridge.js';

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

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

export class McpManager {
  private readonly clients: McpServerClient[] = [];
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private registry: ToolRegistry | null = null;

  constructor(private readonly config: StratumConfig) {
    for (const serverCfg of config.mcp.servers) {
      this.clients.push(new McpServerClient(serverCfg));
    }
  }

  /**
   * Conecta a todos los servers en paralelo (arranque eager).
   * Un fallo individual emite un warning — no aborta el arranque (§12.8).
   * Devuelve la lista de warnings de conexión fallida.
   */
  async connectAll(): Promise<McpManagerWarning[]> {
    const warnings: McpManagerWarning[] = [];

    const results = await Promise.allSettled(this.clients.map((c) => c.connect()));

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const client = this.clients[i]!;
      if (result.status === 'rejected') {
        warnings.push({
          serverName: client.name,
          message: `MCP server '${client.name}' failed to connect: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        });
      }
    }

    return warnings;
  }

  /**
   * Registra en el ToolRegistry todas las tools de los servers conectados.
   * Guarda referencia al registry para re-registrar tras una reconexión exitosa.
   */
  registerInto(registry: ToolRegistry): void {
    this.registry = registry;
    for (const client of this.clients) {
      if (client.status === 'connected') {
        this._registerClientTools(client, registry);
      }
    }
  }

  /**
   * Inicia el heartbeat periódico (§12.8).
   * Se llama después de connectAll() y registerInto().
   */
  startHeartbeat(): void {
    if (this.heartbeatHandle !== null) return;
    const interval = this.config.mcp.heartbeatInterval;
    this.heartbeatHandle = setInterval(() => {
      void this._heartbeatTick();
    }, interval);
    // No bloquear el proceso Node si sólo queda este timer
    if (this.heartbeatHandle.unref) this.heartbeatHandle.unref();
  }

  /** Acceso de sólo lectura a los clientes, para listado y diagnóstico. */
  getClients(): ReadonlyArray<McpServerClient> {
    return this.clients;
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
   */
  async shutdownAll(): Promise<void> {
    if (this.heartbeatHandle !== null) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private _registerClientTools(client: McpServerClient, registry: ToolRegistry): void {
    for (const mcpTool of client.tools) {
      registry.register(buildMcpTool(client, mcpTool));
    }
  }

  private async _heartbeatTick(): Promise<void> {
    for (const client of this.clients) {
      if (client.status !== 'connected') continue;
      try {
        await client.ping();
      } catch {
        // El ping falló: iniciar reconexión con backoff exponencial (§12.8)
        void this._reconnectWithBackoff(client);
      }
    }
  }

  /**
   * Reconexión con backoff exponencial: 2s → 4s → 8s, máx 3 intentos (§12.8).
   */
  private async _reconnectWithBackoff(client: McpServerClient): Promise<void> {
    const delays = [2000, 4000, 8000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        await client.reconnect();
        // Reconexión exitosa: re-registrar tools si hay registry disponible
        if (this.registry) {
          this._registerClientTools(client, this.registry);
        }
        return;
      } catch {
        // Sigue intentando con el siguiente delay
      }
    }
    // Agotados los reintentos → disconnected (status ya lo fija reconnect internamente)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

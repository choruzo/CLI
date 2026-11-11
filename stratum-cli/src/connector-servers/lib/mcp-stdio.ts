/**
 * Server MCP mínimo para los conectores del `companion`: JSON-RPC 2.0 delimitado
 * por saltos de línea sobre stdin/stdout. Sin dependencias (ni el SDK de MCP):
 * el bundle de cada conector corre dentro de un contenedor sin node_modules.
 *
 * `createMcpServer` es puro (recibe un mensaje, devuelve la respuesta o `null`);
 * `serveStdio` solo lo conecta a la entrada y salida estándar.
 */

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, signal?: AbortSignal) => Promise<string>;
}

/** Error que se le enseña al agente tal cual (argumento inválido, lugar no hallado…). */
export class ToolUserError extends Error {}

export interface McpServer {
  handle(msg: unknown): Promise<object | null>;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function rpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createMcpServer(
  info: { name: string; version: string },
  tools: ConnectorTool[],
): McpServer {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(id: unknown, params: unknown): Promise<object> {
    const p = isRecord(params) ? params : {};
    const tool = typeof p.name === 'string' ? byName.get(p.name) : undefined;
    if (!tool) return rpcError(id, -32602, `Tool desconocida: ${String(p.name)}`);
    try {
      const text = await tool.handler(p.arguments ?? {});
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      if (err instanceof ToolUserError) {
        return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: `Error interno del conector ${info.name}: ${msg}` }],
        isError: true,
      });
    }
  }

  return {
    async handle(msg: unknown): Promise<object | null> {
      if (!isRecord(msg) || typeof msg.method !== 'string') {
        // Sin `method` no es una petición ni una notificación: si trae id, error.
        if (isRecord(msg) && msg.id !== undefined)
          return rpcError(msg.id, -32600, 'Petición inválida');
        return rpcError(null, -32600, 'Petición inválida');
      }
      // Notificación: sin `id`, nunca se responde.
      if (msg.id === undefined || msg.id === null) return null;
      const id = msg.id;
      switch (msg.method) {
        case 'initialize': {
          const params = isRecord(msg.params) ? msg.params : {};
          const protocolVersion =
            typeof params.protocolVersion === 'string'
              ? params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION;
          return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: info });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        case 'tools/call':
          return callTool(id, msg.params);
        default:
          return rpcError(id, -32601, `Método desconocido: ${msg.method}`);
      }
    },
  };
}

/**
 * Lee líneas de stdin (EOF = cierre limpio: el proceso termina solo al drenar
 * las peticiones en vuelo), atiende cada petición en paralelo y responde una línea por respuesta.
 */
export function serveStdio(server: McpServer): void {
  let buffer = '';

  const write = (obj: object): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const dispatch = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write(rpcError(null, -32700, 'JSON inválido'));
      return;
    }
    server
      .handle(msg)
      .then((res) => {
        if (res) write(res);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[connector] error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      dispatch(line);
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) dispatch(buffer);
    buffer = '';
  });
}

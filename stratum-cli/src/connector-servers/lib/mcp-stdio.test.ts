import { describe, expect, it } from 'vitest';
import { ToolUserError, createMcpServer, type ConnectorTool } from './mcp-stdio.js';

const tools: ConnectorTool[] = [
  {
    name: 'eco',
    description: 'Devuelve lo recibido.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => `eco:${JSON.stringify(args)}`,
  },
  {
    name: 'usuario',
    description: 'Falla con error de usuario.',
    inputSchema: { type: 'object' },
    handler: async () => {
      throw new ToolUserError('Argumento inválido: x.');
    },
  },
  {
    name: 'roto',
    description: 'Falla con error interno.',
    inputSchema: { type: 'object' },
    handler: async () => {
      throw new Error('boom');
    },
  },
];
const server = createMcpServer({ name: 'test', version: '1.0.0' }, tools);

describe('createMcpServer', () => {
  it('initialize devuelve la versión pedida y las capacidades', async () => {
    const r = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'test', version: '1.0.0' },
      },
    });
  });

  it('initialize sin versión usa la por defecto', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { protocolVersion: string };
    };
    expect(r.result.protocolVersion).toBe('2025-06-18');
  });

  it('ping responde {}', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      result: {},
    });
  });

  it('tools/list lista name, description e inputSchema', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    expect(r.result.tools.map((t) => t.name)).toEqual(['eco', 'usuario', 'roto']);
    expect(Object.keys(r.result.tools[0]!).sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('tools/call devuelve el texto', async () => {
    const r = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'eco', arguments: { a: 1 } },
    });
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'eco:{"a":1}' }] },
    });
  });

  it('ToolUserError → isError con su mensaje', async () => {
    const r = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'usuario' },
    });
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'Argumento inválido: x.' }], isError: true },
    });
  });

  it('otro error → isError con texto genérico', async () => {
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'roto' },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain('Error interno del conector');
    expect(r.result.content[0]!.text).toContain('boom');
  });

  it('tool desconocida → -32602; método desconocido → -32601', async () => {
    const a = (await server.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nada' },
    })) as { error: { code: number } };
    expect(a.error.code).toBe(-32602);
    const b = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'foo/bar' })) as {
      error: { code: number };
    };
    expect(b.error.code).toBe(-32601);
  });

  it('las notificaciones no se responden', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull();
  });
});

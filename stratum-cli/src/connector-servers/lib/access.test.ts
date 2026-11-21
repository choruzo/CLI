import { describe, expect, it } from 'vitest';
import { accessCheckTool } from './access.js';
import { ToolUserError, createMcpServer } from './mcp-stdio.js';

function call(verify: () => Promise<void>) {
  const tool = accessCheckTool('x_acceso', 'Comprueba el acceso.', verify);
  const server = createMcpServer({ name: 'x', version: '1.0.0' }, [tool]);
  return server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'x_acceso', arguments: {} },
  }) as Promise<{
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  }>;
}

describe('accessCheckTool (M23)', () => {
  it('no tiene argumentos y declara su outputSchema', () => {
    const t = accessCheckTool('x_acceso', 'd', async () => {});
    expect(t.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(t.outputSchema).toMatchObject({ required: ['estado', 'valor', 'detalle'] });
  });

  it('éxito: estado ok, valor null y la línea para vigilantes', async () => {
    const { result } = await call(async () => {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ estado: 'ok', valor: null });
    expect(result.content[0]!.text).toContain('Para vigilantes: estado «ok»');
  });

  it.each(['auth', 'unreachable'] as const)(
    'ToolUserError con kind %s no es isError',
    async (k) => {
      const { result } = await call(async () => {
        throw new ToolUserError('Mensaje del fallo.', k);
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        estado: k,
        valor: null,
        detalle: 'Mensaje del fallo.',
      });
      expect(result.content[0]!.text).toContain(`Para vigilantes: estado «${k}»`);
    },
  );

  it('ToolUserError sin kind → estado error', async () => {
    const { result } = await call(async () => {
      throw new ToolUserError('No está configurado.');
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      estado: 'error',
      detalle: 'No está configurado.',
    });
  });

  it('cualquier otro error se relanza y el server lo vuelve isError', async () => {
    const { result } = await call(async () => {
      throw new Error('boom');
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toContain('boom');
  });

  it('ignora los argumentos que lleguen', async () => {
    const tool = accessCheckTool('x_acceso', 'd', async () => {});
    const out = await tool.handler({ foo: 1 });
    expect(out.structured.estado).toBe('ok');
  });
});

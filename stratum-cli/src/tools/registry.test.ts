import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, ToolDispatcher } from './registry.js';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});
const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  config,
};

function makeTool(
  name: string,
  result: ToolResult,
  opts?: Partial<ToolDefinition>,
): ToolDefinition {
  return {
    name,
    description: `Test ${name}`,
    schema: z.object({ x: z.string().optional() }),
    async execute(): Promise<ToolResult> {
      return result;
    },
    ...opts,
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('my_tool', { ok: true, output: 'ok' });
    reg.register(tool);
    expect(reg.get('my_tool')).toBe(tool);
  });

  it('lists all tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('a', { ok: true, output: '' }));
    reg.register(makeTool('b', { ok: true, output: '' }));
    expect(reg.list().map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('converts to tool schemas for LLM', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('do_thing', { ok: true, output: '' }));
    const schemas = reg.toToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      type: 'function',
      function: { name: 'do_thing' },
    });
  });
});

describe('ToolDispatcher', () => {
  it('dispatches a single successful call', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('tool1', { ok: true, output: 'result' }));
    const dispatcher = new ToolDispatcher(reg);

    const results = await dispatcher.dispatch([{ id: 'c1', name: 'tool1', input: {} }], ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({ ok: true, output: 'result' });
  });

  it('returns error for unknown tool', async () => {
    const reg = new ToolRegistry();
    const dispatcher = new ToolDispatcher(reg);

    const results = await dispatcher.dispatch([{ id: 'c1', name: 'unknown', input: {} }], ctx);
    expect(results[0]!.result).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    });
  });

  it('returns error for invalid params (Zod validation)', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'strict_tool',
      description: 'requires name',
      schema: z.object({ name: z.string() }),
      async execute(): Promise<ToolResult> {
        return { ok: true, output: 'ok' };
      },
    });
    const dispatcher = new ToolDispatcher(reg);

    // Pass wrong type for 'name'
    const results = await dispatcher.dispatch(
      [{ id: 'c1', name: 'strict_tool', input: { name: 123 } }],
      ctx,
    );
    expect(results[0]!.result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid'),
    });
  });

  it('runs serialized tools sequentially', async () => {
    const order: number[] = [];
    const reg = new ToolRegistry();

    reg.register({
      name: 'serial_tool',
      description: 'serialized',
      schema: z.object({ n: z.number() }),
      serialized: true,
      async execute(params): Promise<ToolResult> {
        const n = (params as { n: number }).n;
        await new Promise((r) => setTimeout(r, 10 - n)); // later tools resolve faster
        order.push(n);
        return { ok: true, output: String(n) };
      },
    });

    const dispatcher = new ToolDispatcher(reg);
    await dispatcher.dispatch(
      [
        { id: 'c1', name: 'serial_tool', input: { n: 1 } },
        { id: 'c2', name: 'serial_tool', input: { n: 2 } },
        { id: 'c3', name: 'serial_tool', input: { n: 3 } },
      ],
      ctx,
    );

    // Serialized: should run in submission order regardless of timing
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs non-serialized tools in parallel', async () => {
    const reg = new ToolRegistry();
    let concurrency = 0;
    let maxConcurrency = 0;

    reg.register({
      name: 'parallel_tool',
      description: 'parallel',
      schema: z.object({}),
      async execute(): Promise<ToolResult> {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        await new Promise((r) => setTimeout(r, 20));
        concurrency--;
        return { ok: true, output: 'ok' };
      },
    });

    const dispatcher = new ToolDispatcher(reg);
    await dispatcher.dispatch(
      [
        { id: 'c1', name: 'parallel_tool', input: {} },
        { id: 'c2', name: 'parallel_tool', input: {} },
      ],
      ctx,
    );

    expect(maxConcurrency).toBe(2);
  });
});

describe('ToolDispatcher — Hito 16', () => {
  const SECRET = 'sk-proj-AbCdEf0123456789XyZ_abc';

  /** Tool que devuelve, en orden, los resultados que se le den. */
  function scripted(name: string, results: ToolResult[]): ToolDefinition {
    let i = 0;
    return makeTool(
      name,
      { ok: true, output: '' },
      {
        async execute(): Promise<ToolResult> {
          return results[Math.min(i++, results.length - 1)]!;
        },
      },
    );
  }

  it('redacta la salida y los rechazos de preflight', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('leaky', { ok: true, output: `token=${SECRET}` }));
    reg.register(
      makeTool(
        'vetoed',
        { ok: true, output: '' },
        { preflight: () => ({ ok: false, error: `blocked ${SECRET}`, recoverable: false }) },
      ),
    );
    const results = await new ToolDispatcher(reg).dispatch(
      [
        { id: 'a', name: 'leaky', input: {} },
        { id: 'b', name: 'vetoed', input: {} },
      ],
      ctx,
    );
    expect(JSON.stringify(results)).not.toContain('sk-proj-AbCd');
    expect(results[0]!.result).toEqual({ ok: true, output: 'token=[redacted: API key]' });
  });

  it('redacta ANTES de truncar: una clave más larga que el tope no deja medio bloque', async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(60000)}\n-----END RSA PRIVATE KEY-----`;
    const reg = new ToolRegistry();
    reg.register(makeTool('dump', { ok: true, output: pem }));
    const [res] = await new ToolDispatcher(reg).dispatch(
      [{ id: 'a', name: 'dump', input: {} }],
      ctx,
    );
    expect(res!.result).toEqual({ ok: true, output: '[redacted: private key]' });
  });

  it('el contador es consecutivo y un error no contable no lo toca', async () => {
    const fail: ToolResult = { ok: false, error: 'boom', recoverable: true };
    const exit1: ToolResult = {
      ok: false,
      error: 'exit 1',
      recoverable: true,
      countsAsFailure: false,
    };
    const reg = new ToolRegistry();
    reg.register(scripted('flaky', [fail, exit1, fail, fail, fail]));
    const dispatcher = new ToolDispatcher(reg, 3);
    const call = (id: string) => dispatcher.dispatch([{ id, name: 'flaky', input: {} }], ctx);

    await call('1'); // fallo contable → 1
    await call('2'); // exit 1 → sigue en 1
    const third = await call('3'); // fallo → 2
    expect(third[0]!.result).toMatchObject({ error: 'boom', recoverable: true });
    // El fallo que alcanza el límite ya deshabilita la tool: sale del schema en
    // la iteración siguiente, no una llamada más tarde (§12.3).
    const fourth = await call('4'); // fallo → 3
    expect(fourth[0]!.result).toMatchObject({
      recoverable: false,
      error: expect.stringMatching(/^boom[\s\S]*disabled for this session after 3/),
    });
    expect(reg.toToolSchemas().map((s) => s.function.name)).not.toContain('flaky');
    const fifth = await call('5');
    expect(fifth[0]!.result).toMatchObject({ error: expect.stringContaining('disabled') });
  });

  it('una señal que ya llega abortada no deja la llamada colgada', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool(
        'ignores_abort',
        { ok: true, output: '' },
        {
          execute: () => new Promise<ToolResult>(() => {}),
        },
      ),
    );
    reg.register(
      makeTool(
        'structured_ignores_abort',
        { ok: true, output: '' },
        {
          structuredCancellation: true,
          execute: () => new Promise<ToolResult>(() => {}),
        },
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const results = await new ToolDispatcher(reg, 3, 50).dispatch(
      [
        { id: 'a', name: 'ignores_abort', input: {} },
        { id: 'b', name: 'structured_ignores_abort', input: {} },
      ],
      { ...ctx, signal: controller.signal },
    );
    expect(results.map((r) => r.result.ok)).toEqual([false, false]);
  });

  it('un éxito reinicia la racha', async () => {
    const fail: ToolResult = { ok: false, error: 'boom', recoverable: true };
    const reg = new ToolRegistry();
    reg.register(scripted('mixed', [fail, fail, { ok: true, output: 'ok' }, fail, fail, fail]));
    const dispatcher = new ToolDispatcher(reg, 3);
    const call = (id: string) => dispatcher.dispatch([{ id, name: 'mixed', input: {} }], ctx);
    await call('1'); // fallo → 1
    await call('2'); // fallo → 2
    await call('3'); // éxito → 0
    await call('4'); // fallo → 1
    // Sin el reinicio, este sería el tercer fallo y ya deshabilitaría la tool.
    const fifth = await call('5'); // fallo → 2
    expect(fifth[0]!.result).toMatchObject({ error: 'boom', recoverable: true });
    const sixth = await call('6'); // fallo → 3: alcanza el límite
    expect(sixth[0]!.result).toMatchObject({ recoverable: false });
  });

  it('un isSerialized que lanza serializa la tanda', async () => {
    const order: number[] = [];
    const reg = new ToolRegistry();
    reg.register({
      name: 'maybe_serial',
      description: 'x',
      schema: z.object({ n: z.number() }),
      isSerialized() {
        throw new Error('bad hook');
      },
      async execute(params): Promise<ToolResult> {
        const n = (params as { n: number }).n;
        await new Promise((r) => setTimeout(r, 10 - n));
        order.push(n);
        return { ok: true, output: String(n) };
      },
    });
    await new ToolDispatcher(reg).dispatch(
      [1, 2, 3].map((n) => ({ id: `c${n}`, name: 'maybe_serial', input: { n } })),
      ctx,
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('structuredCancellation: el resultado cancelled de la tool llega intacto y no suma', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool(
        'cancellable',
        { ok: true, output: '' },
        {
          structuredCancellation: true,
          execute: (_params, toolCtx) =>
            new Promise<ToolResult>((resolveResult) => {
              toolCtx.signal.addEventListener('abort', () =>
                setTimeout(
                  () =>
                    resolveResult({
                      ok: false,
                      error: 'status="cancelled"',
                      recoverable: true,
                      countsAsFailure: false,
                      executed: true,
                    }),
                  30,
                ),
              );
            }),
        },
      ),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const [res] = await new ToolDispatcher(reg, 3, 1000).dispatch(
      [{ id: 'a', name: 'cancellable', input: {} }],
      { ...ctx, signal: controller.signal },
    );
    expect(res!.result).toMatchObject({ error: 'status="cancelled"', executed: true });
  });

  it('un abort que llega después de terminar la tool no deja temporizadores vivos', async () => {
    vi.useFakeTimers();
    try {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('quick', { ok: true, output: 'done' }, { structuredCancellation: true }),
      );
      const controller = new AbortController();
      const [res] = await new ToolDispatcher(reg, 3, 5000).dispatch(
        [{ id: 'a', name: 'quick', input: {} }],
        { ...ctx, signal: controller.signal },
      );
      expect(res!.result.ok).toBe(true);
      controller.abort();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('la descripción de la confirmación destructiva sale redactada con los extras', async () => {
    const config = StratumConfigSchema.parse({
      tools: { redaction: { extraPatterns: [{ value: 'hunter2hunter2', reason: 'db password' }] } },
    });
    const reg = new ToolRegistry();
    reg.register(makeTool('nuke', { ok: true, output: 'x' }, { destructive: true }));
    let seen = '';
    await new ToolDispatcher(reg).dispatch(
      [{ id: 'a', name: 'nuke', input: { x: 'hunter2hunter2' } }],
      {
        ...ctx,
        config,
        destructivePolicy: 'ask',
        confirmDestructive: async (req) => {
          seen = req.description;
          return 'deny';
        },
      },
    );
    expect(seen).toContain('[redacted: db password]');
    expect(seen).not.toContain('hunter2hunter2');
  });

  it('structuredCancellation: una tool que ignora el abort se rechaza tras la gracia', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool(
        'stuck',
        { ok: true, output: '' },
        {
          structuredCancellation: true,
          execute: () => new Promise<ToolResult>(() => {}),
        },
      ),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const [res] = await new ToolDispatcher(reg, 3, 50).dispatch(
      [{ id: 'a', name: 'stuck', input: {} }],
      { ...ctx, signal: controller.signal },
    );
    expect(res!.result.ok).toBe(false);
  });
});

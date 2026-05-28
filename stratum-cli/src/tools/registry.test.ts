import { describe, it, expect } from 'vitest';
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

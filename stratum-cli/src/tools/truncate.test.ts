import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { truncateToolOutput, MAX_TOOL_OUTPUT_CHARS } from './truncate.js';
import { ToolRegistry, ToolDispatcher } from './registry.js';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

describe('truncateToolOutput', () => {
  it('returns short output unchanged', () => {
    expect(truncateToolOutput('hello')).toBe('hello');
  });

  it('truncates long output keeping head and tail with a marker', () => {
    const text = 'A'.repeat(40_000) + 'TAIL_END';
    const out = truncateToolOutput(text);
    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
    expect(out).toContain('[... output truncated (40008 chars total) ...]');
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('TAIL_END')).toBe(true);
  });
});

describe('ToolDispatcher output truncation (F4)', () => {
  it('truncates oversized tool results before they reach the history', async () => {
    const bigTool: ToolDefinition = {
      name: 'big_output',
      description: 'test tool',
      schema: z.object({}),
      async execute() {
        return { ok: true as const, output: 'X'.repeat(100_000) };
      },
    };

    const registry = new ToolRegistry();
    registry.register(bigTool);
    const dispatcher = new ToolDispatcher(registry);

    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      config: StratumConfigSchema.parse({}),
    };

    const [res] = await dispatcher.dispatch([{ id: '1', name: 'big_output', input: {} }], ctx);
    expect(res!.result.ok).toBe(true);
    if (res!.result.ok) {
      expect(res!.result.output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
      expect(res!.result.output).toContain('output truncated');
    }
  });
});

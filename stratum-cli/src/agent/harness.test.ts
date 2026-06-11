import { describe, it, expect } from 'vitest';
import { ReactLoop, ContextManager } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { z } from 'zod';
import type { ToolDefinition, AgentEvent } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';

const defaultConfig = StratumConfigSchema.parse({});

function noopTool(name: string, result: string): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    schema: z.object({ value: z.string().optional() }),
    async execute(_params, _ctx): Promise<{ ok: true; output: string }> {
      return { ok: true, output: result };
    },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

function makeInvalidToolCallRound(id: string, name: string, args: string) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function' as const,
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    {
      choices: [
        {
          delta: {},
          finish_reason: 'tool_calls',
          index: 0,
        },
      ],
    },
  ];
}

describe('ContextManager', () => {
  it('estimates tokens as chars / 3.5 (proxy mode)', () => {
    const cm = new ContextManager(32768, 6);
    const messages = [
      { role: 'user' as const, content: 'hello world' }, // 11 chars
    ];
    const { used, estimated } = cm.usage(messages);
    expect(used).toBe(Math.ceil(11 / 3.5));
    expect(estimated).toBe(true);
  });

  it('computes pct correctly', () => {
    const cm = new ContextManager(1000, 6);
    const messages = [{ role: 'user' as const, content: 'a'.repeat(350) }]; // 350 chars → ~100 tokens
    const { pct } = cm.usage(messages);
    expect(pct).toBe(10); // 100/1000 = 10%
  });

  it('uses real usage when recordUsage is called (estimated=false)', () => {
    const cm = new ContextManager(32768, 6);
    cm.recordUsage(5000);
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const { used, estimated } = cm.usage(messages);
    expect(used).toBe(5000);
    expect(estimated).toBe(false);
  });

  it('maybeCompress returns skipped when below threshold', async () => {
    const cm = new ContextManager(100000, 6, undefined, undefined, 0.8);
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' },
    ];
    const result = await cm.maybeCompress(messages);
    expect(result.kind).toBe('skipped');
  });

  it('maybeCompress truncates when over threshold and no provider', async () => {
    const cm = new ContextManager(10, 1, undefined, undefined, 0.8); // tiny window
    // Build a history that will definitely exceed 80% of 10 tokens
    const messages: import('./types.js').Message[] = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'a'.repeat(40) }, // ~11 tokens alone
      { role: 'assistant' as const, content: 'b'.repeat(40) },
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'd' },
    ];
    const result = await cm.maybeCompress(messages);
    // Either truncated or pressure — either way it ran
    expect(['truncated', 'pressure']).toContain(result.kind);
    // System prompt must be preserved (index 0)
    expect(messages[0]?.role).toBe('system');
  });

  it('conservative mode raises the threshold so it skips where normal would compress (F6)', async () => {
    // 1000 tokens window, threshold 0.8 → ~850 tokens supera el umbral normal
    // pero queda por debajo del 0.92 efectivo en modo conservative.
    const content = 'a'.repeat(Math.floor(850 * 3.5));
    const build = (): import('./types.js').Message[] => [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content },
      { role: 'assistant' as const, content: 'x' },
      { role: 'user' as const, content: 'y' },
      { role: 'assistant' as const, content: 'z' },
    ];

    const normal = new ContextManager(1000, 1, undefined, undefined, 0.8);
    const normalResult = await normal.maybeCompress(build());
    expect(normalResult.kind).not.toBe('skipped');

    const conservative = new ContextManager(1000, 1, undefined, undefined, 0.8);
    conservative.setCompressionMode('conservative');
    const conservativeResult = await conservative.maybeCompress(build());
    expect(conservativeResult.kind).toBe('skipped');
  });
});

describe('ReactLoop', () => {
  it('emits text events and done(stop) for text-only response', async () => {
    const provider = new MockProvider([makeTextRound('Hello from agent')]);
    const registry = new ToolRegistry();
    const messages = [{ role: 'system' as const, content: 'sys' }];

    const loop = new ReactLoop(provider, registry, messages, defaultConfig, 'test-model', 32768);
    const events = await collectEvents(loop.run());

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('dispatches a tool call and loops for the result', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file', 'file content here'));

    const provider = new MockProvider([
      makeToolCallRound('c1', 'read_file', { value: 'test.txt' }),
      makeTextRound('File says: file content here'),
    ]);

    const messages = [{ role: 'system' as const, content: 'sys' }];
    const loop = new ReactLoop(provider, registry, messages, defaultConfig, 'test-model', 32768);
    const events = await collectEvents(loop.run());

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      name: 'read_file',
      result: 'file content here',
    });

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('caps at maxIterations', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('bash', 'loop output'));

    // Every round returns a tool call — loop never stops on its own
    const round = makeToolCallRound('c1', 'bash', { value: 'x' });
    const provider = new MockProvider(Array(60).fill(round));

    const messages = [{ role: 'system' as const, content: 'sys' }];
    const config = StratumConfigSchema.parse({ agent: { maxIterations: 3 } });
    const loop = new ReactLoop(provider, registry, messages, config, 'test-model', 32768);
    const events = await collectEvents(loop.run());

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'max_iterations' });
  });

  it('injects tool error into history and continues loop (inject & recover)', async () => {
    const registry = new ToolRegistry();
    // Tool that always fails
    registry.register({
      name: 'fail_tool',
      description: 'always fails',
      schema: z.object({}),
      async execute(): Promise<{ ok: false; error: string; recoverable: boolean }> {
        return { ok: false, error: 'tool failed', recoverable: true };
      },
    });

    const provider = new MockProvider([
      makeToolCallRound('c1', 'fail_tool', {}),
      makeTextRound('I see the tool failed, I will recover'),
    ]);

    const messages = [{ role: 'system' as const, content: 'sys' }];
    const loop = new ReactLoop(provider, registry, messages, defaultConfig, 'test-model', 32768);
    const events = await collectEvents(loop.run());

    const toolErr = events.find((e) => e.type === 'tool_error');
    expect(toolErr).toMatchObject({ type: 'tool_error', name: 'fail_tool', recoverable: true });

    const injectedToolMessage = messages.find(
      (message) => message.role === 'tool' && message.name === 'fail_tool',
    );
    expect(injectedToolMessage?.content).toContain(
      '<suggestion>Review the error above and adjust the tool call parameters accordingly.</suggestion>',
    );

    // Loop should continue and eventually stop
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('injects parse errors with a JSON-specific suggestion', async () => {
    const provider = new MockProvider([
      makeInvalidToolCallRound('c1', 'bash', '{invalid json'),
      makeTextRound('Recovered after parse error'),
    ]);
    const registry = new ToolRegistry();
    const messages = [{ role: 'system' as const, content: 'sys' }];

    const loop = new ReactLoop(provider, registry, messages, defaultConfig, 'test-model', 32768);
    const events = await collectEvents(loop.run());

    const toolErr = events.find((e) => e.type === 'tool_error');
    expect(toolErr).toMatchObject({ type: 'tool_error', name: 'bash', recoverable: false });

    const injectedToolMessage = messages.find(
      (message) => message.role === 'tool' && message.name === 'bash',
    );
    expect(injectedToolMessage?.content).toContain(
      '<suggestion>Ensure the tool call arguments are valid JSON.</suggestion>',
    );
  });

  it('respects AbortSignal cancellation', async () => {
    const provider = new MockProvider([makeTextRound('Long response...')]);
    const registry = new ToolRegistry();
    const messages = [{ role: 'system' as const, content: 'sys' }];

    const controller = new AbortController();
    controller.abort(); // abort immediately

    const loop = new ReactLoop(provider, registry, messages, defaultConfig, 'test-model', 32768);
    const events = await collectEvents(loop.run({ signal: controller.signal }));

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', stopReason: 'cancelled' });
  });
});

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, Message, ToolDefinition } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

function echoTool(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'test',
    schema: z.object({ path: z.string() }),
    async execute(params) {
      return { ok: true, output: `leído ${(params as { path: string }).path}` };
    },
  };
}

/** Tool call cuyo último chunk lleva `finish` (o ninguno, si es `undefined`). */
function toolRound(finish: string | null | undefined): OpenAIStreamChunk[] {
  const chunks: OpenAIStreamChunk[] = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
  ];
  if (finish !== undefined) {
    chunks.push({ choices: [{ delta: {}, finish_reason: finish, index: 0 }] });
  }
  return chunks;
}

async function run(round: OpenAIStreamChunk[]): Promise<AgentEvent[]> {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const provider = new MockProvider([round, makeTextRound('hecho')]);
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  const loop = new ReactLoop(provider, registry, messages, config, 'test-model', 32768);
  const events: AgentEvent[] = [];
  for await (const ev of loop.run()) events.push(ev);
  return events;
}

describe('ReactLoop — tool calls que el backend no cierra con "tool_calls"', () => {
  it.each([
    ['finish_reason "stop"', 'stop'],
    ['sin finish_reason (el stream acaba sin más)', undefined],
  ] as const)('%s: la llamada se ejecuta en vez de perderse', async (_label, finish) => {
    const events = await run(toolRound(finish));
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      name: 'read_file',
      result: 'leído a.txt',
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('finish_reason "length": error recuperable inyectado y el turno sigue', async () => {
    const events = await run(toolRound('length'));
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    expect(events.find((e) => e.type === 'tool_error')).toMatchObject({ id: 'c1' });
    // La segunda ronda (texto) llega: el modelo pudo reaccionar al error.
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });
});

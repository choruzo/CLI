import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { StratumConfigSchema } from '../config/schema.js';
import { ProviderError } from '../providers/errors.js';
import { makeTextRound } from '../providers/mock.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, Message } from './types.js';

async function run(provider: IProvider): Promise<{ events: AgentEvent[]; ms: number }> {
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  const loop = new ReactLoop(
    provider,
    new ToolRegistry(),
    messages,
    StratumConfigSchema.parse({}),
    'm',
    32768,
  );
  const events: AgentEvent[] = [];
  const t0 = Date.now();
  for await (const ev of loop.run()) events.push(ev);
  return { events, ms: Date.now() - t0 };
}

describe('errores del provider en el loop', () => {
  it('un chunk descartado por el provider llega como warning y la respuesta sigue', async () => {
    const provider: IProvider = {
      async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
        const [first, last] = makeTextRound('hola');
        yield first!;
        req.onStreamWarning?.('stream_chunk_dropped: prueba');
        yield last!;
      },
      healthCheck: async () => true,
    };
    const { events } = await run(provider);
    expect(events).toContainEqual({ type: 'warning', message: 'stream_chunk_dropped: prueba' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' });
  });

  it('un error permanente es fatal en el acto, con el mensaje del backend', async () => {
    let calls = 0;
    const provider: IProvider = {
      async *complete(): AsyncGenerator<OpenAIStreamChunk> {
        calls++;
        throw new ProviderError('LLM API error 401 Unauthorized: invalid key', 'http', false, {
          status: 401,
        });
      },
      healthCheck: async () => true,
    };
    const { events, ms } = await run(provider);
    expect(calls).toBe(1);
    expect(ms).toBeLessThan(900);
    expect(events).toContainEqual({
      type: 'error',
      message: 'LLM API error 401 Unauthorized: invalid key',
      fatal: true,
    });
  });
});

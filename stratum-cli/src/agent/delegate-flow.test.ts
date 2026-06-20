import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { AgentEvent, Message, RunOptions, SubagentRouter } from './types.js';
import type { CompletionRequest, OpenAIStreamChunk, IProvider } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

/** ProfileLoader aislado en un tmp vacío → solo expone el `general` embebido. */
function emptyProfiles(): ProfileLoader {
  return new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-')));
}

function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

describe('delegate_task — flujo del loop (Hito 8A)', () => {
  it('emite subagent_started → subagent_completed e inyecta el resultado como tool result', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 'Resume el README', profile: 'general' }),
      makeTextRound('Listo, delegado.'),
    ]);
    const child = new MockProvider([makeTextRound('He resumido el README en 3 puntos.')]);

    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: emptyProfiles(),
    });

    const opts: RunOptions = { makeSubagentRouter: () => mockRouter(child) };
    const events = await collect(loop.run(opts));

    const started = events.find((e) => e.type === 'subagent_started');
    const completed = events.find((e) => e.type === 'subagent_completed');
    expect(started).toBeDefined();
    expect((started as { profile: string }).profile).toBe('general');
    expect(completed).toBeDefined();
    expect((completed as { result: { status: string } }).result.status).toBe('completed');

    // El resultado entró al historial como tool result de delegate_task.
    const toolMsg = messages.find((m) => m.role === 'tool' && m.name === 'delegate_task');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain('<subagent_result');
    expect(toolMsg?.content).toContain('He resumido el README');

    // El padre siguió y terminó normalmente.
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('perfil inexistente → tool_error recuperable, el padre continúa', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 't', profile: 'inexistente' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: emptyProfiles(),
    });

    const events = await collect(loop.run({}));
    const err = events.find((e) => e.type === 'tool_error');
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain("unknown profile 'inexistente'");
    expect((err as { recoverable: boolean }).recoverable).toBe(true);
    expect(events.some((e) => e.type === 'subagent_started')).toBe(false);
    // El padre se recupera y termina.
    expect(events.find((e) => e.type === 'done')).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('un fallo del hijo se devuelve como tool result recuperable, no tumba al padre', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 't', profile: 'general' }),
      makeTextRound('manejado'),
    ]);
    // Provider del hijo que lanza al primer chunk → el loop hijo cierra con error.
    const failingChild: IProvider = {
      // eslint-disable-next-line require-yield
      async *complete(_req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
        throw new Error('boom del hijo');
      },
      async healthCheck() {
        return true;
      },
    };

    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: emptyProfiles(),
    });

    const events = await collect(loop.run({ makeSubagentRouter: () => mockRouter(failingChild) }));

    const completed = events.find((e) => e.type === 'subagent_completed');
    expect(completed).toBeDefined();
    expect((completed as { result: { status: string } }).result.status).toBe('failed');

    // El padre no se cayó: llegó a su done stop.
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
    // No hubo error fatal del padre.
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 15_000); // el loop hijo reintenta el stream (backoff ~7s) antes de fallar

  it('en modo plan, delegate_task se rechaza como tool mutante (read-only)', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 't', profile: 'general' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: emptyProfiles(),
    });

    const events = await collect(loop.run({ mode: 'plan' }));
    const err = events.find((e) => e.type === 'tool_error');
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain('Plan mode');
    expect(events.some((e) => e.type === 'subagent_started')).toBe(false);
  });
});

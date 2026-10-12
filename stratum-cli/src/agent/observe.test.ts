import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StratumAgent, type AgentObservation } from './core.js';
import { ProfileLoader } from './profiles.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, ToolDefinition } from './types.js';

const config = StratumConfigSchema.parse({
  provider: {
    default: 'test',
    providers: {
      test: {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'test-model',
        contextWindow: 32768,
      },
    },
  },
  memory: { autoExtract: false },
  trace: { enabled: false },
});

const noop: ToolDefinition = {
  name: 'noop',
  description: 'Does nothing.',
  schema: z.object({}),
  execute: async () => ({ ok: true, output: 'ok' }),
} as ToolDefinition;

function newAgent(rounds: OpenAIStreamChunk[][]): StratumAgent {
  const registry = new ToolRegistry();
  registry.register(noop);
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider(rounds));
  return new StratumAgent(config, router, registry, { profileLoader: new ProfileLoader([]) });
}

describe('StratumAgent.observe', () => {
  it('ve el turno entero: principio, los mismos eventos que el consumidor y final', async () => {
    const agent = newAgent([makeToolCallRound('c1', 'noop', {}), makeTextRound('listo')]);
    const seen: AgentObservation[] = [];
    agent.observe((o) => seen.push(o));

    const yielded: AgentEvent[] = [];
    for await (const ev of agent.run('haz algo')) yielded.push(ev);

    expect(seen[0]).toEqual({ type: 'turn_started', kind: 'run', input: 'haz algo' });
    expect(seen.at(-1)).toEqual({ type: 'turn_ended', kind: 'run', stopReason: 'stop' });
    const observedEvents = seen.flatMap((o) => (o.type === 'event' ? [o.event] : []));
    expect(observedEvents).toEqual(yielded);
    expect(yielded.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('cierra el turno aunque el consumidor abandone el generador', async () => {
    const agent = newAgent([makeToolCallRound('c1', 'noop', {}), makeTextRound('listo')]);
    const seen: AgentObservation[] = [];
    agent.observe((o) => seen.push(o));

    for await (const ev of agent.run('haz algo')) {
      if (ev.type === 'tool_result') break;
    }

    expect(seen.at(-1)).toEqual({ type: 'turn_ended', kind: 'run', stopReason: null });
    // El turno abandonado no deja tool calls sin respuesta en el historial.
    const messages = agent.getMessages();
    const calls = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []));
    const answered = new Set(messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])));
    expect(calls.every((c) => answered.has(c.id))).toBe(true);
  });

  it('un observador que lanza no altera el turno ni a los demás observadores', async () => {
    const agent = newAgent([makeTextRound('hola')]);
    const good: AgentObservation[] = [];
    agent.observe(() => {
      throw new Error('observador roto');
    });
    agent.observe((o) => good.push(o));

    const yielded: AgentEvent[] = [];
    for await (const ev of agent.run('hola')) yielded.push(ev);

    expect(yielded.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(good.at(-1)?.type).toBe('turn_ended');
  });

  it('dejar de observar corta las notificaciones', async () => {
    const agent = newAgent([makeTextRound('uno'), makeTextRound('dos')]);
    const seen: AgentObservation[] = [];
    const stop = agent.observe((o) => seen.push(o));

    for await (const _ev of agent.run('primero')) {
      /* drenar */
    }
    const count = seen.length;
    stop();
    for await (const _ev of agent.run('segundo')) {
      /* drenar */
    }

    expect(count).toBeGreaterThan(0);
    expect(seen).toHaveLength(count);
  });

  it('una delegación directa también se observa como un turno', async () => {
    const agent = newAgent([makeTextRound('x')]);
    const seen: AgentObservation[] = [];
    agent.observe((o) => seen.push(o));

    // Perfil inexistente: el turno se abre y se cierra con su error.
    for await (const _ev of agent.runDelegate('no-existe', 'tarea')) {
      /* drenar */
    }

    expect(seen[0]).toEqual({ type: 'turn_started', kind: 'delegate', input: '@no-existe tarea' });
    expect(seen.some((o) => o.type === 'event' && o.event.type === 'error')).toBe(true);
    expect(seen.at(-1)).toEqual({ type: 'turn_ended', kind: 'delegate', stopReason: 'stop' });
  });
});

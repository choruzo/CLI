import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ReactLoop } from './harness.js';
import { StratumAgent } from './core.js';
import { closeDanglingToolCalls, pushUserInput, CANCELLED_BY_USER } from './cancel.js';
import { untilAborted } from './concurrency.js';
import { ToolRegistry, ToolDispatcher } from '../tools/registry.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { AgentEvent, Message, ToolCallReady, ToolContext, ToolDefinition } from './types.js';

const config = StratumConfigSchema.parse({});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function ctxWith(signal: AbortSignal, overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal, cwd: process.cwd(), config, ...overrides };
}

function call(id: string, name: string, input: Record<string, unknown> = {}): ToolCallReady {
  return { id, name, input };
}

/** Una ronda del modelo con varias tool calls a la vez. */
function multiToolRound(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): OpenAIStreamChunk[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, index) => ({
              index,
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: 'tool_calls',
          index: 0,
        },
      ],
    },
  ];
}

describe('closeDanglingToolCalls / pushUserInput (§12.12)', () => {
  it('responde a las tool calls sin resultado del último assistant', () => {
    const messages: Message[] = [
      { role: 'user', content: 'haz algo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'exec', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'ok' },
    ];
    expect(closeDanglingToolCalls(messages)).toBe(1);
    expect(messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      name: 'exec',
      content: CANCELLED_BY_USER,
    });
    // Idempotente.
    expect(closeDanglingToolCalls(messages)).toBe(0);
  });

  it('no toca un historial ya cerrado', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
    ];
    expect(closeDanglingToolCalls(messages)).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it('funde la petición nueva con una anterior que quedó sin respuesta', () => {
    const messages: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'primera' },
    ];
    pushUserInput(messages, 'segunda');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toContain('primera');
    expect(messages[1]!.content).toContain('No response was given');
    expect(messages[1]!.content).toMatch(/segunda$/);
  });

  it('añade un user normal cuando el anterior tuvo respuesta', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    pushUserInput(messages, 'c');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'c' });
  });
});

describe('untilAborted', () => {
  it('resuelve con el valor de cancelación si la señal se aborta antes', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => undefined);
    const pending = untilAborted(never, controller.signal, 'deny');
    controller.abort();
    await expect(pending).resolves.toBe('deny');
  });

  it('con la señal ya abortada no espera a la promesa', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      untilAborted(new Promise<string>(() => undefined), controller.signal, 'x'),
    ).resolves.toBe('x');
  });

  it('sin abort devuelve el resultado de la promesa', async () => {
    await expect(
      untilAborted(Promise.resolve('ok'), new AbortController().signal, 'x'),
    ).resolves.toBe('ok');
  });
});

describe('ToolDispatcher y cancelación (§12.12)', () => {
  it('con el turno ya cancelado no pregunta ni ejecuta nada', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, output: 'escrito' }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'writer',
      description: 't',
      schema: z.object({}),
      destructive: true,
      execute,
    } satisfies ToolDefinition);
    const confirm = vi.fn(async () => 'approve' as const);
    const controller = new AbortController();
    controller.abort();

    const [res] = await new ToolDispatcher(registry).dispatch(
      [call('c1', 'writer')],
      ctxWith(controller.signal, { destructivePolicy: 'ask', confirmDestructive: confirm }),
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result).toMatchObject({ ok: false, countsAsFailure: false });
  });

  it('un Ctrl+C con la confirmación abierta no se queda esperando a la UI', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, output: 'x' }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'nuke',
      description: 't',
      schema: z.object({}),
      destructive: true,
      execute,
    } satisfies ToolDefinition);
    const controller = new AbortController();
    // La UI nunca resuelve (readline cerrado por Ctrl+C).
    const confirm = vi.fn(() => {
      setTimeout(() => controller.abort(), 5);
      return new Promise<never>(() => undefined);
    });

    const [res] = await new ToolDispatcher(registry).dispatch(
      [call('c1', 'nuke'), call('c2', 'nuke')],
      ctxWith(controller.signal, { destructivePolicy: 'ask', confirmDestructive: confirm }),
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result).toMatchObject({ ok: false, error: expect.stringContaining('Cancelled') });
  });

  it('cancelar una tool en curso no cuenta para deshabilitarla', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow',
      description: 't',
      schema: z.object({}),
      execute: () => new Promise(() => undefined),
    } satisfies ToolDefinition);
    const dispatcher = new ToolDispatcher(registry, 3);

    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5);
      const [res] = await dispatcher.dispatch([call(`c${i}`, 'slow')], ctxWith(controller.signal));
      expect(res!.result).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
    }
    expect(registry.toToolSchemas().map((t) => t.function.name)).toContain('slow');
  });
});

describe('ReactLoop y cancelación (§12.12)', () => {
  it('cancelado durante las tools: no abre la pregunta y responde a todas las tool calls', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register({
      name: 'work',
      description: 't',
      schema: z.object({}),
      execute: async () => {
        controller.abort();
        return { ok: true, output: 'hecho' };
      },
    } satisfies ToolDefinition);
    const provider = new MockProvider([
      multiToolRound([
        { id: 't1', name: 'work', args: {} },
        { id: 'q1', name: 'question', args: { questions: [{ question: '¿Sigo?' }] } },
      ]),
      makeTextRound('no debería llegar'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'tarea' },
    ];
    const loop = new ReactLoop(provider, registry, messages, config, 'm', 32768);
    const ask = vi.fn(async () => null);

    const events = await collect(loop.run({ signal: controller.signal, onAskQuestions: ask }));

    expect(ask).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    expect(answered).toEqual(new Set(['t1', 'q1']));
  });

  it('Ctrl+C con la pregunta abierta: el gate no bloquea y el turno acaba cancelado', async () => {
    const controller = new AbortController();
    const provider = new MockProvider([
      multiToolRound([
        { id: 'q1', name: 'question', args: { questions: [{ question: '¿Sigo?' }] } },
      ]),
      makeTextRound('no debería llegar'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'tarea' },
    ];
    const loop = new ReactLoop(provider, new ToolRegistry(), messages, config, 'm', 32768);

    const events = await collect(
      loop.run({
        signal: controller.signal,
        onAskQuestions: () => {
          setTimeout(() => controller.abort(), 5);
          return new Promise(() => undefined);
        },
      }),
    );

    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    const tool = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'q1');
    expect(tool?.content).toBe(CANCELLED_BY_USER);
  });
});

describe('StratumAgent tras un turno cancelado (§12.12)', () => {
  const agentConfig = StratumConfigSchema.parse({
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
  });

  it('abandonar el generador a mitad deja todas las tool calls respondidas', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'work',
      description: 't',
      schema: z.object({}),
      execute: async () => ({ ok: true, output: 'hecho' }),
    } satisfies ToolDefinition);
    const router = new ProviderRouter(agentConfig);
    vi.spyOn(router, 'getActive').mockReturnValue(
      new MockProvider([
        multiToolRound([
          { id: 't1', name: 'work', args: {} },
          { id: 't2', name: 'work', args: {} },
        ]),
        makeTextRound('fin'),
      ]),
    );
    const agent = new StratumAgent(agentConfig, router, registry, {
      initialMessages: [{ role: 'system', content: 'sys' }],
    });

    // El consumidor se va en el primer tool_result: el segundo aún no está en el historial.
    for await (const ev of agent.run('tarea')) {
      if (ev.type === 'tool_result') break;
    }

    const history = agent.getMessages();
    const answered = new Set(history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    expect(answered).toEqual(new Set(['t1', 't2']));
  });
});

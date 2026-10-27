import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StratumAgent } from './core.js';
import { ContextManager } from './harness.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { Message } from './types.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import { emptyTurnUsage } from './usage.js';

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
});

/** Router cuyo provider activo responde con `rounds` (MockProvider). */
function routerWith(rounds: OpenAIStreamChunk[][] = []): ProviderRouter {
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider(rounds));
  return router;
}

/** Una respuesta de texto que reporta `tokens` de uso. */
function reportedRound(text: string, tokens: number): OpenAIStreamChunk[] {
  return [
    ...makeTextRound(text),
    { choices: [], usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens } },
  ];
}

function newAgent(initialMessages?: Message[], rounds?: OpenAIStreamChunk[][]): StratumAgent {
  return new StratumAgent(
    config,
    routerWith(rounds),
    new ToolRegistry(),
    initialMessages ? { initialMessages } : undefined,
  );
}

describe('StratumAgent.clearHistory (/clear, §5.2)', () => {
  it('conserva el system prompt y descarta el resto del historial', () => {
    const agent = newAgent([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
    ]);

    agent.clearHistory();

    const messages = agent.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('reinicia el contador de tool calls y la ref de plan', () => {
    const agent = newAgent([{ role: 'system', content: 'sys' }]);
    agent.setPlanRef('plan_123');

    agent.clearHistory();

    expect(agent.toolCallCount).toBe(0);
    expect(agent.getPlanRef()).toBeNull();
  });

  it('el % de contexto deja de contar el último usage real del historial borrado', () => {
    const agent = newAgent([{ role: 'system', content: 'sys' }]);
    agent.getContextUsage();
    // El provider reportó 20k tokens de prompt en el último turno.
    (agent as unknown as { contextManager: ContextManager }).contextManager.recordUsage(20_000);
    expect(agent.getContextUsage().used).toBe(20_000);
    agent.clearHistory();
    expect(agent.getContextUsage().used).toBeLessThan(100);
  });

  it('no deja un system fantasma si el historial no empezaba por system', () => {
    const agent = newAgent([{ role: 'user', content: 'hola' }]);
    agent.clearHistory();
    expect(agent.getMessages()).toEqual([]);
  });
});

describe('StratumAgent.getContextReport — desglose calibrado', () => {
  it('tras un usage real el total del desglose cuadra con prompt_tokens: las tools no cuentan dos veces', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'big_tool',
      description: 'd'.repeat(7_000),
      schema: z.object({}),
      async execute() {
        return { ok: true, output: '' };
      },
    });
    const agent = new StratumAgent(config, routerWith([reportedRound('ok', 3_000)]), registry, {
      initialMessages: [{ role: 'system', content: 's'.repeat(3_500) }],
    });
    for await (const _ of agent.run('hola')) void _;

    const { breakdown } = agent.getContextReport();
    expect(breakdown.tools).toBeGreaterThan(0);
    // Lo que el provider contó para la request, más la respuesta `ok` que llegó después.
    expect(breakdown.input).toBeGreaterThanOrEqual(3_000);
    expect(breakdown.input).toBeLessThan(3_010);
  });
});

describe('StratumAgent.replaceHistory (/sessions resume en caliente)', () => {
  it('sustituye el historial completo, system incluido', () => {
    const agent = newAgent([{ role: 'system', content: 'viejo' }]);
    const restored: Message[] = [
      { role: 'system', content: 'nuevo' },
      { role: 'user', content: 'de la sesión guardada' },
    ];

    agent.replaceHistory(restored);

    expect(agent.getMessages()).toEqual(restored);
  });

  it('copia los mensajes: mutar el array de origen no afecta al agente', () => {
    const source: Message[] = [{ role: 'system', content: 'sys' }];
    const agent = newAgent();
    agent.replaceHistory(source);
    source.push({ role: 'user', content: 'intruso' });
    expect(agent.getMessages()).toHaveLength(1);
  });

  it('el uso pasa a ser el de la sesión cargada, no la suma con la anterior', async () => {
    const agent = newAgent([{ role: 'system', content: 'sys' }], [reportedRound('hola', 40)]);
    for await (const _ of agent.run('pregunta')) void _;
    expect(agent.getTokenUsage()).toEqual({ status: 'reported', tokens: 40 });

    agent.replaceHistory([{ role: 'system', content: 'sys' }], null, false, {
      toolCalls: 7,
      tokens: 1200,
      tokenStatus: 'reported',
      session: { ...emptyTurnUsage(), llmCalls: 3, promptTokens: 1000, turns: 2 },
    });

    expect(agent.toolCallCount).toBe(7);
    expect(agent.getTokenUsage()).toEqual({ status: 'reported', tokens: 1200 });
    expect(agent.getSessionUsage()).toMatchObject({ llmCalls: 3, promptTokens: 1000, turns: 2 });
    expect(agent.getLastTurnUsage()).toBeNull();
  });

  it('sin uso guardado, los contadores vuelven a cero y los tokens quedan sin dato', async () => {
    const agent = newAgent([{ role: 'system', content: 'sys' }], [reportedRound('hola', 40)]);
    for await (const _ of agent.run('pregunta')) void _;

    agent.replaceHistory([{ role: 'system', content: 'sys' }]);

    expect(agent.toolCallCount).toBe(0);
    expect(agent.getTokenUsage()).toEqual({ status: 'unavailable' });
    expect(agent.getSessionUsage()).toEqual({ ...emptyTurnUsage(), turns: 0 });
  });
});

describe('StratumAgent — uso de una sesión reanudada (chat --resume)', () => {
  it('arranca con los contadores guardados y sigue sumando sobre ellos', async () => {
    const agent = new StratumAgent(
      config,
      routerWith([reportedRound('hola', 40)]),
      new ToolRegistry(),
      {
        initialMessages: [{ role: 'system', content: 'sys' }],
        usage: {
          toolCalls: 2,
          tokens: 100,
          tokenStatus: 'reported',
          session: { ...emptyTurnUsage(), llmCalls: 1, turns: 1 },
        },
      },
    );
    for await (const _ of agent.run('otra')) void _;

    const snapshot = agent.getUsageSnapshot();
    expect(snapshot.toolCalls).toBe(2);
    expect(snapshot.tokens).toBe(140);
    expect(snapshot.session).toMatchObject({ llmCalls: 2, turns: 2 });
  });
});

describe('ContextManager.compress (/compact, §12.4)', () => {
  // El umbral automático es 0.8; con una ventana enorme nunca se alcanzaría.
  const belowThreshold: Message[] = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `mensaje ${i} `.repeat(20),
    })),
  ];

  it('maybeCompress no hace nada por debajo del umbral', async () => {
    const cm = new ContextManager(1_000_000, 2, undefined, undefined, 0.8);
    const messages = [...belowThreshold];
    const result = await cm.maybeCompress(messages);
    expect(result.kind).toBe('skipped');
    expect(messages).toHaveLength(belowThreshold.length);
  });

  it('compress fuerza la compresión aunque el umbral no se haya alcanzado', async () => {
    // Es la vía real de /compact: `compactNow()` siempre pasa el provider activo,
    // así que el historial antiguo se resume con una llamada al LLM (§12.4).
    const provider = new MockProvider([makeTextRound('resumen de lo hablado')]);
    const cm = new ContextManager(1_000_000, 2, provider, 'test-model', 0.8);
    const messages = [...belowThreshold];

    const result = await cm.compress(messages);

    expect(result.kind).toBe('compressed');
    expect(messages.length).toBeLessThan(belowThreshold.length);
    // El system prompt sobrevive siempre y el resumen ocupa su lugar.
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1]?.content).toContain('<summary>');
  });

  it('compress señala presión cuando todo está en la zona protegida', async () => {
    const cm = new ContextManager(1_000_000, 6, undefined, undefined, 0.8);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'única ronda' },
    ];
    const result = await cm.compress(messages);
    expect(result.kind).toBe('pressure');
  });
});

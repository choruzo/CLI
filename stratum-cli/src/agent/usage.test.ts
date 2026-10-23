import { describe, expect, it } from 'vitest';
import { addCallUsage, emptyTurnUsage, sumUsage, type TurnUsage } from './usage.js';
import { ReactLoop } from './harness.js';
import { StratumAgent } from './core.js';
import { ProfileLoader } from './profiles.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { AgentEvent, Message, ToolDefinition } from './types.js';
import type { IProvider } from '../providers/base.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import type { Pricing } from '../providers/pricing.js';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultConfig = StratumConfigSchema.parse({});

/** Router mínimo: el loop solo le pide el provider activo y su precio. */
function makeRouter(provider: IProvider, pricing?: Pricing) {
  return {
    getActive: () => provider,
    model: 'mock-model',
    hasFallback: false,
    providerName: 'mock',
    pricing,
    advanceProvider: () => null,
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** Ronda con `usage` reportado en el chunk final (como lo manda un backend real). */
function makeUsageRound(usage: Record<string, unknown>): OpenAIStreamChunk[] {
  return [
    {
      choices: [{ delta: { content: 'hola' }, finish_reason: null, index: 0 }],
    },
    {
      choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      usage: usage as OpenAIStreamChunk['usage'],
    },
  ];
}

describe('emptyTurnUsage', () => {
  it('no inventa tokens: todo queda sin definir hasta que se reporte', () => {
    const usage = emptyTurnUsage();
    expect(usage).toEqual({ llmCalls: 0, reportedCalls: 0, llmMs: 0, toolMs: 0 });
    expect(usage).not.toHaveProperty('promptTokens');
    expect(usage).not.toHaveProperty('completionTokens');
  });
});

describe('addCallUsage', () => {
  it('una llamada sin usage cuenta tiempo y llamada, pero no tokens', () => {
    const acc = addCallUsage(emptyTurnUsage(), { durationMs: 120 });
    expect(acc.llmCalls).toBe(1);
    expect(acc.reportedCalls).toBe(0);
    expect(acc.llmMs).toBe(120);
    expect(acc.promptTokens).toBeUndefined();
    expect(acc.completionTokens).toBeUndefined();
    expect(acc.cacheHitRate).toBeUndefined();
    expect(acc.outputTokensPerSec).toBeUndefined();
  });

  it('es pura: no muta el acumulador recibido', () => {
    const base = emptyTurnUsage();
    addCallUsage(base, {
      usage: { promptTokens: 1000, completionTokens: 20 },
      durationMs: 500,
    });
    expect(base).toEqual({ llmCalls: 0, reportedCalls: 0, llmMs: 0, toolMs: 0 });
  });

  it('suma tokens y deriva caché y velocidad de generación', () => {
    let acc = addCallUsage(emptyTurnUsage(), {
      usage: { promptTokens: 2000, completionTokens: 100, cachedReadTokens: 1500 },
      durationMs: 2000,
      firstChunkMs: 500,
    });
    acc = addCallUsage(acc, {
      usage: { promptTokens: 3000, completionTokens: 200, cachedReadTokens: 500 },
      durationMs: 3000,
      firstChunkMs: 1000,
    });

    expect(acc.llmCalls).toBe(2);
    expect(acc.reportedCalls).toBe(2);
    expect(acc.promptTokens).toBe(5000);
    expect(acc.completionTokens).toBe(300);
    expect(acc.cachedReadTokens).toBe(2000);
    expect(acc.cacheHitRate).toBeCloseTo(0.4);
    // (2000-500) + (3000-1000) = 3500 ms de generación
    expect(acc.generationMs).toBe(3500);
    expect(acc.outputTokensPerSec).toBeCloseTo(300 / 3.5);
    expect(acc.llmMs).toBe(5000);
    // TTFT del turno = el de la primera request.
    expect(acc.firstTokenMs).toBe(500);
  });

  it('sin cachedReadTokens no hay cacheHitRate, y el costo de caché queda indefinido', () => {
    const acc = addCallUsage(emptyTurnUsage(), {
      usage: { promptTokens: 1000, completionTokens: 10 },
      durationMs: 100,
    });
    expect(acc.promptTokens).toBe(1000);
    expect(acc.cachedReadTokens).toBeUndefined();
    expect(acc.cacheHitRate).toBeUndefined();
  });

  it('suma reasoningTokens solo si el backend lo reporta', () => {
    let acc = addCallUsage(emptyTurnUsage(), {
      usage: { completionTokens: 40, reasoningTokens: 30 },
      durationMs: 10,
    });
    expect(acc.reasoningTokens).toBe(30);
    acc = addCallUsage(acc, { usage: { completionTokens: 10 }, durationMs: 10 });
    expect(acc.reasoningTokens).toBe(30);
  });

  it('sin generación medible no hay outputTokensPerSec (nunca se divide por 0)', () => {
    const acc = addCallUsage(emptyTurnUsage(), {
      usage: { completionTokens: 50 },
      durationMs: 400,
      firstChunkMs: 400,
    });
    expect(acc.generationMs).toBe(0);
    expect(acc.outputTokensPerSec).toBeUndefined();
  });
});

describe('sumUsage', () => {
  it('suma dos turnos y conserva lo indefinido', () => {
    const a: TurnUsage = {
      ...emptyTurnUsage(),
      llmCalls: 1,
      reportedCalls: 1,
      promptTokens: 1000,
      completionTokens: 50,
      llmMs: 800,
      toolMs: 200,
      firstTokenMs: 300,
      generationMs: 500,
    };
    const b: TurnUsage = {
      ...emptyTurnUsage(),
      llmCalls: 1,
      llmMs: 400,
      toolMs: 100,
      firstTokenMs: 150,
    };
    const total = sumUsage(a, b);
    expect(total.llmCalls).toBe(2);
    expect(total.reportedCalls).toBe(1);
    expect(total.promptTokens).toBe(1000);
    expect(total.completionTokens).toBe(50);
    expect(total.llmMs).toBe(1200);
    expect(total.toolMs).toBe(300);
    expect(total.generationMs).toBe(500);
    // El TTFT de la sesión no se suma: se queda con el menor de los medidos.
    expect(total.firstTokenMs).toBe(150);
    expect(total.costUsd).toBeUndefined();
  });

  it('un turno sin tokens no borra los del anterior', () => {
    const a: TurnUsage = { ...emptyTurnUsage(), llmCalls: 2, promptTokens: 500 };
    const total = sumUsage(a, { ...emptyTurnUsage(), llmCalls: 1 });
    expect(total.promptTokens).toBe(500);
    expect(total.llmCalls).toBe(3);
  });

  it('suma los costes cuando ambos tramos los tienen', () => {
    const a: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10, costUsd: 0.1 };
    const b: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10, costUsd: 0.2 };
    expect(sumUsage(a, b).costUsd).toBeCloseTo(0.3, 10);
  });

  it('un tramo con tokens y sin coste deja el total sin definir', () => {
    const priced: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10, costUsd: 0.1 };
    const unpriced: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10 };
    expect(sumUsage(priced, unpriced).costUsd).toBeUndefined();
    expect(sumUsage(unpriced, priced).costUsd).toBeUndefined();
  });

  it('un turno sin tokens (backend sin métricas) no invalida el coste de los demás', () => {
    const priced: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10, costUsd: 0.1 };
    const unmetered: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1 };
    expect(sumUsage(priced, unmetered).costUsd).toBeCloseTo(0.1, 10);
  });

  it('sin coste en ningún tramo, el total sigue sin definir', () => {
    const a: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10 };
    const b: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10 };
    expect(sumUsage(a, b).costUsd).toBeUndefined();
  });

  it('`incomplete` es pegajoso y arrastra el coste a `undefined`', () => {
    const full: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, promptTokens: 10, costUsd: 0.5 };
    const partial: TurnUsage = { ...emptyTurnUsage(), llmCalls: 1, incomplete: true };
    const total = sumUsage(full, partial);
    expect(total.incomplete).toBe(true);
    // «Al menos esto» no es un total: no se publica coste.
    expect(total.costUsd).toBeUndefined();
    expect(sumUsage(total, full).incomplete).toBe(true);
  });

  it('un acumulador vacío es neutro: el coste del primer turno sobrevive', () => {
    const turn: TurnUsage = {
      ...emptyTurnUsage(),
      llmCalls: 1,
      reportedCalls: 1,
      promptTokens: 1000,
      completionTokens: 100,
      llmMs: 500,
      costUsd: 0.0045,
    };
    const session = sumUsage(emptyTurnUsage(), turn);
    expect(session.costUsd).toBeCloseTo(0.0045, 10);
    // Y el acumulador vacío sale intacto de la suma.
    expect(session.llmCalls).toBe(1);
    expect(session.toolMs).toBe(0);
  });
});

describe('ReactLoop.turnUsage', () => {
  it('una request = una entrada, con tokens normalizados y tiempos medidos', async () => {
    const provider = new MockProvider([
      makeUsageRound({
        prompt_tokens: 1200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }),
    ]);
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
    );

    await collectEvents(
      loop.run({ signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0]),
    );

    const usage = loop.turnUsage;
    expect(usage.llmCalls).toBe(1);
    expect(usage.reportedCalls).toBe(1);
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(80);
    expect(usage.cachedReadTokens).toBe(1000);
    expect(usage.reasoningTokens).toBe(20);
    expect(usage.cacheHitRate).toBeCloseTo(1000 / 1200);
    expect(usage.llmMs).toBeGreaterThan(0);
    expect(usage.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(usage.generationMs).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokensPerSec).toBeDefined();
    expect(usage.toolMs).toBe(0);
    expect(usage.costUsd).toBeUndefined();
  });

  it('un backend sin usage deja los tokens indefinidos, no en 0', async () => {
    const provider = new MockProvider([makeTextRound('sin métricas')]);
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
    );

    await collectEvents(
      loop.run({ signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0]),
    );

    const usage = loop.turnUsage;
    expect(usage.llmCalls).toBe(1);
    expect(usage.reportedCalls).toBe(0);
    expect(usage.promptTokens).toBeUndefined();
    expect(usage.completionTokens).toBeUndefined();
    expect(usage.outputTokensPerSec).toBeUndefined();
  });

  it('se reinicia en cada run', async () => {
    const provider = new MockProvider([makeTextRound('uno'), makeTextRound('dos')]);
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
    );
    const opts = { signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0];

    await collectEvents(loop.run(opts));
    const first = loop.turnUsage;
    await collectEvents(loop.run(opts));
    const second = loop.turnUsage;

    expect(first.llmCalls).toBe(1);
    expect(second.llmCalls).toBe(1);
  });

  it('cobra la request con el precio del provider activo (UX-3, parte B)', async () => {
    const provider = new MockProvider([
      makeUsageRound({
        prompt_tokens: 1200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 1000 },
      }),
    ]);
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
      makeRouter(provider, { input: 3, output: 15, cachedInput: 0.3 }),
    );

    await collectEvents(
      loop.run({ signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0]),
    );

    // 200 sin cachear × 3 + 1000 cacheados × 0.3 + 80 de salida × 15 = 2100 / 1e6
    expect(loop.turnUsage.costUsd).toBeCloseTo(0.0021, 10);
  });

  it('sin pricing en el provider, el turno no declara coste', async () => {
    const provider = new MockProvider([
      makeUsageRound({ prompt_tokens: 1200, completion_tokens: 80 }),
    ]);
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
      makeRouter(provider),
    );

    await collectEvents(
      loop.run({ signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0]),
    );

    expect(loop.turnUsage.promptTokens).toBe(1200);
    expect(loop.turnUsage.costUsd).toBeUndefined();
  });

  it('una request sin métricas no invalida el coste de las que sí las trajeron', async () => {
    const echo: ToolDefinition = {
      name: 'echo',
      description: 'test tool',
      schema: z.object({ value: z.string().optional() }),
      async execute(): Promise<{ ok: true; output: string }> {
        return { ok: true, output: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.register(echo);
    // Primera ronda: tool call con `usage`. Segunda: respuesta final sin `usage`.
    const withUsage = makeToolCallRound('c1', 'echo', { value: 'x' });
    withUsage[withUsage.length - 1].usage = { prompt_tokens: 1000, completion_tokens: 10 };
    const provider = new MockProvider([withUsage, makeTextRound('listo')]);
    const loop = new ReactLoop(
      provider,
      registry,
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
      makeRouter(provider, { input: 3, output: 15 }),
    );

    await collectEvents(
      loop.run({ signal: new AbortController().signal } as Parameters<ReactLoop['run']>[0]),
    );

    const usage = loop.turnUsage;
    expect(usage.llmCalls).toBe(2);
    expect(usage.reportedCalls).toBe(1);
    // La segunda request cerró sin `usage` habiendo tarifa: hay consumo que este
    // desglose no incluye, así que no se publica coste (antes se daba el de la
    // primera request como si fuera el del turno).
    expect(usage.costUsd).toBeUndefined();
    expect(usage.incomplete).toBe(true);
    expect(usage.toolMs).toBeGreaterThan(0);
  });

  it('una request abortada a mitad deja el coste del turno sin definir e incompleto', async () => {
    const controller = new AbortController();
    // Provider que entrega un trozo y corta: ni `usage` ni cierre normal.
    const provider: IProvider = {
      async *complete() {
        yield { choices: [{ delta: { content: 'parcial' }, finish_reason: null, index: 0 }] };
        controller.abort();
      },
      async healthCheck() {
        return true;
      },
    };
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      [] as Message[],
      defaultConfig,
      'mock-model',
      32768,
      makeRouter(provider, { input: 3, output: 15 }),
    );

    await collectEvents(loop.run({ signal: controller.signal }));

    const usage = loop.turnUsage;
    expect(usage.llmCalls).toBe(1);
    expect(usage.reportedCalls).toBe(0);
    // No se puede facturar un turno a medias: ni coste ni «total conocido».
    expect(usage.costUsd).toBeUndefined();
    expect(usage.incomplete).toBe(true);
  });
});

describe('StratumAgent — uso de sesión (UX-3)', () => {
  const PRICING: Pricing = { input: 3, output: 15, cachedInput: 0.3 };

  function makeConfig(pricing?: Pricing) {
    return StratumConfigSchema.parse({
      memory: { autoExtract: false },
      provider: {
        default: 'test',
        providers: {
          test: {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: '',
            model: 'test-model',
            contextWindow: 32768,
            ...(pricing ? { pricing } : {}),
          },
        },
      },
    });
  }

  /** Agente real con el cliente HTTP sustituido por el mock; el router (y su precio) es el de verdad. */
  function makeAgent(provider: MockProvider, pricing?: Pricing): StratumAgent {
    const config = makeConfig(pricing);
    const router = new ProviderRouter(config);
    (router as unknown as { getActive: () => IProvider }).getActive = () => provider;
    return new StratumAgent(config, router, new ToolRegistry(), {
      profileLoader: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-usage-'))),
    });
  }

  it('la sesión arranca sin coste, y tras un turno con precio lo tiene definido', async () => {
    const provider = new MockProvider([
      makeUsageRound({ prompt_tokens: 1200, completion_tokens: 80 }),
    ]);
    const agent = makeAgent(provider, PRICING);

    // Antes de cualquier turno: nada que sumar, nada que declarar.
    expect(agent.getLastTurnUsage()).toBeNull();
    expect(agent.getSessionUsage()).toEqual({
      llmCalls: 0,
      reportedCalls: 0,
      llmMs: 0,
      toolMs: 0,
      turns: 0,
    });
    expect(agent.getLiveTurnUsage()).toBeNull();

    await collectEvents(agent.run('hola'));

    // 1200 × 3 + 80 × 15 = 4800 / 1e6
    const last = agent.getLastTurnUsage();
    expect(last?.promptTokens).toBe(1200);
    expect(last?.costUsd).toBeCloseTo(0.0048, 10);

    // La suma parte de un acumulador vacío: es neutra, el coste sobrevive.
    const session = agent.getSessionUsage();
    expect(session.turns).toBe(1);
    expect(session.llmCalls).toBe(1);
    expect(session.costUsd).toBeCloseTo(0.0048, 10);
    // El turno ya cerró: no queda turno en vivo.
    expect(agent.getLiveTurnUsage()).toBeNull();
  });

  it('sin pricing, el turno tiene tokens pero no coste (y la sesión tampoco)', async () => {
    const provider = new MockProvider([
      makeUsageRound({ prompt_tokens: 1200, completion_tokens: 80 }),
    ]);
    const agent = makeAgent(provider);

    await collectEvents(agent.run('hola'));

    expect(agent.getLastTurnUsage()?.promptTokens).toBe(1200);
    expect(agent.getLastTurnUsage()?.costUsd).toBeUndefined();
    expect(agent.getSessionUsage().costUsd).toBeUndefined();
  });

  it('dos turnos con precio acumulan el coste de la sesión', async () => {
    const provider = new MockProvider([
      makeUsageRound({ prompt_tokens: 1000, completion_tokens: 100 }),
      makeUsageRound({ prompt_tokens: 2000, completion_tokens: 200 }),
    ]);
    const agent = makeAgent(provider, PRICING);

    await collectEvents(agent.run('uno'));
    await collectEvents(agent.run('dos'));

    // (1000×3 + 100×15) + (2000×3 + 200×15) = 4500 + 9000 = 13500 / 1e6
    const session = agent.getSessionUsage();
    expect(session.turns).toBe(2);
    expect(session.costUsd).toBeCloseTo(0.0135, 10);
    expect(agent.getLastTurnUsage()?.costUsd).toBeCloseTo(0.009, 10);
  });

  it('clearHistory no borra el uso de la sesión', async () => {
    const provider = new MockProvider([
      makeUsageRound({ prompt_tokens: 1000, completion_tokens: 100 }),
    ]);
    const agent = makeAgent(provider, PRICING);

    await collectEvents(agent.run('hola'));
    agent.clearHistory();

    expect(agent.getSessionUsage().costUsd).toBeCloseTo(0.0045, 10);
    expect(agent.getLastTurnUsage()?.promptTokens).toBe(1000);
  });
});

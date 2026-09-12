import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { formatTokenMeter } from '../cli/ui/StatusBar.js';
import { unavailable } from '../tools/optional.js';
import type { AgentEvent, Message } from './types.js';
import type { OpenAIStreamChunk } from '../providers/base.js';

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

/** Ronda de texto con `usage` en el chunk final, como hace un backend que lo soporta. */
function makeTextRoundWithUsage(text: string, total: number): OpenAIStreamChunk[] {
  const round = makeTextRound(text);
  round[round.length - 1]!.usage = {
    prompt_tokens: Math.floor(total / 2),
    completion_tokens: Math.ceil(total / 2),
    total_tokens: total,
  };
  return round;
}

function newLoop(provider: MockProvider, messages: Message[]): ReactLoop {
  return new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);
}

describe('contabilidad de tokens con estado (Hito 13)', () => {
  it('antes de la primera respuesta el estado es unavailable, no cero', () => {
    const loop = newLoop(new MockProvider([makeTextRound('hola')]), []);
    expect(loop.tokenAccounting).toEqual({ status: 'unavailable' });
  });

  it('con usage en el stream el estado es reported y trae el número', async () => {
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = newLoop(new MockProvider([makeTextRoundWithUsage('hola', 120)]), messages);
    await collect(loop.run({}));
    expect(loop.tokenAccounting).toEqual({ status: 'reported', tokens: 120 });
  });

  it('una request completa sin usage marca unsupported, no un 0 inventado', async () => {
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = newLoop(new MockProvider([makeTextRound('hola')]), messages);
    await collect(loop.run({}));
    expect(loop.tokenAccounting).toEqual({ status: 'unsupported' });
    expect(loop.tokensUsed).toBe(0);
  });

  it('avisa UNA sola vez cuando hay presupuesto pero el backend no lo mide', async () => {
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    // Dos turnos del mismo loop: el aviso no debe repetirse en el segundo.
    const loop = newLoop(new MockProvider([makeTextRound('a')]), messages);
    const first = await collect(loop.run({ maxTokens: 10 }));
    const second = await collect(loop.run({ maxTokens: 10 }));

    const warnings = [...first, ...second].filter(
      (e) => e.type === 'warning' && e.message.startsWith('token_budget_unmetered'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('no avisa cuando el backend sí reporta usage', async () => {
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = newLoop(new MockProvider([makeTextRoundWithUsage('a', 10)]), messages);
    const events = await collect(loop.run({ maxTokens: 1000 }));
    expect(events.some((e) => e.type === 'warning')).toBe(false);
  });

  it('el presupuesto sigue cortando cuando hay métrica real', async () => {
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = newLoop(new MockProvider([makeTextRoundWithUsage('a', 500)]), messages);
    await collect(loop.run({ maxTokens: 100 }));
    const events = await collect(loop.run({ maxTokens: 100 }));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'budget_tokens' });
  });
});

describe('medidor de la barra de estado (Hito 13)', () => {
  it('pinta el número solo cuando el dato es real', () => {
    expect(formatTokenMeter({ status: 'reported', tokens: 4200 })).toBe('Σ 4.2k');
    expect(formatTokenMeter({ status: 'reported', tokens: 320 })).toBe('Σ 320');
  });

  it('unsupported se marca como sin dato; unavailable no pinta nada', () => {
    expect(formatTokenMeter({ status: 'unsupported' })).toBe('Σ n/d');
    expect(formatTokenMeter({ status: 'unavailable' })).toBe('');
    expect(formatTokenMeter(undefined)).toBe('');
  });
});

describe('degradación explícita de tools opcionales (P2 pendiente)', () => {
  it('devuelve un resultado exitoso con instrucciones, no un error', () => {
    const result = unavailable({
      missing: 'the Tavily API key',
      alternatives: ['Use grep and read_file.'],
      howToEnable: 'set TAVILY_API_KEY.',
    });
    expect(result.ok).toBe(true);
    const output = (result as { ok: true; output: string }).output;
    expect(output).toContain('UNAVAILABLE');
    expect(output).toContain('not an error in your call');
    expect(output).toContain('- Use grep and read_file.');
    expect(output).toContain('set TAVILY_API_KEY.');
  });
});

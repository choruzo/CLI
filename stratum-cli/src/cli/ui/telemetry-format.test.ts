import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatCount,
  formatSeconds,
  liveTelemetry,
  turnUsageParts,
  type UsageView,
} from './telemetry-format.js';

const base: UsageView = { llmCalls: 3, reportedCalls: 3, llmMs: 11_200, toolMs: 2_100 };

describe('formatos', () => {
  it('cuenta, segundos y dólares', () => {
    expect(formatCount(412)).toBe('412');
    expect(formatCount(8_240)).toBe('8.2K');
    expect(formatCount(124_000)).toBe('124K');
    expect(formatCount(2_300_000)).toBe('2.3M');
    expect(formatSeconds(2_100)).toBe('2.1 s');
    expect(formatSeconds(42_000)).toBe('42 s');
    expect(formatSeconds(125_000)).toBe('2 min 05 s');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.031)).toBe('$0.031');
    expect(formatCost(1.274)).toBe('$1.27');
  });
});

describe('turnUsageParts', () => {
  it('pie completo con caché, razonamiento, tiempos y coste', () => {
    const u: UsageView = {
      ...base,
      promptTokens: 8_240,
      completionTokens: 412,
      reasoningTokens: 120,
      cachedReadTokens: 7_170,
      cacheHitRate: 0.87,
      costUsd: 0.004,
    };
    expect(turnUsageParts(u, false)).toEqual([
      '8.2K entrada',
      '87% caché',
      '412 salida (120 razonando)',
      '3 llamadas',
      'LLM 11 s',
      'tools 2.1 s',
      '$0.0040',
    ]);
    expect(turnUsageParts(u, true)).toEqual(['8.2K entrada', '87% caché', '$0.0040']);
  });

  it('sin usage del backend dice n/d, nunca 0', () => {
    expect(turnUsageParts(base, true)).toEqual(['tokens n/d']);
  });

  it('sin dato de caché: caché n/d', () => {
    expect(turnUsageParts({ ...base, promptTokens: 100, completionTokens: 5 }, true)).toEqual([
      '100 entrada',
      'caché n/d',
    ]);
  });

  it('avisa cuando solo algunas llamadas reportaron', () => {
    const parts = turnUsageParts(
      { ...base, reportedCalls: 2, promptTokens: 10, completionTokens: 1 },
      false,
    );
    expect(parts).toContain('2/3 con uso');
  });
});

describe('liveTelemetry', () => {
  it('en vivo: paso y velocidad; uso de la sesión', () => {
    const turn: UsageView = { ...base, llmCalls: 2, outputTokensPerSec: 41.6 };
    const session = {
      ...base,
      turns: 4,
      promptTokens: 12_000,
      completionTokens: 400,
      cacheHitRate: 0.5,
      costUsd: 0.031,
    };
    expect(liveTelemetry(turn, session)).toEqual({
      activity: '⊙ paso 2 · 42 tok/s',
      usage: '⛁ 12K · 50% caché · $0.031',
    });
  });

  it('en reposo: turnos y pasos de la sesión', () => {
    const session = { ...base, turns: 1, llmCalls: 3 };
    expect(liveTelemetry(null, session)).toEqual({
      activity: '⊙ 1 turno · 3 pasos',
      usage: '⛁ n/d',
    });
  });

  it('sin nada aún: nada', () => {
    expect(liveTelemetry(null, null)).toEqual({ activity: null, usage: null });
  });

  it('marca parcial cuando hay consumo sin medir', () => {
    const session = { ...base, turns: 1, promptTokens: 10, completionTokens: 2, incomplete: true };
    expect(liveTelemetry(null, session).usage).toBe('⛁ 12 · caché n/d · parcial');
    expect(turnUsageParts({ ...base, incomplete: true }, true)).toEqual(['tokens n/d', 'parcial']);
  });
});

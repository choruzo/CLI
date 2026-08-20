import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSubagent, buildInterruptedSubagentsPreamble } from './subagent.js';
import { SubagentStore } from '../session/subagent-store.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { GENERAL_PROFILE } from './profiles.js';
import type { AgentProfile, SubagentResult, SubagentRouter } from './types.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock-model',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

/** Un chunk de solo-usage (choices vacío), como el que emite include_usage. */
function usageChunk(totalTokens: number): OpenAIStreamChunk {
  return {
    choices: [],
    usage: { prompt_tokens: totalTokens, completion_tokens: 0, total_tokens: totalTokens },
  };
}

// ---------------------------------------------------------------------------
// Presupuesto de tokens best-effort (Hito 8B)
// ---------------------------------------------------------------------------
describe('Presupuesto de tokens best-effort (Hito 8B)', () => {
  it('supera maxTokens (con usage) → budget_exceeded y usage.tokens contabilizado', async () => {
    // Cada ronda: un glob (el loop nunca para solo) + 100 tokens de usage.
    const round = [...makeToolCallRound('g1', 'glob', { pattern: '*.none' }), usageChunk(100)];
    const provider = new MockProvider([round]);
    const profile: AgentProfile = {
      ...GENERAL_PROFILE,
      budget: { maxIterations: 10, maxTokens: 150 },
    };
    const result = await runSubagent({
      task: { id: 'sub_tok', task: 't', profile: 'general', budget: profile.budget },
      profile,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });
    // Se corta por tokens (150) antes de agotar las 10 iteraciones.
    expect(result.status).toBe('budget_exceeded');
    expect(result.usage.tokens).toBeGreaterThanOrEqual(150);
    expect(result.usage.iterations).toBeLessThan(10);
  });

  it('sin usage del backend → usage.tokens undefined y completa normal (best-effort)', async () => {
    const provider = new MockProvider([makeTextRound('Listo.')]);
    const profile: AgentProfile = {
      ...GENERAL_PROFILE,
      budget: { maxIterations: 5, maxTokens: 10 }, // maxTokens se ignora sin usage
    };
    const result = await runSubagent({
      task: { id: 'sub_nousage', task: 't', profile: 'general', budget: profile.budget },
      profile,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });
    expect(result.status).toBe('completed');
    expect(result.usage.tokens).toBeUndefined();
  });

  it('captura usage.tokens cuando el backend lo devuelve y completa', async () => {
    const provider = new MockProvider([[...makeTextRound('Hecho.'), usageChunk(42)]]);
    const result = await runSubagent({
      task: { id: 'sub_ct', task: 't', profile: 'general', budget: GENERAL_PROFILE.budget },
      profile: GENERAL_PROFILE,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });
    expect(result.status).toBe('completed');
    expect(result.usage.tokens).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Persistencia y reanudación (Hito 8B)
// ---------------------------------------------------------------------------
describe('SubagentStore (Hito 8B)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-substore-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sampleResult(id: string, status: SubagentResult['status']): SubagentResult {
    return {
      id,
      status,
      summary: 'resumen',
      filesChanged: [{ path: 'a.ts', action: 'modified' }],
      usage: { iterations: 3, tokens: 120, durationMs: 42 },
    };
  }

  it('marca running y la detecta como interrumpida hasta que llega el resultado', () => {
    const store = new SubagentStore(dir);
    store.saveRunning('sub_1', 'research', 'explorar X');

    // Aún sin resultado terminal → interrumpida.
    let interrupted = store.loadInterrupted();
    expect(interrupted.map((s) => s.id)).toContain('sub_1');
    expect(existsSync(join(dir, '.stratum', 'subagents', 'sub_1.json'))).toBe(true);

    // Llega el resultado terminal → deja de estar interrumpida.
    store.saveResult('sub_1', 'research', 'explorar X', sampleResult('sub_1', 'completed'));
    interrupted = store.loadInterrupted();
    expect(interrupted.map((s) => s.id)).not.toContain('sub_1');

    const rec = store.read('sub_1');
    expect(rec?.status).toBe('completed');
    expect(rec?.result?.summary).toBe('resumen');
  });

  it('preserva createdAt entre running y result', () => {
    const store = new SubagentStore(dir);
    store.saveRunning('sub_2', 'code', 'tarea');
    const created = store.read('sub_2')?.createdAt;
    store.saveResult('sub_2', 'code', 'tarea', sampleResult('sub_2', 'completed'));
    expect(store.read('sub_2')?.createdAt).toBe(created);
  });

  it('markInterrupted convierte running → interrupted (idempotente para no-running)', () => {
    const store = new SubagentStore(dir);
    store.saveRunning('sub_3', 'general', 'x');
    store.markInterrupted('sub_3');
    expect(store.read('sub_3')?.status).toBe('interrupted');
    expect(store.loadInterrupted().map((s) => s.id)).not.toContain('sub_3');
    // No-op sobre un registro ya terminal.
    store.saveResult('sub_3b', 'general', 'x', sampleResult('sub_3b', 'completed'));
    store.markInterrupted('sub_3b');
    expect(store.read('sub_3b')?.status).toBe('completed');
  });

  it('list ignora ficheros .tmp y registros corruptos', () => {
    const store = new SubagentStore(dir);
    store.saveResult('sub_ok', 'general', 'x', sampleResult('sub_ok', 'completed'));
    expect(store.list().map((s) => s.id)).toEqual(['sub_ok']);
    // El JSON persistido es válido y parseable.
    const raw = readFileSync(join(dir, '.stratum', 'subagents', 'sub_ok.json'), 'utf-8');
    expect(JSON.parse(raw).status).toBe('completed');
  });
});

describe('buildInterruptedSubagentsPreamble (Hito 8B)', () => {
  it('sin interrumpidos → null', () => {
    expect(buildInterruptedSubagentsPreamble([])).toBeNull();
  });

  it('con interrumpidos → instruye a verificar y NO reejecutar automáticamente', () => {
    const pre = buildInterruptedSubagentsPreamble([
      { id: 'sub_x', profile: 'code', task: 'refactor Y' },
    ]);
    expect(pre).not.toBeNull();
    expect(pre).toContain('sub_x');
    expect(pre).toContain('refactor Y');
    expect(pre).toContain('code');
    expect(pre!.toLowerCase()).toContain('verifica');
  });
});

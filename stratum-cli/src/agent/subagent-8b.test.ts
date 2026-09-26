import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runSubagent,
  buildInterruptedSubagentsPreamble,
  planSubagentResume,
  INTERRUPTED_SUBAGENTS_HEADER,
} from './subagent.js';
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

  // Un proceso que lanza el hijo y "muere", y otro que reanuda despues.
  const writerProbe = () => ({ pid: 1111, host: 'h', now: Date.now(), pidAlive: () => true });
  const readerProbe = () => ({ pid: 2222, host: 'h', now: Date.now(), pidAlive: () => false });

  it('marca running y la detecta como interrumpida hasta que llega el resultado', () => {
    const writer = new SubagentStore(dir, { probe: writerProbe });
    const reader = new SubagentStore(dir, { probe: readerProbe });
    writer.saveRunning('sub_1', 'research', 'explorar X', { sessionId: 'sess_a' });
    writer.dispose();

    // Aun sin resultado terminal y con el dueno muerto -> interrumpida.
    let interrupted = reader.findOrphaned('sess_a');
    expect(interrupted.map((s) => s.id)).toContain('sub_1');
    expect(existsSync(join(dir, '.stratum', 'subagents', 'sub_1.json'))).toBe(true);

    // Llega el resultado terminal -> deja de estar interrumpida.
    writer.saveResult('sub_1', 'research', 'explorar X', sampleResult('sub_1', 'completed'));
    interrupted = reader.findOrphaned('sess_a');
    expect(interrupted.map((s) => s.id)).not.toContain('sub_1');

    const rec = reader.read('sub_1');
    expect(rec?.status).toBe('completed');
    expect(rec?.result?.summary).toBe('resumen');
    expect(rec?.sessionId).toBe('sess_a');
  });

  it('preserva createdAt entre running y result', () => {
    const store = new SubagentStore(dir);
    store.saveRunning('sub_2', 'code', 'tarea');
    const created = store.read('sub_2')?.createdAt;
    store.saveResult('sub_2', 'code', 'tarea', sampleResult('sub_2', 'completed'));
    expect(store.read('sub_2')?.createdAt).toBe(created);
  });

  it('markInterrupted convierte running -> interrupted (idempotente para no-running)', () => {
    const writer = new SubagentStore(dir, { probe: writerProbe });
    const reader = new SubagentStore(dir, { probe: readerProbe });
    writer.saveRunning('sub_3', 'general', 'x', { sessionId: 'sess_a' });
    writer.dispose();
    reader.markInterrupted('sub_3');
    expect(reader.read('sub_3')?.status).toBe('interrupted');
    expect(reader.findOrphaned('sess_a').map((s) => s.id)).not.toContain('sub_3');
    // No-op sobre un registro ya terminal.
    reader.saveResult('sub_3b', 'general', 'x', sampleResult('sub_3b', 'completed'));
    reader.markInterrupted('sub_3b');
    expect(reader.read('sub_3b')?.status).toBe('completed');
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

describe('planSubagentResume (8B endurecido)', () => {
  const orphans = [
    { id: 'sub_a', profile: 'code', task: 'tarea A' },
    { id: 'sub_b', profile: 'research', task: 'tarea B' },
  ];

  it('sin huérfanos → nada que avisar', () => {
    const plan = planSubagentResume([], [{ role: 'user', content: 'hola' }]);
    expect(plan).toEqual({ report: [], alreadyReported: [], preamble: null });
  });

  it('avisa solo de los que el historial no conoce', () => {
    const earlier = buildInterruptedSubagentsPreamble([orphans[0]!])!;
    // `chat --resume` concatena el aviso tras el preámbulo del plan.
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `Plan en curso...\n\n${earlier}` },
      { role: 'assistant', content: `Revisando sub_b: ${INTERRUPTED_SUBAGENTS_HEADER}` },
    ];
    const plan = planSubagentResume(orphans, history);
    expect(plan.alreadyReported.map((o) => o.id)).toEqual(['sub_a']);
    expect(plan.report.map((o) => o.id)).toEqual(['sub_b']);
    expect(plan.preamble).toContain('sub_b');
    expect(plan.preamble).not.toContain('sub_a');
  });

  it('todo ya avisado → sin preámbulo', () => {
    const history = [{ role: 'user', content: buildInterruptedSubagentsPreamble(orphans)! }];
    const plan = planSubagentResume(orphans, history);
    expect(plan.preamble).toBeNull();
    expect(plan.alreadyReported).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { compareResults, judge, DEFAULT_THRESHOLDS } from './compare.js';
import type { RunMetrics } from './metrics.js';
import { summarize, type EvalResult, type ScenarioResult } from './result.js';

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  turns: 1,
  durationMs: 10_000,
  llmCalls: 4,
  llmErrors: 0,
  tokens: 10_000,
  promptTokens: 9000,
  completionTokens: 1000,
  toolCalls: 5,
  toolErrors: 0,
  policyBlocks: 0,
  confirmations: { asked: 0, approved: 0, denied: 0, blocked: 0 },
  retries: 0,
  providerFallbacks: 0,
  subagents: 0,
  subagentFailures: 0,
  repeatedCalls: 0,
  warnings: 0,
  fatalErrors: 0,
  compressions: 0,
  stopReason: 'stop',
  hadErrors: false,
  ...over,
});

const scenario = (id: string, over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  id,
  group: 'code',
  title: id,
  status: 'pass',
  checks: [],
  unsafeActions: [],
  metrics: metrics(),
  exitCode: 0,
  wallMs: 1000,
  timedOut: false,
  sessionId: 's',
  trace: `${id}/s.jsonl`,
  ...over,
});

const result = (
  runId: string,
  scenarios: ScenarioResult[],
  over: Partial<EvalResult> = {},
): EvalResult => ({
  schemaVersion: 1,
  kind: 'stratum-eval',
  runId,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  stratumVersion: '0.7.0',
  platform: 'linux',
  node: 'v22.0.0',
  mode: 'live',
  provider: { name: 'p', model: 'm' },
  scenarios,
  summary: summarize(scenarios),
  ...over,
});

describe('judge', () => {
  it('ignora el ruido por debajo del umbral relativo o del mínimo absoluto', () => {
    expect(judge('tokens', 10_000, 11_500, DEFAULT_THRESHOLDS)).toBe('same'); // +15 %
    expect(judge('tokens', 300, 450, DEFAULT_THRESHOLDS)).toBe('same'); // +50 % pero solo 150
    expect(judge('durationMs', 10_000, 14_000, DEFAULT_THRESHOLDS)).toBe('same'); // +40 % < 50 %
  });

  it('marca la regresión y la mejora cuando se supera', () => {
    expect(judge('tokens', 10_000, 13_000, DEFAULT_THRESHOLDS)).toBe('regression');
    expect(judge('tokens', 10_000, 7000, DEFAULT_THRESHOLDS)).toBe('improvement');
    expect(judge('durationMs', 10_000, 16_000, DEFAULT_THRESHOLDS)).toBe('regression');
    expect(judge('toolCalls', 5, 7, DEFAULT_THRESHOLDS)).toBe('regression');
  });

  it('los contadores de fallos no tienen umbral: uno más es uno más', () => {
    expect(judge('toolErrors', 0, 1, DEFAULT_THRESHOLDS)).toBe('regression');
    expect(judge('repeatedCalls', 10, 11, DEFAULT_THRESHOLDS)).toBe('regression');
    expect(judge('retries', 2, 1, DEFAULT_THRESHOLDS)).toBe('improvement');
  });
});

describe('compareResults', () => {
  it('detecta regresiones aunque las dos ejecuciones den PASS', () => {
    const base = result('a', [scenario('s1'), scenario('s2')]);
    const head = result('b', [
      scenario('s1', { metrics: metrics({ tokens: 14_000, toolCalls: 8, toolErrors: 2 }) }),
      scenario('s2'),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('regression');
    expect(cmp.regressions).toBe(1);
    const s1 = cmp.scenarios.find((s) => s.id === 's1')!;
    expect(s1.base).toBe('pass');
    expect(s1.head).toBe('pass');
    expect(s1.changes.map((c) => c.metric).sort()).toEqual(['tokens', 'toolCalls', 'toolErrors']);
    expect(cmp.scenarios.find((s) => s.id === 's2')!.verdict).toBe('same');
  });

  it('dos ejecuciones idénticas no cambian', () => {
    const cmp = compareResults(result('a', [scenario('s1')]), result('b', [scenario('s1')]));
    expect(cmp.verdict).toBe('same');
    expect(cmp.scenarios[0]!.changes).toEqual([]);
  });

  it('pass → fail es regresión y fail → pass mejora, sin mirar el coste', () => {
    const base = result('a', [scenario('s1'), scenario('s2', { status: 'fail' })]);
    const head = result('b', [
      scenario('s1', { status: 'fail', metrics: metrics({ tokens: 100 }) }),
      scenario('s2', { metrics: metrics({ tokens: 90_000 }) }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.scenarios.map((s) => s.verdict)).toEqual(['regression', 'improvement']);
    expect(cmp.verdict).toBe('regression');
  });

  it('entre dos FAIL gastar menos no cuenta como mejora', () => {
    const base = result('a', [scenario('s1', { status: 'fail' })]);
    const head = result('b', [
      scenario('s1', { status: 'fail', metrics: metrics({ tokens: 10 }) }),
    ]);
    expect(compareResults(base, head).verdict).toBe('same');
  });

  it('una acción insegura nueva es regresión aunque el estado no cambie', () => {
    const unsafe = [{ rule: 'rm', tool: 'exec', step: 3, input: '{}' }];
    const base = result('a', [scenario('s1', { status: 'fail' })]);
    const head = result('b', [scenario('s1', { status: 'fail', unsafeActions: unsafe })]);
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('regression');
    expect(cmp.scenarios[0]!.changes[0]).toMatchObject({
      metric: 'unsafeActions',
      base: 0,
      head: 1,
    });
  });

  it('no compara un dato que una de las dos trazas no tiene', () => {
    const base = result('a', [scenario('s1', { metrics: metrics({ tokens: null }) })]);
    const head = result('b', [scenario('s1', { metrics: metrics({ tokens: 50_000 }) })]);
    expect(compareResults(base, head).verdict).toBe('same');
  });

  it('escenarios que solo están en una ejecución, o en skip, no puntúan', () => {
    const base = result('a', [scenario('s1'), scenario('s2', { status: 'skip', metrics: null })]);
    const head = result('b', [scenario('s2'), scenario('s3')]);
    const cmp = compareResults(base, head);
    expect(Object.fromEntries(cmp.scenarios.map((s) => [s.id, s.verdict]))).toEqual({
      s1: 'removed',
      s2: 'added',
      s3: 'added',
    });
    expect(cmp.verdict).toBe('same');
  });

  it('avisa cuando lo que cambia es el modelo o el modo, no Stratum', () => {
    const base = result('a', [scenario('s1')]);
    const other = result('b', [scenario('s1')], { provider: { name: 'p', model: 'otro' } });
    expect(compareResults(base, other).notes[0]).toContain('Modelos distintos');
    const mock = result('c', [scenario('s1')], { mode: 'mock' });
    expect(compareResults(base, mock).notes[0]).toContain('Modos distintos');
  });

  it('el umbral es configurable', () => {
    const base = result('a', [scenario('s1')]);
    const head = result('b', [scenario('s1', { metrics: metrics({ tokens: 11_000 }) })]);
    expect(compareResults(base, head).verdict).toBe('same');
    expect(compareResults(base, head, { relative: 0.05, timeRelative: 0.5 }).verdict).toBe(
      'regression',
    );
  });
});

describe('summarize', () => {
  it('deriva las tasas agregadas y por grupo', () => {
    const results = [
      scenario('a', { metrics: metrics({ toolCalls: 4, toolErrors: 1, hadErrors: true }) }),
      scenario('b', {
        status: 'fail',
        metrics: metrics({ toolCalls: 6, toolErrors: 2, hadErrors: true }),
      }),
      scenario('c', {
        group: 'safety',
        status: 'fail',
        unsafeActions: [{ rule: 'r', tool: 'exec', step: 1, input: '{}' }],
        metrics: metrics({ toolCalls: 2, policyBlocks: 1 }),
      }),
      scenario('d', { group: 'linux', status: 'skip', metrics: null }),
    ];
    const s = summarize(results);
    expect(s.overall).toMatchObject({ total: 4, passed: 1, failed: 2, skipped: 1 });
    expect(s.overall.successRate).toBeCloseTo(1 / 3);
    expect(s.overall.toolErrorRate).toBeCloseTo(3 / 12);
    expect(s.overall.policyViolationRate).toBeCloseTo(1 / 12);
    expect(s.overall.unsafeActionRate).toBeCloseTo(1 / 3);
    expect(s.overall.recovery).toEqual({ withErrors: 2, recovered: 1, rate: 0.5 });
    // «Hasta el éxito» solo mira las ejecuciones en PASS.
    expect(s.overall.toSuccess.toolCalls).toEqual({ mean: 4, median: 4 });
    expect(s.groups.safety?.successRate).toBe(0);
    expect(s.groups.linux?.successRate).toBeNull();
  });
});

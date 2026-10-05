import { describe, expect, it } from 'vitest';
import {
  compareResults,
  defaultTolerances,
  judge,
  LIVE_TOLERANCES,
  mergeTolerances,
  MOCK_TOLERANCES,
  parseToleranceObject,
  parseToleranceSpec,
  ToleranceError,
} from './compare.js';
import type { RunMetrics } from './metrics.js';
import { formatComparison } from './report.js';
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
  difficulty: 'basic',
  title: id,
  scenarioHash: `hash-${id}`,
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
  // Con guion las tolerancias son las estrictas: los tests de clasificación no
  // dependen de la holgura que se le da a un modelo real.
  mode: 'mock',
  provider: { name: 'mock', model: 'eval-mock' },
  scenarios,
  summary: summarize(scenarios),
  ...over,
});

const unsafe = [{ rule: 'rm', tool: 'exec', step: 3, input: '{}' }];

describe('judge: un cambio cuenta si supera el absoluto Y el relativo', () => {
  const tokens = MOCK_TOLERANCES.tokens; // 20 % y 200
  it('ignora lo que no supera las dos cotas', () => {
    expect(judge(10_000, 11_500, tokens)).toBe('same'); // +15 %
    expect(judge(300, 450, tokens)).toBe('same'); // +50 %, pero solo 150
    expect(judge(10_000, 12_000, tokens)).toBe('same'); // justo en el 20 %: tolerado
    expect(judge(1000, 1200, { pct: 0, abs: 200 })).toBe('same'); // justo en el absoluto
  });

  it('marca regresión y mejora cuando se supera', () => {
    expect(judge(10_000, 13_000, tokens)).toBe('regression');
    expect(judge(10_000, 7000, tokens)).toBe('improvement');
    expect(judge(10_000, 16_000, MOCK_TOLERANCES.durationMs)).toBe('regression');
    expect(judge(5, 7, MOCK_TOLERANCES.toolCalls)).toBe('regression');
  });

  it('sin margen, uno más es uno más', () => {
    expect(judge(0, 1, MOCK_TOLERANCES.toolErrors)).toBe('regression');
    expect(judge(10, 11, MOCK_TOLERANCES.repeatedCalls)).toBe('regression');
    expect(judge(2, 1, MOCK_TOLERANCES.retries)).toBe('improvement');
    expect(judge(3, 3, MOCK_TOLERANCES.toolErrors)).toBe('same');
  });

  it('con base 0 no hay relativo: decide el absoluto', () => {
    expect(judge(0, 1, { pct: 0.5, abs: 1 })).toBe('same');
    expect(judge(0, 2, { pct: 0.5, abs: 1 })).toBe('regression');
    expect(judge(0, 150, tokens)).toBe('same');
    expect(judge(0, 500, tokens)).toBe('regression');
  });

  it('solo absoluto o solo porcentaje también valen', () => {
    expect(judge(4, 5, { pct: 0, abs: 1 })).toBe('same');
    expect(judge(4, 6, { pct: 0, abs: 1 })).toBe('regression');
    expect(judge(100, 129, { pct: 0.3, abs: 0 })).toBe('same');
    expect(judge(100, 131, { pct: 0.3, abs: 0 })).toBe('regression');
  });
});

describe('tolerancias', () => {
  it('parseToleranceSpec: porcentaje, absoluto, los dos, unidades y alias', () => {
    expect(parseToleranceSpec('tokens=30%')).toEqual({ tokens: { pct: 0.3 } });
    expect(parseToleranceSpec('tokens=500')).toEqual({ tokens: { abs: 500 } });
    expect(parseToleranceSpec('tokens=30%,2k')).toEqual({ tokens: { pct: 0.3, abs: 2000 } });
    expect(parseToleranceSpec('duration=100%,10s')).toEqual({
      durationMs: { pct: 1, abs: 10_000 },
    });
    expect(parseToleranceSpec('durationMs=750ms')).toEqual({ durationMs: { abs: 750 } });
    expect(parseToleranceSpec('toolErrors=1 retries=2;tools=25%')).toEqual({
      toolErrors: { abs: 1 },
      retries: { abs: 2 },
      toolCalls: { pct: 0.25 },
    });
    expect(parseToleranceSpec('TOOLCALLS=1')).toEqual({ toolCalls: { abs: 1 } });
  });

  it('parseToleranceSpec rechaza lo que no entiende', () => {
    for (const bad of [
      'tokens',
      'tokens=',
      'latency=10%',
      'tokens=abc',
      'tokens=5s',
      'tokens=-3%',
    ]) {
      expect(() => parseToleranceSpec(bad), bad).toThrow(ToleranceError);
    }
  });

  it('parseToleranceObject valida un fichero de tolerancias', () => {
    expect(parseToleranceObject({ tokens: { pct: 0.3, abs: 500 }, retries: { abs: 2 } })).toEqual({
      tokens: { pct: 0.3, abs: 500 },
      retries: { abs: 2 },
    });
    for (const bad of [[], 'x', { latency: { pct: 1 } }, { tokens: 5 }, { tokens: { pct: -1 } }]) {
      expect(() => parseToleranceObject(bad)).toThrow(ToleranceError);
    }
    expect(() => parseToleranceObject({ tokens: { percent: 1 } })).toThrow(/clave desconocida/);
  });

  it('las capas se fusionan por campo y las posteriores ganan', () => {
    const merged = mergeTolerances(MOCK_TOLERANCES, { tokens: { pct: 0.5 } }, undefined, {
      tokens: { abs: 50 },
      toolErrors: { abs: 1 },
    });
    expect(merged.tokens).toEqual({ pct: 0.5, abs: 50 });
    expect(merged.toolErrors).toEqual({ pct: 0, abs: 1 });
    expect(merged.durationMs).toEqual(MOCK_TOLERANCES.durationMs);
    expect(MOCK_TOLERANCES.tokens).toEqual({ pct: 0.2, abs: 200 }); // no muta la base
  });

  it('basta con que una de las dos ejecuciones sea live para usar las holgadas', () => {
    expect(defaultTolerances('mock', 'mock')).toBe(MOCK_TOLERANCES);
    expect(defaultTolerances('live', 'live')).toBe(LIVE_TOLERANCES);
    expect(defaultTolerances('mock', 'live')).toBe(LIVE_TOLERANCES);
  });

  it('en live un bloqueo de política de más es ruido; dos, no', () => {
    const live = { mode: 'live' as const, provider: { name: 'p', model: 'm' } };
    const base = result('a', [scenario('s1')], live);
    const blocks = (n: number): EvalResult =>
      result('b', [scenario('s1', { metrics: metrics({ policyBlocks: n }) })], live);
    expect(compareResults(base, blocks(1)).verdict).toBe('same');
    const two = compareResults(base, blocks(2));
    expect(two.verdict).toBe('regression');
    expect(two.highlights.morePolicyBlocks).toEqual(['s1']);
    // Un subagente que falla no tiene margen en ningún modo.
    expect(LIVE_TOLERANCES.subagentFailures).toEqual({ pct: 0, abs: 0 });
  });

  it('en live una acción insegura nueva no tiene tolerancia posible', () => {
    const live = { mode: 'live' as const, provider: { name: 'p', model: 'm' } };
    const cmp = compareResults(
      result('a', [scenario('s1')], live),
      result('b', [scenario('s1', { unsafeActions: unsafe })], live),
      { policyBlocks: { abs: 99 }, toolErrors: { abs: 99 } },
    );
    expect(cmp.verdict).toBe('regression');
    expect(cmp.highlights.newUnsafeActions).toEqual(['s1']);
  });

  it('en live sí se marca un coste de otro orden', () => {
    const live = { mode: 'live' as const, provider: { name: 'p', model: 'm' } };
    const base = result('a', [scenario('s1', { metrics: metrics({ tokens: 20_000 }) })], live);
    const head = result(
      'b',
      [scenario('s1', { metrics: metrics({ tokens: 70_000, llmCalls: 12, toolCalls: 15 }) })],
      live,
    );
    const cmp = compareResults(base, head);
    expect(cmp.highlights.costRegressions).toEqual(['s1']);
    expect(cmp.scenarios[0]!.changes.map((c) => c.metric)).toEqual([
      'tokens',
      'llmCalls',
      'toolCalls',
    ]);
  });

  it('el ruido de un modelo real no es regresión; el mismo cambio con guion sí', () => {
    const noisy = metrics({
      tokens: 14_000,
      toolCalls: 7,
      llmCalls: 5,
      toolErrors: 1,
      retries: 1,
      durationMs: 19_000,
    });
    const live = { mode: 'live' as const, provider: { name: 'p', model: 'm' } };
    const base = [scenario('s1')];
    const head = [scenario('s1', { metrics: noisy })];
    expect(compareResults(result('a', base, live), result('b', head, live)).verdict).toBe('same');
    const strict = compareResults(result('a', base), result('b', head));
    expect(strict.verdict).toBe('regression');
    expect(strict.scenarios[0]!.changes.map((c) => c.metric).sort()).toEqual([
      'durationMs',
      'llmCalls',
      'retries',
      'tokens',
      'toolCalls',
      'toolErrors',
    ]);
  });

  it('precedencia: modo < baseline < lo pedido en la comparación', () => {
    const head = result('b', [scenario('s1', { metrics: metrics({ tokens: 14_000 }) })]);
    const plain = result('a', [scenario('s1')]);
    expect(compareResults(plain, head).verdict).toBe('regression');

    const baseline = result('a', [scenario('s1')], {
      baseline: {
        name: 'ref',
        savedAt: '2026-01-02T00:00:00.000Z',
        runId: 'a',
        tolerances: { tokens: { pct: 0.5 } },
      },
    });
    const viaBaseline = compareResults(baseline, head);
    expect(viaBaseline.verdict).toBe('same');
    expect(viaBaseline.tolerances.tokens).toEqual({ pct: 0.5, abs: 200 });
    expect(viaBaseline.base.baseline).toBe('ref');

    expect(compareResults(baseline, head, { tokens: { pct: 0.1 } }).verdict).toBe('regression');
  });
});

describe('compareResults: clasificación', () => {
  it('detecta regresiones aunque las dos ejecuciones den PASS, y las separa por clase', () => {
    const base = result('a', [scenario('s1'), scenario('s2'), scenario('s3')]);
    const head = result('b', [
      scenario('s1', { metrics: metrics({ tokens: 14_000, toolCalls: 8 }) }),
      scenario('s2', { metrics: metrics({ toolErrors: 2, retries: 1 }) }),
      scenario('s3'),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('regression');
    expect(cmp.regressions).toBe(2);
    expect(cmp.highlights.costRegressions).toEqual(['s1']);
    expect(cmp.highlights.reliabilityRegressions).toEqual(['s2']);
    const s1 = cmp.scenarios.find((s) => s.id === 's1')!;
    expect(s1).toMatchObject({ base: 'pass', head: 'pass', transition: null });
    expect(s1.changes.map((c) => [c.metric, c.category])).toEqual([
      ['tokens', 'cost'],
      ['toolCalls', 'cost'],
    ]);
    expect(cmp.scenarios.find((s) => s.id === 's3')!.verdict).toBe('same');
  });

  it('dos ejecuciones idénticas no cambian', () => {
    const cmp = compareResults(result('a', [scenario('s1')]), result('b', [scenario('s1')]));
    expect(cmp.verdict).toBe('same');
    expect(cmp.scenarios[0]!.changes).toEqual([]);
    expect(Object.values(cmp.highlights).flat()).toEqual([]);
  });

  it('cada cambio de estado tiene su transición y su veredicto', () => {
    const base = result('a', [
      scenario('p2f'),
      scenario('p2e'),
      scenario('f2p', { status: 'fail' }),
      scenario('e2p', { status: 'error', metrics: null }),
      scenario('f2e', { status: 'fail' }),
      scenario('e2f', { status: 'error', metrics: null }),
      scenario('f2f', { status: 'fail' }),
    ]);
    const head = result('b', [
      scenario('p2f', {
        status: 'fail',
        reason: 'out.txt no existe',
        metrics: metrics({ tokens: 1 }),
      }),
      scenario('p2e', { status: 'error', reason: 'el modelo no respondió: 429', metrics: null }),
      scenario('f2p', { metrics: metrics({ tokens: 90_000 }) }),
      scenario('e2p'),
      scenario('f2e', { status: 'error', metrics: null }),
      scenario('e2f', { status: 'fail' }),
      scenario('f2f', { status: 'fail', metrics: metrics({ tokens: 10 }) }),
    ]);
    const cmp = compareResults(base, head);
    const by = Object.fromEntries(cmp.scenarios.map((s) => [s.id, s]));
    expect(by.p2f).toMatchObject({ transition: 'pass_to_fail', verdict: 'regression' });
    expect(by.p2f!.reason).toBe('out.txt no existe');
    expect(by.p2e).toMatchObject({ transition: 'pass_to_error', verdict: 'regression' });
    expect(by.f2p).toMatchObject({ transition: 'fail_to_pass', verdict: 'improvement' });
    expect(by.e2p).toMatchObject({ transition: 'error_to_pass', verdict: 'improvement' });
    // Ni pasaba ni pasa: no es regresión ni mejora, pero se lista aparte.
    expect(by.f2e).toMatchObject({ transition: 'unresolved', verdict: 'same' });
    expect(by.e2f).toMatchObject({ transition: 'unresolved', verdict: 'same' });
    // Entre dos FAIL gastar menos no cuenta como mejora.
    expect(by.f2f).toMatchObject({ transition: null, verdict: 'same', changes: [] });
    // Un cambio de estado no arrastra además una «regresión de coste».
    expect(by.p2f!.changes).toEqual([]);

    expect(cmp.highlights).toMatchObject({
      passToFail: ['p2f'],
      passToError: ['p2e'],
      improvements: ['f2p', 'e2p'],
      unresolved: ['f2e', 'e2f'],
      costRegressions: [],
    });
    expect(cmp.verdict).toBe('regression');
    expect(cmp.regressions).toBe(2);
    expect(cmp.improvements).toBe(2);
  });

  it('una acción insegura nueva es regresión con cualquier estado', () => {
    const base = result('a', [
      scenario('ff', { status: 'fail' }),
      scenario('pf'),
      scenario('fp', { status: 'fail' }),
    ]);
    const head = result('b', [
      scenario('ff', { status: 'fail', unsafeActions: unsafe }),
      scenario('pf', { status: 'fail', unsafeActions: unsafe }),
      // Mejora de estado, pero con una acción insegura que antes no había.
      scenario('fp', { unsafeActions: unsafe }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.highlights.newUnsafeActions).toEqual(['ff', 'pf', 'fp']);
    expect(cmp.highlights.passToFail).toEqual(['pf']);
    expect(cmp.scenarios.map((s) => s.verdict)).toEqual(['regression', 'regression', 'regression']);
    expect(cmp.scenarios[0]!.changes[0]).toMatchObject({
      metric: 'unsafeActions',
      category: 'safety',
      base: 0,
      head: 1,
    });
  });

  it('una acción insegura que desaparece es una mejora', () => {
    const base = result('a', [scenario('s1', { status: 'fail', unsafeActions: unsafe })]);
    const head = result('b', [scenario('s1', { status: 'fail' })]);
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('improvement');
    expect(cmp.highlights.newUnsafeActions).toEqual([]);
  });

  it('más bloqueos de política se destacan aparte, también entre dos FAIL', () => {
    const base = result('a', [scenario('pp'), scenario('ff', { status: 'fail' })]);
    const head = result('b', [
      scenario('pp', { metrics: metrics({ policyBlocks: 1 }) }),
      scenario('ff', { status: 'fail', metrics: metrics({ policyBlocks: 2, tokens: 99_000 }) }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.highlights.morePolicyBlocks).toEqual(['pp', 'ff']);
    expect(cmp.highlights.costRegressions).toEqual([]);
    expect(cmp.scenarios[1]!.changes.map((c) => c.metric)).toEqual(['policyBlocks']);
    // Y se puede tolerar explícitamente.
    expect(compareResults(base, head, { policyBlocks: { abs: 2 } }).verdict).toBe('same');
  });

  it('las mejoras de coste se recogen como mejoras', () => {
    const base = result('a', [scenario('s1')]);
    const head = result('b', [
      scenario('s1', { metrics: metrics({ tokens: 6000, toolCalls: 3 }) }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('improvement');
    expect(cmp.highlights.improvements).toEqual(['s1']);
    expect(cmp.scenarios[0]!.changes.every((c) => c.verdict === 'improvement')).toBe(true);
  });

  it('una regresión pesa más que una mejora en el mismo escenario', () => {
    const base = result('a', [scenario('s1')]);
    const head = result('b', [
      scenario('s1', { metrics: metrics({ tokens: 5000, toolErrors: 1 }) }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.scenarios[0]!.verdict).toBe('regression');
    expect(cmp.highlights.improvements).toEqual([]);
  });

  it('no compara un dato que una de las dos trazas no tiene', () => {
    const base = result('a', [
      scenario('s1', { metrics: metrics({ tokens: null, retries: null }) }),
    ]);
    const head = result('b', [
      scenario('s1', { metrics: metrics({ tokens: 50_000, retries: 4 }) }),
    ]);
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
    expect(cmp.highlights.added).toEqual(['s2', 's3']);
    expect(cmp.highlights.removed).toEqual(['s1']);
    expect(cmp.verdict).toBe('same');
  });

  it('un escenario cuya definición cambió compara el estado, no el coste', () => {
    const base = result('a', [scenario('s1'), scenario('s2')]);
    const head = result('b', [
      scenario('s1', { scenarioHash: 'otra', metrics: metrics({ tokens: 90_000, toolErrors: 3 }) }),
      scenario('s2', { scenarioHash: 'otra', status: 'fail' }),
    ]);
    const cmp = compareResults(base, head);
    expect(cmp.scenarios[0]).toMatchObject({
      definitionChanged: true,
      verdict: 'same',
      changes: [],
    });
    expect(cmp.scenarios[1]).toMatchObject({ definitionChanged: true, verdict: 'regression' });
    expect(cmp.notes.join(' ')).toContain('2 escenario(s) cambiaron de definición');
  });

  it('un resultado antiguo sin huella ni dificultad se compara como siempre', () => {
    const old = scenario('s1', { metrics: metrics({ tokens: 14_000 }) });
    delete old.scenarioHash;
    delete old.difficulty;
    const cmp = compareResults(result('a', [scenario('s1')]), result('b', [old]));
    expect(cmp.scenarios[0]).toMatchObject({ definitionChanged: false, verdict: 'regression' });
  });

  it('entre modos distintos no se compara el coste, pero sí estado y seguridad', () => {
    const base = result('a', [scenario('s1'), scenario('s2'), scenario('s3')]);
    const head = result(
      'b',
      [
        scenario('s1', { metrics: metrics({ tokens: 90_000, toolCalls: 30, toolErrors: 4 }) }),
        scenario('s2', { status: 'fail' }),
        scenario('s3', { metrics: metrics({ policyBlocks: 2 }) }),
      ],
      { mode: 'live', provider: { name: 'p', model: 'm' } },
    );
    const cmp = compareResults(base, head);
    expect(cmp.notes[0]).toContain('Modos distintos');
    expect(cmp.scenarios.map((s) => s.verdict)).toEqual(['same', 'regression', 'regression']);
    expect(cmp.highlights.morePolicyBlocks).toEqual(['s3']);
  });

  it('avisa cuando lo que cambia es el modelo, la plataforma o hay errores del banco', () => {
    const live = { mode: 'live' as const, provider: { name: 'p', model: 'm' } };
    const base = result('a', [scenario('s1')], live);
    const other = result('b', [scenario('s1')], {
      ...live,
      provider: { name: 'p', model: 'otro' },
      platform: 'win32',
    });
    const notes = compareResults(base, other).notes;
    expect(notes[0]).toContain('Modelos distintos');
    expect(notes[1]).toContain('Plataformas distintas');

    const errored = result('c', [scenario('s1', { status: 'error', metrics: null })], live);
    expect(compareResults(base, errored).notes.join(' ')).toContain('repite la ejecución');
  });

  it('resume el éxito por dificultad en las dos ejecuciones', () => {
    const base = result('a', [
      scenario('b1'),
      scenario('a1', { difficulty: 'adversarial' }),
      scenario('a2', { difficulty: 'adversarial', status: 'fail' }),
    ]);
    const head = result('b', [
      scenario('b1'),
      scenario('a1', { difficulty: 'adversarial', status: 'fail' }),
      scenario('a2', { difficulty: 'adversarial', status: 'fail' }),
    ]);
    expect(compareResults(base, head).difficulties).toEqual([
      { difficulty: 'basic', base: { passed: 1, ran: 1 }, head: { passed: 1, ran: 1 } },
      { difficulty: 'adversarial', base: { passed: 1, ran: 2 }, head: { passed: 0, ran: 2 } },
    ]);
  });
});

describe('formatComparison', () => {
  it('destaca cada clase de hallazgo en su bloque, por orden de gravedad', () => {
    const base = result('a', [
      scenario('se-rompe'),
      scenario('provider-cae'),
      scenario('inseguro', { status: 'fail' }),
      scenario('mas-bloqueos'),
      scenario('mas-caro'),
      scenario('mas-errores'),
      scenario('arreglado', { status: 'fail' }),
      scenario('mas-barato'),
      scenario('igual'),
    ]);
    const head = result(
      'b',
      [
        scenario('se-rompe', { status: 'fail', reason: 'out.txt no existe' }),
        scenario('provider-cae', {
          status: 'error',
          reason: 'el modelo no respondió',
          metrics: null,
        }),
        scenario('inseguro', { status: 'fail', unsafeActions: unsafe }),
        scenario('mas-bloqueos', { metrics: metrics({ policyBlocks: 2 }) }),
        scenario('mas-caro', { metrics: metrics({ tokens: 20_000, durationMs: 40_000 }) }),
        scenario('mas-errores', { metrics: metrics({ toolErrors: 2 }) }),
        scenario('arreglado'),
        scenario('mas-barato', { metrics: metrics({ tokens: 5000 }) }),
        scenario('igual'),
      ],
      {
        env: {
          os: { platform: 'linux', release: '6.8', arch: 'x64' },
          git: { commit: 'abc123def456', branch: 'main', dirty: true },
        },
      },
    );
    const text = formatComparison(compareResults(base, head));
    const order = [
      'PASS → FAIL (1)',
      'PASS → ERROR (1)',
      'Nuevas acciones inseguras (1)',
      'Más bloqueos de política (1)',
      'Regresiones de coste (tokens, tiempo, llamadas) (1)',
      'Regresiones de fiabilidad (errores, reintentos, repeticiones) (1)',
      'Mejoras (2)',
      'Éxito por dificultad',
      'Métricas agregadas',
      'Tolerancias:',
    ];
    const positions = order.map((title) => text.indexOf(title));
    expect(
      positions.every((p) => p >= 0),
      text,
    ).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(text).toContain('out.txt no existe');
    expect(text).toContain('tokens 10.0K → 20.0K (+100 %)');
    expect(text).toContain('FAIL → PASS');
    expect(text).toContain('abc123def456+');
    expect(text).toContain('6 regresiones, 2 mejoras, 1 sin cambios');
    expect(text).toContain('policyBlocks sin margen');
  });

  it('sin hallazgos lo dice en una línea', () => {
    const text = formatComparison(
      compareResults(result('a', [scenario('s1')]), result('b', [scenario('s1')])),
    );
    expect(text).toContain('Sin cambios por escenario por encima de las tolerancias.');
    expect(text).toContain('0 regresiones, 0 mejoras, 1 sin cambios');
  });
});

describe('summarize', () => {
  it('deriva las tasas agregadas, por grupo y por dificultad', () => {
    const results = [
      scenario('a', { metrics: metrics({ toolCalls: 4, toolErrors: 1, hadErrors: true }) }),
      scenario('b', {
        status: 'fail',
        difficulty: 'intermediate',
        metrics: metrics({ toolCalls: 6, toolErrors: 2, hadErrors: true }),
      }),
      scenario('c', {
        group: 'safety',
        difficulty: 'adversarial',
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
    expect(s.difficulties?.basic).toMatchObject({ total: 2, passed: 1, skipped: 1 });
    expect(s.difficulties?.intermediate?.successRate).toBe(0);
    expect(s.difficulties?.adversarial).toMatchObject({ failed: 1, unsafeActions: 1 });
  });
});

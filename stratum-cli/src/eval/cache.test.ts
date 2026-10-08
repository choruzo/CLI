import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { TraceRecord } from '../trace/records.js';
import { evaluateChecks } from './checks.js';
import {
  compareResults,
  judge,
  LIVE_TOLERANCES,
  MOCK_TOLERANCES,
  parseToleranceSpec,
} from './compare.js';
import { buildTraceModel, computeMetrics, COMPARABLE_METRICS, type RunMetrics } from './metrics.js';
import {
  cachedPrefixLength,
  commonPrefixLength,
  renderPromptForCache,
  startMockLlm,
} from './mock-llm.js';
import { formatComparison, formatEvalReport, formatStats } from './report.js';
import { summarize, summarizeGroup, type EvalResult, type ScenarioResult } from './result.js';
import {
  bundledScenariosDir,
  liveTrajectoryChecks,
  loadScenarios,
  parseScenario,
  scenarioFingerprint,
} from './scenario.js';
import { aggregateStats } from './stats.js';

// ---------------------------------------------------------------------------
// Trazas sintéticas
// ---------------------------------------------------------------------------

interface Call {
  /** [prompt, cachedRead]; sin el segundo, el backend no reporta caché. */
  usage?: [number, number?];
  ttft?: number;
  prefix?: Record<string, unknown>;
  model?: string;
  provider?: string;
  error?: boolean;
  compressedBefore?: boolean;
}

function traceOf(calls: Call[], sessionId = 's1'): TraceRecord[] {
  const records: TraceRecord[] = [{ t: 'meta', v: 1, at: 0, sessionId, caps: ['runtime'] }];
  let at = 1000;
  records.push({ t: 'turn', at, input: 'tarea' });
  calls.forEach((c, i) => {
    const id = `${sessionId}-m${i}`;
    if (c.compressedBefore) {
      records.push({
        t: 'point',
        at: ++at,
        id: `${sessionId}-c${i}`,
        kind: 'context',
        name: 'Contexto comprimido',
      });
    }
    records.push({
      t: 'begin',
      at: (at += 10),
      id,
      kind: 'model',
      name: c.model ?? 'test-model',
      data: {
        ...(c.provider ? { provider: c.provider } : {}),
        ...(c.prefix ? { prefix: c.prefix } : {}),
      },
    });
    if (c.ttft !== undefined) records.push({ t: 'mark', at: at + c.ttft, id, name: 'first_token' });
    records.push({
      t: 'end',
      at: (at += (c.ttft ?? 0) + 50),
      id,
      status: c.error ? 'error' : 'ok',
      data: c.usage
        ? {
            usage: {
              promptTokens: c.usage[0],
              completionTokens: 10,
              totalTokens: c.usage[0] + 10,
              ...(c.usage[1] !== undefined ? { cachedReadTokens: c.usage[1] } : {}),
            },
          }
        : {},
    });
  });
  records.push({ t: 'turn_end', at: ++at, stopReason: 'stop' });
  return records;
}

const prefix = (chars: number, sharedChars?: number, more: Record<string, unknown> = {}) => ({
  chars,
  tools: 'aaaaaaaa',
  system: 'bbbbbbbb',
  ...(sharedChars !== undefined ? { sharedChars, prevMessages: 2 } : {}),
  ...more,
});

const WARM_LOOP: Call[] = [
  { usage: [1000, 0], ttft: 300, prefix: prefix(4000) },
  { usage: [1200, 1000], ttft: 20, prefix: prefix(4800, 4000) },
  { usage: [1400, 1200], ttft: 40, prefix: prefix(5600, 4800) },
];

describe('computeMetrics — caché', () => {
  it('acierto, tokens, llamadas frías y templadas y TTFT de cada clase', () => {
    expect(computeMetrics(traceOf(WARM_LOOP))).toMatchObject({
      cacheReportedCalls: 3,
      cachedReadTokens: 2200,
      cacheWriteTokens: null,
      uncachedPromptTokens: 1400,
      cacheHitRate: 2200 / 3600,
      coldCalls: 1,
      warmCalls: 2,
      cacheBreaks: 0,
      ttftColdMs: 300,
      ttftWarmMs: 30,
      ttftMs: 120,
      prefixStability: 8800 / 10400,
    });
  });

  it('un backend que no reporta caché deja null, y no se rellena con ceros', () => {
    const m = computeMetrics(traceOf([{ usage: [1000] }, { usage: [1200] }]));
    expect(m).toMatchObject({
      tokens: 2220,
      cacheReportedCalls: 0,
      cachedReadTokens: null,
      uncachedPromptTokens: null,
      cacheHitRate: null,
      coldCalls: null,
      warmCalls: null,
      cacheBreaks: null,
      ttftColdMs: null,
      ttftWarmMs: null,
      prefixStability: null,
    });
  });

  it('una traza anterior (campo cachedTokens, sin prefix) se sigue midiendo', () => {
    const records = traceOf([{ usage: [1000] }, { usage: [1200] }]);
    for (const r of records) {
      if (r.t === 'end' && r.data?.usage) {
        (r.data.usage as Record<string, unknown>).cachedTokens = 600;
      }
    }
    expect(computeMetrics(records)).toMatchObject({
      cachedReadTokens: 1200,
      cacheHitRate: 1200 / 2200,
      warmCalls: 2,
      prefixStability: null,
    });
  });

  it('un fallo de caché no es un error del agente', () => {
    const cold: Call[] = [
      { usage: [1000, 0], prefix: prefix(4000) },
      { usage: [1200, 1000], prefix: prefix(4800, 4000) },
      { usage: [1400, 0], prefix: prefix(5600, 4800) },
    ];
    const m = computeMetrics(traceOf(cold));
    expect(m.cacheBreaks).toBe(1);
    expect(m.coldCalls).toBe(2);
    expect(m).toMatchObject({
      hadErrors: false,
      toolErrors: 0,
      llmErrors: 0,
      warnings: 0,
      fatalErrors: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------

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
  cacheReportedCalls: 4,
  cachedReadTokens: 6300,
  cacheWriteTokens: null,
  uncachedPromptTokens: 2700,
  cacheHitRate: 0.7,
  coldCalls: 1,
  warmCalls: 3,
  cacheBreaks: 0,
  ttftMs: 100,
  ttftColdMs: 300,
  ttftWarmMs: 30,
  prefixStability: 0.97,
  ...over,
});

/** Métricas como las de un `result.json` anterior a las de caché. */
function legacyMetrics(): RunMetrics {
  const m = metrics() as unknown as Record<string, unknown>;
  for (const key of [
    'cacheReportedCalls',
    'cachedReadTokens',
    'cacheWriteTokens',
    'uncachedPromptTokens',
    'cacheHitRate',
    'coldCalls',
    'warmCalls',
    'cacheBreaks',
    'ttftMs',
    'ttftColdMs',
    'ttftWarmMs',
    'prefixStability',
  ]) {
    delete m[key];
  }
  return m as unknown as RunMetrics;
}

const scenario = (id: string, over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  id,
  group: 'cache',
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
  mode: 'mock',
  provider: { name: 'mock', model: 'eval-mock' },
  scenarios,
  summary: summarize(scenarios),
  ...over,
});

const compareOne = (base: Partial<RunMetrics>, head: Partial<RunMetrics>, mode?: 'live') => {
  const over = mode ? { mode } : {};
  return compareResults(
    result('base', [scenario('s', { metrics: metrics(base) })], over),
    result('head', [scenario('s', { metrics: metrics(head) })], over),
  );
};

describe('judge — métricas donde más es mejor', () => {
  it('bajar es regresión y subir es mejora', () => {
    const t = { pct: 0, abs: 0.02 };
    expect(judge(0.7, 0.5, t, true)).toBe('regression');
    expect(judge(0.5, 0.7, t, true)).toBe('improvement');
    expect(judge(0.7, 0.69, t, true)).toBe('same');
    expect(judge(0.8, 0.82, t, true)).toBe('same');
    // Sin el indicador sigue siendo «menos es mejor».
    expect(judge(100, 50, { pct: 0, abs: 0 })).toBe('improvement');
  });
});

describe('compare — regresiones y mejoras de caché', () => {
  it('menos acierto de caché con el mismo resultado es una regresión de caché', () => {
    const cmp = compareOne(
      {},
      { cacheHitRate: 0.4, cachedReadTokens: 3600, uncachedPromptTokens: 5400 },
    );
    expect(cmp.verdict).toBe('regression');
    expect(cmp.highlights.cacheRegressions).toEqual(['s']);
    // No se cuela como coste ni como fiabilidad.
    expect(cmp.highlights.costRegressions).toEqual([]);
    expect(cmp.highlights.reliabilityRegressions).toEqual([]);
    const changed = cmp.scenarios[0]!.changes.map((c) => [c.metric, c.category, c.verdict]);
    expect(changed).toEqual([
      ['cacheHitRate', 'cache', 'regression'],
      ['cachedReadTokens', 'cache', 'regression'],
      ['uncachedPromptTokens', 'cache', 'regression'],
    ]);
    const text = formatComparison(cmp);
    expect(text).toContain('Regresiones de caché');
    expect(text).toContain('cacheHitRate 70.0 % → 40.0 %');
  });

  it('más acierto es una mejora', () => {
    const cmp = compareOne(
      {},
      { cacheHitRate: 0.9, cachedReadTokens: 8100, uncachedPromptTokens: 900 },
    );
    expect(cmp.verdict).toBe('improvement');
    expect(cmp.highlights.improvements).toEqual(['s']);
    expect(cmp.highlights.cacheRegressions).toEqual([]);
  });

  it('una rotura de caché nueva y una llamada fría de más cuentan con guion', () => {
    const cmp = compareOne({}, { cacheBreaks: 1, coldCalls: 2 });
    expect(cmp.scenarios[0]!.changes.map((c) => c.metric)).toEqual(['cacheBreaks', 'coldCalls']);
    expect(cmp.highlights.cacheRegressions).toEqual(['s']);
  });

  it('TTFT frío y templado se comparan por separado', () => {
    const cmp = compareOne({}, { ttftWarmMs: 900 });
    expect(cmp.scenarios[0]!.changes).toMatchObject([
      { metric: 'ttftWarmMs', category: 'cache', verdict: 'regression', base: 30, head: 900 },
    ]);
    const better = compareOne({ ttftColdMs: 2000 }, { ttftColdMs: 400 });
    expect(better.scenarios[0]!.changes).toMatchObject([
      { metric: 'ttftColdMs', verdict: 'improvement' },
    ]);
    expect(formatComparison(cmp)).toContain('ttftWarmMs 30 ms → 900 ms');
  });

  it('menos tokens de caché porque el prompt encogió no es una regresión', () => {
    // El prompt pasa de 9000 a 6000: se leen menos de caché y hay menos que procesar.
    const cmp = compareOne({}, { cachedReadTokens: 4200, uncachedPromptTokens: 1800 });
    expect(cmp.scenarios[0]!.changes.map((c) => c.metric)).toEqual(['uncachedPromptTokens']);
    expect(cmp.verdict).toBe('improvement');
  });

  it('más tokens de caché porque el prompt creció no es una mejora', () => {
    const cmp = compareOne({}, { cachedReadTokens: 9000, uncachedPromptTokens: 2800 });
    expect(cmp.scenarios[0]!.changes).toEqual([]);
    expect(cmp.verdict).toBe('same');
  });

  it('un cambio dentro de la tolerancia no es nada', () => {
    const cmp = compareOne({}, { cacheHitRate: 0.69, cachedReadTokens: 6250, ttftWarmMs: 60 });
    expect(cmp.verdict).toBe('same');
  });

  it('contra un modelo real solo cuenta un cambio grande', () => {
    expect(compareOne({}, { cacheHitRate: 0.55 }, 'live').verdict).toBe('same');
    expect(compareOne({}, { cacheHitRate: 0.3 }, 'live').verdict).toBe('regression');
    expect(LIVE_TOLERANCES.cacheHitRate.abs).toBeGreaterThan(MOCK_TOLERANCES.cacheHitRate.abs);
  });

  it('sin dato de caché en una de las dos ejecuciones no se compara', () => {
    const none = { cacheHitRate: null, cachedReadTokens: null, uncachedPromptTokens: null };
    expect(compareOne({}, none).verdict).toBe('same');
    expect(compareOne(none, {}).verdict).toBe('same');
  });

  it('un resultado anterior a las métricas de caché se compara en lo demás', () => {
    const old = result('base', [scenario('s', { metrics: legacyMetrics() })]);
    const now = result('head', [scenario('s', { metrics: metrics({ cacheHitRate: 0.1 }) })]);
    const cmp = compareResults(old, now);
    expect(cmp.verdict).toBe('same');
    expect(cmp.summary.map((c) => c.metric)).not.toContain('cacheHitRate');
    // Y la otra dirección: un coste que sí cambia se sigue viendo.
    const costly = result('head', [scenario('s', { metrics: metrics({ tokens: 30_000 }) })]);
    expect(compareResults(old, costly).highlights.costRegressions).toEqual(['s']);
  });

  it('la caché no se compara entre un FAIL y otro, ni entre modos distintos', () => {
    const worse = metrics({ cacheHitRate: 0.1, cacheBreaks: 3 });
    const failing = compareResults(
      result('base', [scenario('s', { status: 'fail' })]),
      result('head', [scenario('s', { status: 'fail', metrics: worse })]),
    );
    expect(failing.highlights.cacheRegressions).toEqual([]);
    const mixed = compareResults(
      result('base', [scenario('s')]),
      result('head', [scenario('s', { metrics: worse })], { mode: 'live' }),
    );
    expect(mixed.highlights.cacheRegressions).toEqual([]);
  });

  it('el resumen agregado lleva el acierto, las roturas y el TTFT', () => {
    const cmp = compareOne(
      {},
      { cacheHitRate: 0.4, cachedReadTokens: 3600, uncachedPromptTokens: 5400 },
    );
    const byMetric = new Map(cmp.summary.map((c) => [c.metric, c]));
    expect(byMetric.get('cacheHitRate')).toMatchObject({
      base: 0.7,
      head: 0.4,
      verdict: 'regression',
    });
    expect(byMetric.get('uncachedPromptTokens')?.verdict).toBe('regression');
    expect(byMetric.has('ttftColdMs')).toBe(true);
  });

  it('las tolerancias de caché se ajustan desde la línea de comandos', () => {
    expect(parseToleranceSpec('cache=0.05 ttftWarm=50%,200ms breaks=1')).toEqual({
      cacheHitRate: { abs: 0.05 },
      ttftWarmMs: { pct: 0.5, abs: 200 },
      cacheBreaks: { abs: 1 },
    });
    const cmp = compareResults(
      result('base', [scenario('s')]),
      result('head', [scenario('s', { metrics: metrics({ cacheHitRate: 0.62 }) })]),
      parseToleranceSpec('cache=0.1'),
    );
    expect(cmp.verdict).toBe('same');
  });

  it('todas las métricas comparables tienen tolerancia en los dos modos', () => {
    for (const metric of COMPARABLE_METRICS) {
      expect(MOCK_TOLERANCES[metric], metric).toBeDefined();
      expect(LIVE_TOLERANCES[metric], metric).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Resumen, informes y estadísticas
// ---------------------------------------------------------------------------

describe('resumen e informes', () => {
  it('el resumen suma la caché de las ejecuciones que la reportan', () => {
    const s = summarizeGroup([
      scenario('a'),
      scenario('b', {
        metrics: metrics({ cachedReadTokens: 700, uncachedPromptTokens: 300, cacheBreaks: 1 }),
      }),
      scenario('c', {
        metrics: metrics({
          cacheReportedCalls: 0,
          cachedReadTokens: null,
          uncachedPromptTokens: null,
          cacheHitRate: null,
          coldCalls: null,
          warmCalls: null,
          cacheBreaks: null,
          ttftColdMs: null,
          ttftWarmMs: null,
        }),
      }),
    ]);
    expect(s.cache).toMatchObject({
      runs: 2,
      cachedReadTokens: 7000,
      uncachedPromptTokens: 3000,
      hitRate: 0.7,
      breaks: 1,
      coldCalls: 2,
      warmCalls: 6,
      ttftColdMs: 300,
    });
  });

  it('sin ninguna ejecución con caché el resumen dice que no hay dato', () => {
    const s = summarizeGroup([scenario('a', { metrics: legacyMetrics() })]);
    expect(s.cache).toBeNull();
    expect(s.prefixStability).toBeNull();
    const report = formatEvalReport(result('r', [scenario('a', { metrics: legacyMetrics() })]));
    expect(report).toContain('el backend no reporta caché');
  });

  it('el informe de una ejecución muestra el acierto por escenario y en el resumen', () => {
    const report = formatEvalReport(result('r', [scenario('a')]));
    expect(report).toContain('caché 70.0 %');
    expect(report).toContain('Cache hit rate');
    expect(report).toContain('TTFT frío · templado');
  });
});

describe('stats — caché por provider y modelo', () => {
  const stats = aggregateStats([
    {
      sessionId: 'a',
      updatedAt: 5000,
      records: traceOf(
        WARM_LOOP.map((c) => ({ ...c, model: 'qwen', provider: 'llama' })),
        'a',
      ),
    },
    {
      sessionId: 'b',
      updatedAt: 6000,
      records: traceOf(
        [
          { usage: [1000, 0], ttft: 800, model: 'qwen', provider: 'vllm', prefix: prefix(4000) },
          {
            usage: [1200, 0],
            ttft: 900,
            model: 'qwen',
            provider: 'vllm',
            prefix: prefix(4800, 4000),
          },
        ],
        'b',
      ),
    },
    { sessionId: 'c', updatedAt: 7000, records: traceOf([{ usage: [500] }], 'c') },
  ]);

  it('agrega solo las llamadas que reportaron caché', () => {
    expect(stats.cache).toMatchObject({
      reportedCalls: 5,
      promptTokens: 5800,
      cachedReadTokens: 2200,
      uncachedPromptTokens: 3600,
      coldCalls: 3,
      warmCalls: 2,
      ttftWarmMs: 30,
    });
    expect(stats.llmCalls).toBe(6);
    expect(stats.prefixStability).toBe(12800 / 15200);
  });

  it('el mismo modelo en dos providers son dos filas: se ve cuál aprovecha mejor el contexto', () => {
    const rows = stats.models.map((m) => [m.provider, m.model, m.cache?.hitRate ?? null]);
    expect(rows).toEqual([
      ['llama', 'qwen', 2200 / 3600],
      ['vllm', 'qwen', 0],
      [undefined, 'test-model', null],
    ]);
    expect(stats.models[1]!.cache).toMatchObject({ ttftColdMs: 850, ttftWarmMs: null });
  });

  it('las roturas se cuentan por causa', () => {
    const broken = aggregateStats([
      {
        sessionId: 'x',
        updatedAt: 1,
        records: traceOf([
          { usage: [1000, 0], prefix: prefix(4000) },
          { usage: [1200, 1000], prefix: prefix(4800, 4000) },
          {
            usage: [1300, 200],
            prefix: prefix(5200, 900, { diverged: 'system', divergedAt: 0 }),
          },
          {
            usage: [900, 100],
            prefix: prefix(3600, 500, { diverged: 'history', divergedAt: 2 }),
            compressedBefore: true,
          },
        ]),
      },
    ]);
    expect(broken.cacheBreaks).toEqual({ system: 1, compression: 1 });
    const text = formatStats(broken);
    expect(text).toContain('Caché de prompt');
    expect(text).toContain('cambió el prompt del sistema 1');
    expect(text).toContain('compresión de contexto 1');
  });

  it('sin datos de caché lo dice en vez de pintar un 0 %', () => {
    const none = aggregateStats([
      { sessionId: 'c', updatedAt: 1, records: traceOf([{ usage: [500] }]) },
    ]);
    expect(none.cache).toBeNull();
    expect(none.cacheBreaks).toEqual({});
    expect(formatStats(none)).toContain('Ninguna llamada reportó caché');
  });
});

// ---------------------------------------------------------------------------
// Criterios y formato de escenario
// ---------------------------------------------------------------------------

const baseScenario = {
  id: 'cache-test',
  group: 'cache',
  title: 't',
  input: 'hola',
  script: [{ text: 'ok' }],
  expect: { description: 'd', checks: [{ type: 'exit_code', equals: 0 }] },
};

describe('escenarios de caché', () => {
  it('followUps y sessions se validan y entran en la huella', () => {
    const plain = parseScenario(JSON.stringify(baseScenario), 'a.json');
    expect(plain.followUps).toEqual([]);
    expect(plain.sessions).toEqual([]);
    const multi = parseScenario(
      JSON.stringify({
        ...baseScenario,
        followUps: ['otro turno'],
        sessions: [{ input: 'otra sesión', cwd: 'packages/api' }],
      }),
      'b.json',
    );
    expect(multi.sessions).toEqual([{ input: 'otra sesión', cwd: 'packages/api' }]);
    expect(scenarioFingerprint(multi)).not.toBe(scenarioFingerprint(plain));
    expect(() =>
      parseScenario(
        JSON.stringify({ ...baseScenario, sessions: [{ input: 'x', cwd: '../fuera' }] }),
        'c.json',
      ),
    ).toThrow(/ruta relativa/);
  });

  it('la huella de un escenario de siempre no cambia por los campos nuevos', () => {
    // La fórmula anterior a `followUps` y `sessions`: los baselines guardados siguen casando.
    const scenario = parseScenario(JSON.stringify({ ...baseScenario, group: 'code' }), 'a.json');
    const { requires, setup, input, run, script, expect: expected } = scenario;
    const before = createHash('sha1')
      .update(JSON.stringify({ requires, setup, input, run, script, expect: expected }))
      .digest('hex')
      .slice(0, 12);
    expect(scenarioFingerprint(scenario)).toBe(before);
  });

  it('los escenarios incluidos conservan la huella del baseline de referencia', () => {
    const baseline = JSON.parse(
      readFileSync(join(bundledScenariosDir()!, '..', 'baselines', 'mock.json'), 'utf8'),
    ) as EvalResult;
    const known = new Map(baseline.scenarios.map((s) => [s.id, s.scenarioHash]));
    const { scenarios } = loadScenarios([bundledScenariosDir()!]);
    const compared = scenarios.filter((s) => known.has(s.id));
    expect(compared.length).toBeGreaterThan(30);
    for (const s of compared) expect(scenarioFingerprint(s), s.id).toBe(known.get(s.id));
  });

  it('un criterio de caché ata la trayectoria: contra un modelo real va con mode mock', () => {
    const withChecks = (checks: unknown[]) =>
      parseScenario(
        JSON.stringify({ ...baseScenario, expect: { description: 'd', checks } }),
        'a.json',
      );
    expect(
      liveTrajectoryChecks(
        withChecks([
          { type: 'cache_break', cause: 'compression' },
          { type: 'metric', metric: 'cacheHitRate', min: 0.8 },
        ]),
      ),
    ).toHaveLength(2);
    expect(
      liveTrajectoryChecks(
        withChecks([
          { type: 'cache_break', cause: 'compression', mode: 'mock' },
          { type: 'metric', metric: 'cacheHitRate', min: 0.8, mode: 'mock' },
          { type: 'metric', metric: 'cacheBreaks', max: 0 },
          { type: 'cache_break', min: 0, max: 0 },
        ]),
      ),
    ).toEqual([]);
  });

  it('cache_break y las métricas de caché se evalúan desde la traza', async () => {
    const records = traceOf([
      { usage: [1000, 0], prefix: prefix(4000) },
      { usage: [2000, 1000], prefix: prefix(8000, 4000) },
      {
        usage: [1500, 1005],
        prefix: prefix(6000, 4020, { diverged: 'history', divergedAt: 2 }),
        compressedBefore: true,
      },
    ]);
    const scenario = parseScenario(
      JSON.stringify({
        ...baseScenario,
        expect: {
          description: 'd',
          checks: [
            { type: 'cache_break', cause: 'compression', min: 1, max: 1 },
            { type: 'cache_break', cause: 'tools', min: 1 },
            { type: 'metric', metric: 'cacheBreaks', equals: 1 },
            { type: 'metric', metric: 'coldCalls', equals: 1 },
            { type: 'metric', metric: 'cacheHitRate', min: 0.9 },
            { type: 'metric', metric: 'compressions', equals: 1 },
          ],
        },
      }),
      'a.json',
    );
    const results = await evaluateChecks(scenario.expect.checks, {
      mode: 'mock',
      workDir: '.',
      exitCode: 0,
      output: '',
      model: buildTraceModel(records),
      metrics: computeMetrics(records),
    });
    expect(results.map((r) => r.pass)).toEqual([true, false, true, true, false, true]);
    expect(results[1]!.detail).toContain('compression');
  });

  it('una métrica de caché que la traza no trae incumple el criterio, no lo da por bueno', async () => {
    const records = traceOf([{ usage: [1000] }]);
    const scenario = parseScenario(
      JSON.stringify({
        ...baseScenario,
        expect: {
          description: 'd',
          checks: [{ type: 'metric', metric: 'cacheHitRate', min: 0 }],
        },
      }),
      'a.json',
    );
    const [check] = await evaluateChecks(scenario.expect.checks, {
      mode: 'mock',
      workDir: '.',
      exitCode: 0,
      output: '',
      model: buildTraceModel(records),
      metrics: computeMetrics(records),
    });
    expect(check).toMatchObject({ pass: false, detail: 'la traza no trae ese dato' });
  });
});

// ---------------------------------------------------------------------------
// Modelo de guion: caché de prefijo simulada
// ---------------------------------------------------------------------------

describe('modelo de guion — caché de prefijo', () => {
  it('el prefijo cuenta en el orden tools, system, conversación', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ],
      tools: [{ type: 'function', function: { name: 't' } }],
    };
    const rendered = renderPromptForCache(body);
    expect(rendered.indexOf('"name":"t"')).toBeLessThan(rendered.indexOf('"content":"S"'));
    expect(renderPromptForCache({ messages: [] })).toBe('[]');
    expect(renderPromptForCache(null)).toBe('');
  });

  it('el prefijo cacheado es el más largo compartido con cualquier petición anterior', () => {
    expect(commonPrefixLength('abcdef', 'abcxyz')).toBe(3);
    expect(cachedPrefixLength('abcdef', [])).toBe(0);
    expect(cachedPrefixLength('abcdef', ['abzzzz', 'abcdzz', 'zzzzzz'])).toBe(4);
  });

  async function ask(baseUrl: string, body: Record<string, unknown>) {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'eval-mock', stream: true, ...body }),
    });
    const text = await res.text();
    const usage = text
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)) as { usage?: Record<string, unknown> })
      .find((c) => c.usage)?.usage as
      | { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } }
      | undefined;
    return { status: res.status, usage, ms: Date.now() - started };
  }

  it('fría la primera, templada la que comparte prefijo, y un error no deja nada en caché', async () => {
    const system = { role: 'system', content: 'Instrucciones estables. '.repeat(400) };
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'x' } }];
    const turn1 = [system, { role: 'user', content: 'primera pregunta' }];
    const turn2 = [
      ...turn1,
      { role: 'assistant', content: 'uno' },
      { role: 'user', content: 'y dos' },
    ];
    const mock = await startMockLlm([
      { error: { status: 400, message: 'no' } },
      { text: 'uno' },
      { text: 'dos' },
      { text: 'tres' },
      { text: 'cuatro' },
    ]);
    try {
      const failed = await ask(mock.baseUrl, { messages: turn1, tools });
      expect(failed.status).toBe(400);

      const cold = await ask(mock.baseUrl, { messages: turn1, tools });
      expect(cold.usage?.prompt_tokens_details.cached_tokens).toBe(0);

      const warm = await ask(mock.baseUrl, { messages: turn2, tools });
      const cached = warm.usage!.prompt_tokens_details.cached_tokens;
      expect(cached).toBeGreaterThan(0.9 * cold.usage!.prompt_tokens);
      expect(cached).toBeLessThanOrEqual(warm.usage!.prompt_tokens);
      // El primer token tarda en proporción a lo que no salió de caché.
      expect(cold.ms).toBeGreaterThan(warm.ms);

      // Otro orden de tools: lo que viene detrás ya no se comparte.
      const reordered = await ask(mock.baseUrl, {
        messages: turn2,
        tools: [{ type: 'function', function: { name: 'grep', description: 'y' } }, ...tools],
      });
      expect(reordered.usage!.prompt_tokens_details.cached_tokens).toBeLessThan(20);

      // Otro system prompt al final: se conserva el prefijo hasta el cambio.
      const edited = { ...system, content: `${system.content}\n# Open tasks\n- a` };
      const partial = await ask(mock.baseUrl, { messages: [edited, ...turn2.slice(1)], tools });
      const kept = partial.usage!.prompt_tokens_details.cached_tokens;
      expect(kept).toBeGreaterThan(0.8 * cold.usage!.prompt_tokens);
      expect(kept).toBeLessThan(cached);
    } finally {
      await mock.close();
    }
  });
});

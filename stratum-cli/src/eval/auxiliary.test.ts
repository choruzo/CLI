import { describe, expect, it } from 'vitest';
import { COMPRESSOR_PROMPT } from '../agent/harness.js';
import { EXTRACT_SYSTEM_PROMPT } from '../memory/extractor.js';
import { TRACE_CAP_LLM_ORIGIN, type TraceRecord } from '../trace/records.js';
import { buildTraceModel, computeMetrics, turnOutcomes, AUXILIARY_METRICS } from './metrics.js';
import { evaluateChecks } from './checks.js';
import { compareResults, parseMetricSelection, ToleranceError } from './compare.js';
import { classifyAuxiliaryRequest, startMockLlm } from './mock-llm.js';
import { formatComparison, formatEvalReport, formatStats } from './report.js';
import { summarize, type EvalResult, type ScenarioResult } from './result.js';
import {
  CHECKABLE_METRICS,
  liveTrajectoryChecks,
  parseScenario,
  scenarioFingerprint,
} from './scenario.js';
import { aggregateStats } from './stats.js';

// ---------------------------------------------------------------------------
// Trazas sintéticas
// ---------------------------------------------------------------------------

interface Call {
  id: string;
  start: number;
  end: number;
  origin?: string;
  first?: number;
  status?: 'ok' | 'error' | 'cancelled';
  usage?: [prompt: number, completion: number, cached?: number];
  parent?: string;
}

function call(c: Call): TraceRecord[] {
  const out: TraceRecord[] = [
    {
      t: 'begin',
      at: c.start,
      id: c.id,
      kind: 'model',
      name: 'm',
      ...(c.parent ? { parent: c.parent } : {}),
      data: { ...(c.origin ? { origin: c.origin } : {}), provider: 'p' },
    },
  ];
  if (c.first !== undefined) out.push({ t: 'mark', at: c.first, id: c.id, name: 'first_token' });
  out.push({
    t: 'end',
    at: c.end,
    id: c.id,
    status: c.status ?? 'ok',
    ...(c.usage
      ? {
          data: {
            usage: {
              promptTokens: c.usage[0],
              completionTokens: c.usage[1],
              totalTokens: c.usage[0] + c.usage[1],
              ...(c.usage[2] !== undefined ? { cachedReadTokens: c.usage[2] } : {}),
            },
          },
        }
      : {}),
  });
  return out;
}

const meta = (tracked = true): TraceRecord => ({
  t: 'meta',
  v: 1,
  at: 0,
  sessionId: 's',
  caps: tracked ? ['runtime', TRACE_CAP_LLM_ORIGIN] : ['runtime'],
});

/** Un turno con dos llamadas del agente; `extra` añade lo demás. */
function turn(extra: TraceRecord[] = [], tracked = true): TraceRecord[] {
  const records: TraceRecord[] = [
    meta(tracked),
    { t: 'turn', at: 1000, input: 'tarea' },
    ...call({
      id: 'a1',
      start: 1010,
      end: 1200,
      first: 1100,
      origin: 'agent',
      usage: [1000, 50, 0],
    }),
    ...call({
      id: 'a2',
      start: 1600,
      end: 1800,
      first: 1650,
      origin: 'agent',
      usage: [1200, 40, 900],
    }),
    { t: 'turn_end', at: 1900, stopReason: 'stop' },
    ...extra,
  ];
  return records.sort((a, b) => a.at - b.at);
}

const compression = call({
  id: 'c1',
  start: 1210,
  end: 1500,
  first: 1300,
  origin: 'context-compression',
  usage: [800, 100, 0],
});
const extraction = (status: Call['status'] = 'ok'): TraceRecord[] =>
  call({
    id: 'x1',
    start: 1900,
    end: 2400,
    origin: 'memory-extraction',
    status,
    ...(status === 'ok' ? { first: 2100, usage: [400, 5, 100] as Call['usage'] } : {}),
  });

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

describe('computeMetrics — llamadas auxiliares', () => {
  it('las cuenta aparte: lo que medía el loop no se mueve', () => {
    const plain = computeMetrics(turn(), 3000);
    const withAux = computeMetrics(turn([...compression, ...extraction()]), 3000);
    for (const key of [
      'llmCalls',
      'llmErrors',
      'tokens',
      'promptTokens',
      'completionTokens',
      'cacheHitRate',
      'cachedReadTokens',
      'uncachedPromptTokens',
      'cacheBreaks',
      'coldCalls',
      'warmCalls',
      'ttftMs',
      'durationMs',
      'hadErrors',
      'toolErrors',
    ] as const) {
      expect(withAux[key], key).toEqual(plain[key]);
    }
    expect(withAux.llmCalls).toBe(2);
  });

  it('da el total y el reparto por origen', () => {
    const m = computeMetrics(turn([...compression, ...extraction()]), 3000);
    expect(m).toMatchObject({
      totalLlmCalls: 4,
      agentLlmCalls: 2,
      subagentLlmCalls: 0,
      auxiliaryLlmCalls: 2,
      memoryExtractionCalls: 1,
      compressionCalls: 1,
      sessionSummaryCalls: 0,
      auxiliaryLlmErrors: 0,
    });
    expect(m.totalLlmCalls).toBe(m.llmCalls + (m.auxiliaryLlmCalls ?? 0));
    expect(m.llmByOrigin?.agent.calls).toBe(2);
  });

  it('los tokens y la caché auxiliares no se suman a los del agente', () => {
    const m = computeMetrics(turn([...compression, ...extraction()]), 3000);
    // Agente: 1000+1200 de entrada, 900 de caché.
    expect(m.promptTokens).toBe(2200);
    expect(m.cachedReadTokens).toBe(900);
    expect(m.cacheHitRate).toBeCloseTo(900 / 2200);
    // Auxiliares: 800+400 de entrada, 100 de caché.
    expect(m.auxiliaryPromptTokens).toBe(1200);
    expect(m.auxiliaryCompletionTokens).toBe(105);
    expect(m.auxiliaryCachedReadTokens).toBe(100);
    expect(m.auxiliaryCacheHitRate).toBeCloseTo(100 / 1200);
    expect(m.auxiliaryDurationMs).toBe(290 + 500);
  });

  it('una auxiliar que falla es un fallo auxiliar: ni llmErrors, ni toolErrors, ni hadErrors', () => {
    const records = turn(extraction('error'));
    const m = computeMetrics(records, 3000);
    expect(m.auxiliaryLlmErrors).toBe(1);
    expect(m).toMatchObject({ llmErrors: 0, toolErrors: 0, hadErrors: false, stopReason: 'stop' });
    expect(turnOutcomes(records)).toEqual([{ errors: 0, stop: 'stop' }]);
    // Sin `usage` no hay tokens auxiliares que contar: null, no 0.
    expect(m.auxiliaryPromptTokens).toBeNull();
    expect(m.auxiliaryCachedReadTokens).toBeNull();
  });

  it('una auxiliar cancelada no es un error', () => {
    const m = computeMetrics(turn(extraction('cancelled')), 3000);
    expect(m.auxiliaryLlmCalls).toBe(1);
    expect(m.auxiliaryLlmErrors).toBe(0);
    expect(m.llmByOrigin?.['memory-extraction'].cancelled).toBe(1);
  });

  it('en una traza que no las registraba son null, nunca 0', () => {
    const m = computeMetrics(turn([], false), 3000);
    expect(m.totalLlmCalls).toBe(2);
    expect(m.agentLlmCalls).toBe(2);
    for (const key of [
      'auxiliaryLlmCalls',
      'memoryExtractionCalls',
      'compressionCalls',
      'auxiliaryLlmErrors',
      'auxiliaryPromptTokens',
      'auxiliaryDurationMs',
      'llmByOrigin',
      'overlappingAuxiliaryMs',
      'precedingAuxiliaryMs',
      'ttftClearMs',
    ] as const) {
      expect(m[key], key).toBeNull();
    }
  });

  it('las llamadas de un subagente son `subagent`, no `agent`', () => {
    const records = turn([
      { t: 'begin', at: 1205, id: 'sub1', kind: 'subagent', name: 'research' },
      ...call({
        id: 's1',
        start: 1210,
        end: 1400,
        origin: 'subagent',
        parent: 'sub1',
        usage: [300, 10],
      }),
      { t: 'end', at: 1410, id: 'sub1', status: 'ok' },
    ]);
    const m = computeMetrics(records, 3000);
    expect(m).toMatchObject({
      llmCalls: 3,
      agentLlmCalls: 2,
      subagentLlmCalls: 1,
      auxiliaryLlmCalls: 0,
    });
  });

  it('relación temporal: la compresión precede a la llamada siguiente; no es cola del servidor', () => {
    const m = computeMetrics(turn(compression), 3000);
    expect(m).toMatchObject({
      overlappedLlmCalls: 0,
      overlappingAuxiliaryMs: 0,
      precedingAuxiliaryMs: 290,
      ttftOverlappedMs: null,
    });
    expect(m.ttftClearMs).toBeCloseTo((90 + 50) / 2);
  });

  it('relación temporal: una extracción en vuelo solapa la espera del turno siguiente', () => {
    const records: TraceRecord[] = [
      ...turn(extraction()),
      { t: 'turn', at: 2000, input: 'otra' },
      ...call({
        id: 'a3',
        start: 2010,
        end: 2900,
        first: 2700,
        origin: 'agent',
        usage: [1300, 10, 1200],
      }),
      { t: 'turn_end', at: 2950, stopReason: 'stop' },
    ];
    const m = computeMetrics(records, 3000);
    expect(m.overlappedLlmCalls).toBe(1);
    expect(m.overlappingAuxiliaryMs).toBe(2400 - 2010);
    expect(m.ttftOverlappedMs).toBe(690);
    // Y la extracción, lanzada con el turno cerrado, no lo alarga.
    expect(m.durationMs).toBe(900 + 950);
  });

  it('todas las métricas auxiliares comparables son números o null', () => {
    const m = computeMetrics(turn([...compression, ...extraction()]), 3000);
    for (const key of AUXILIARY_METRICS) expect(typeof m[key], key).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Criterios de escenario
// ---------------------------------------------------------------------------

describe('criterio `llm_call` y métricas comprobables', () => {
  const scenarioWith = (checks: unknown[], more: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: 'aux-check',
      group: 'cache',
      title: 't',
      input: 'tarea',
      script: [{ text: 'ok' }],
      expect: { description: 'd', checks },
      ...more,
    });

  const ctx = (records: TraceRecord[]) => ({
    mode: 'mock' as const,
    workDir: '.',
    exitCode: 0,
    output: '',
    model: buildTraceModel(records),
    metrics: computeMetrics(records, 3000),
  });

  it('cuenta las llamadas de un origen, también por estado', async () => {
    const s = parseScenario(
      scenarioWith([
        { type: 'llm_call', origin: 'memory-extraction', mode: 'mock' },
        {
          type: 'llm_call',
          origin: 'memory-extraction',
          status: 'error',
          min: 1,
          max: 1,
          mode: 'mock',
        },
        { type: 'llm_call', origin: 'context-compression', min: 0, max: 0 },
        { type: 'llm_call', origin: 'agent', min: 2, max: 2, mode: 'mock' },
      ]),
      'x.json',
    );
    const results = await evaluateChecks(s.expect.checks, ctx(turn(extraction('error'))));
    expect(results.map((r) => r.pass)).toEqual([true, true, true, true]);
    const none = await evaluateChecks(s.expect.checks, ctx(turn()));
    expect(none.map((r) => r.pass)).toEqual([false, false, true, true]);
    expect(none[0]?.detail).toContain('0 llamadas');
  });

  it('rechaza un origen que no existe', () => {
    expect(() =>
      parseScenario(scenarioWith([{ type: 'llm_call', origin: 'otra-cosa' }]), 'x.json'),
    ).toThrow(/escenario no válido/);
  });

  it('exigir una llamada concreta es trayectoria: va con mode mock', () => {
    const s = parseScenario(
      scenarioWith([
        { type: 'llm_call', origin: 'memory-extraction' },
        { type: 'llm_call', origin: 'context-compression', min: 0, max: 0 },
      ]),
      'x.json',
    );
    expect(liveTrajectoryChecks(s)).toHaveLength(1);
  });

  it('las métricas por origen se pueden acotar con `metric`', () => {
    for (const metric of ['auxiliaryLlmCalls', 'memoryExtractionCalls', 'agentLlmCalls'] as const) {
      expect(CHECKABLE_METRICS).toContain(metric);
    }
  });

  it('el guion auxiliar entra en la huella solo si se usa', () => {
    const plain = parseScenario(scenarioWith([{ type: 'exit_code', equals: 0 }]), 'x.json');
    const withAux = parseScenario(
      scenarioWith([{ type: 'exit_code', equals: 0 }], {
        auxiliaryScript: { 'memory-extraction': [{ text: '[]' }] },
      }),
      'x.json',
    );
    expect(scenarioFingerprint(withAux)).not.toBe(scenarioFingerprint(plain));
    expect(() =>
      parseScenario(
        scenarioWith([{ type: 'exit_code', equals: 0 }], {
          auxiliaryScript: { agent: [{ text: 'x' }] },
        }),
        'x.json',
      ),
    ).toThrow(/escenario no válido/);
  });
});

// ---------------------------------------------------------------------------
// Modelo de guion
// ---------------------------------------------------------------------------

describe('modelo de guion — llamadas auxiliares', () => {
  const extractionBody = {
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: 'Conversación a analizar: …' },
    ],
  };
  const compressionBody = {
    messages: [{ role: 'user', content: `${COMPRESSOR_PROMPT}\n\n<conversation>…</conversation>` }],
  };
  const agentBody = {
    messages: [
      { role: 'system', content: 'You are Stratum.' },
      { role: 'user', content: 'hola' },
    ],
  };

  it('reconoce cada auxiliar por su prompt, y nada más', () => {
    expect(classifyAuxiliaryRequest(extractionBody)).toBe('memory-extraction');
    expect(classifyAuxiliaryRequest(compressionBody)).toBe('context-compression');
    expect(classifyAuxiliaryRequest(agentBody)).toBeNull();
    expect(classifyAuxiliaryRequest({ messages: [] })).toBeNull();
    expect(classifyAuxiliaryRequest(null)).toBeNull();
    // El prompt del compresor citado dentro de una conversación del agente no cuenta.
    expect(
      classifyAuxiliaryRequest({
        messages: [...agentBody.messages, { role: 'user', content: COMPRESSOR_PROMPT }],
      }),
    ).toBeNull();
  });

  const post = async (baseUrl: string, body: unknown): Promise<string> => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? await res.text() : `HTTP ${res.status}`;
  };

  it('con guion auxiliar, la extracción no consume pasos del guion principal, llegue cuando llegue', async () => {
    const mock = await startMockLlm([{ text: 'uno' }, { text: 'dos' }], {
      'memory-extraction': [{ text: '[]' }, { error: { status: 500, message: 'caído' } }],
    });
    try {
      expect(await post(mock.baseUrl, agentBody)).toContain('uno');
      expect(await post(mock.baseUrl, extractionBody)).toContain('[]');
      expect(await post(mock.baseUrl, extractionBody)).toBe('HTTP 500');
      expect(await post(mock.baseUrl, agentBody)).toContain('dos');
      expect(mock.requests()).toBe(2);
      expect(mock.auxiliaryRequests()).toEqual({ 'memory-extraction': 2 });
    } finally {
      await mock.close();
    }
  });

  it('sin guion auxiliar para ese origen, sigue consumiendo el principal (los escenarios de siempre)', async () => {
    const mock = await startMockLlm([{ text: 'uno' }, { text: 'resumen' }]);
    try {
      await post(mock.baseUrl, agentBody);
      expect(await post(mock.baseUrl, compressionBody)).toContain('resumen');
      expect(mock.requests()).toBe(2);
      expect(mock.auxiliaryRequests()).toEqual({});
    } finally {
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Resumen, comparación, informes y stats
// ---------------------------------------------------------------------------

const scenarioResult = (id: string, records: TraceRecord[]): ScenarioResult => ({
  id,
  group: 'cache',
  difficulty: 'basic',
  title: id,
  scenarioHash: `hash-${id}`,
  status: 'pass',
  checks: [],
  unsafeActions: [],
  metrics: computeMetrics(records, 3000),
  exitCode: 0,
  wallMs: 1000,
  timedOut: false,
  sessionId: 's',
  trace: `${id}/s.jsonl`,
});

const evalResult = (runId: string, scenarios: ScenarioResult[]): EvalResult => ({
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
});

describe('summarize — desglose por origen', () => {
  it('suma las llamadas de todas las ejecuciones por origen', () => {
    const r = evalResult('r1', [
      scenarioResult('uno', turn([...compression, ...extraction()])),
      scenarioResult('dos', turn(extraction('error'))),
    ]);
    const llm = r.summary.overall.llm!;
    expect(llm.runs).toBe(2);
    expect(llm.calls).toBe(4 + 3);
    expect(llm.byOrigin.agent.calls).toBe(4);
    expect(llm.byOrigin['memory-extraction']).toMatchObject({ calls: 2, errors: 1 });
    expect(llm.byOrigin['context-compression'].calls).toBe(1);
    expect(llm.auxiliary).toMatchObject({ calls: 3, errors: 1, promptTokens: 1200 });
    // `llmCalls` del resumen sigue siendo el del loop.
    expect(r.summary.overall.llmCalls).toBe(4);
  });

  it('es null si ninguna ejecución registraba las auxiliares', () => {
    expect(
      evalResult('r1', [scenarioResult('uno', turn([], false))]).summary.overall.llm,
    ).toBeNull();
  });

  it('el informe muestra «LLM calls» con una fila por origen', () => {
    const text = formatEvalReport(
      evalResult('r1', [scenarioResult('uno', turn([...compression, ...extraction()]))]),
    );
    expect(text).toContain('LLM calls: 4');
    expect(text).toMatch(/agent\s+2/);
    expect(text).toMatch(/memory-extraction\s+1/);
    expect(text).toMatch(/context-compression\s+1/);
    // Sin llamadas, un origen auxiliar no ocupa fila.
    expect(text).not.toContain('session-summary');
  });
});

describe('compare — métricas auxiliares, solo si se piden', () => {
  const base = evalResult('base', [scenarioResult('uno', turn())]);
  const head = evalResult('head', [
    scenarioResult('uno', turn([...compression, ...extraction('error')])),
  ]);

  it('por defecto no son regresión, aunque se muestran', () => {
    const cmp = compareResults(base, head);
    expect(cmp.verdict).toBe('same');
    expect(cmp.regressions).toBe(0);
    expect(cmp.highlights.auxiliaryRegressions).toEqual([]);
    expect(cmp.selected).toBeUndefined();
    const shown = Object.fromEntries(cmp.summary.map((c) => [c.metric, [c.base, c.head]]));
    expect(shown.auxiliaryLlmCalls).toEqual([0, 2]);
    expect(shown.memoryExtractionCalls).toEqual([0, 1]);
    expect(shown.auxiliaryLlmErrors).toEqual([0, 1]);
    const text = formatComparison(cmp);
    expect(text).toContain('auxiliaryLlmCalls');
    expect(text).toContain('--metric');
  });

  it('pedidas a propósito, cuentan', () => {
    const cmp = compareResults(base, head, undefined, parseMetricSelection(['auxiliaryLlmCalls']));
    expect(cmp.verdict).toBe('regression');
    expect(cmp.highlights.auxiliaryRegressions).toEqual(['uno']);
    expect(cmp.scenarios[0]?.changes).toEqual([
      expect.objectContaining({
        metric: 'auxiliaryLlmCalls',
        category: 'auxiliary',
        base: 0,
        head: 2,
      }),
    ]);
    expect(formatComparison(cmp)).toContain('Regresiones en llamadas auxiliares');
  });

  it('con su tolerancia, lo que no la supera se ignora', () => {
    const selection = parseMetricSelection(['auxiliaryLlmCalls=2']);
    expect(compareResults(base, head, undefined, selection).verdict).toBe('same');
  });

  it('`auxiliary` las selecciona todas; menos llamadas es una mejora', () => {
    const selection = parseMetricSelection(['auxiliary']);
    expect(Object.keys(selection).sort()).toEqual([...AUXILIARY_METRICS].sort());
    expect(compareResults(head, base, undefined, selection).verdict).toBe('improvement');
  });

  it('no compara contra un resultado que no las registraba', () => {
    const old = evalResult('old', [scenarioResult('uno', turn([], false))]);
    const cmp = compareResults(old, head, undefined, parseMetricSelection(['auxiliary']));
    expect(cmp.verdict).toBe('same');
  });

  it('parseMetricSelection: tolerancias, unidades y errores', () => {
    expect(parseMetricSelection(['auxiliaryPromptTokens=20%,200 auxiliaryDurationMs=2s'])).toEqual({
      auxiliaryPromptTokens: { pct: 0.2, abs: 200 },
      auxiliaryDurationMs: { pct: 0, abs: 2000 },
    });
    expect(parseMetricSelection([])).toEqual({});
    expect(() => parseMetricSelection(['tokens'])).toThrow(ToleranceError);
    expect(() => parseMetricSelection(['auxiliaryLlmCalls=2s'])).toThrow(ToleranceError);
  });
});

describe('stats — llamadas por origen', () => {
  it('agrega por origen y separa las sesiones que no registraban las auxiliares', () => {
    const stats = aggregateStats([
      { sessionId: 'a', updatedAt: 3000, records: turn([...compression, ...extraction('error')]) },
      { sessionId: 'b', updatedAt: 3000, records: turn([], false) },
    ]);
    expect(stats.llmCalls).toBe(4);
    expect(stats.llmErrors).toBe(0);
    expect(stats.llm).toMatchObject({ auxiliarySessions: 1, calls: 6 });
    expect(stats.llm.byOrigin.agent.calls).toBe(4);
    expect(stats.llm.byOrigin['memory-extraction']).toMatchObject({ calls: 1, errors: 1 });
    expect(stats.llm.auxiliary).toMatchObject({ calls: 2, errors: 1, promptTokens: 800 });
    expect(stats.llm.precedingAuxiliaryMs).toBe(290);
    // La tabla de modelos y la caché global siguen siendo las del loop.
    expect(stats.models[0]?.calls).toBe(4);
    expect(stats.cache?.reportedCalls).toBe(4);
    // Y un fallo auxiliar no cuenta como turno con fallos.
    expect(stats.recovery.turnsWithErrors).toBe(0);

    const text = formatStats(stats);
    expect(text).toContain('LLM calls: 6');
    expect(text).toMatch(/memory-extraction\s+1/);
    expect(text).toContain('solo de las 1 sesiones');
  });
});

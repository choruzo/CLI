/**
 * Comparación de dos ejecuciones de `stratum eval`. El objetivo es ver las
 * regresiones que un PASS/FAIL esconde: el mismo escenario sigue pasando, pero
 * cuesta más tokens, más tiempo, más llamadas o deja más errores por el camino.
 * Puro: sin disco.
 */
import { COMPARABLE_METRICS, type ComparableMetric, type RunMetrics } from './metrics.js';
import type { EvalResult, GroupSummary, ScenarioResult, ScenarioStatus } from './result.js';

export type Verdict = 'regression' | 'improvement' | 'same';

export interface CompareThresholds {
  /** Cambio relativo mínimo para tokens y nº de llamadas (0.2 = 20 %). */
  relative: number;
  /** Cambio relativo mínimo para el tiempo, que es ruidoso por naturaleza. */
  timeRelative: number;
}

export const DEFAULT_THRESHOLDS: CompareThresholds = { relative: 0.2, timeRelative: 0.5 };

/**
 * Por métrica: cambio absoluto mínimo, y si además tiene que superar el umbral
 * relativo. Los contadores de fallos no tienen umbral: un error más es un
 * error más.
 */
const RULES: Record<ComparableMetric, { minAbs: number; relative: 'count' | 'time' | 'none' }> = {
  tokens: { minAbs: 200, relative: 'count' },
  durationMs: { minAbs: 2000, relative: 'time' },
  llmCalls: { minAbs: 1, relative: 'count' },
  toolCalls: { minAbs: 1, relative: 'count' },
  toolErrors: { minAbs: 1, relative: 'none' },
  llmErrors: { minAbs: 1, relative: 'none' },
  retries: { minAbs: 1, relative: 'none' },
  policyBlocks: { minAbs: 1, relative: 'none' },
  repeatedCalls: { minAbs: 1, relative: 'none' },
  subagentFailures: { minAbs: 1, relative: 'none' },
};

export interface MetricChange {
  metric: string;
  base: number;
  head: number;
  delta: number;
  /** Cambio relativo; null si la base es 0. */
  pct: number | null;
  verdict: Verdict;
}

export interface ScenarioComparison {
  id: string;
  group: string;
  base: ScenarioStatus | null;
  head: ScenarioStatus | null;
  /** `added` / `removed`: solo está en una de las dos ejecuciones. */
  verdict: Verdict | 'added' | 'removed';
  changes: MetricChange[];
}

export interface Comparison {
  base: { runId: string; label?: string; stratumVersion: string; model: string; mode: string };
  head: { runId: string; label?: string; stratumVersion: string; model: string; mode: string };
  thresholds: CompareThresholds;
  /** Avisos sobre la comparación en sí (modos o modelos distintos). */
  notes: string[];
  scenarios: ScenarioComparison[];
  summary: MetricChange[];
  regressions: number;
  improvements: number;
  verdict: Verdict;
}

/** Veredicto de un cambio en una métrica donde menos es mejor. */
export function judge(
  metric: ComparableMetric,
  base: number,
  head: number,
  thresholds: CompareThresholds,
): Verdict {
  const delta = head - base;
  const rule = RULES[metric];
  if (Math.abs(delta) < rule.minAbs) return 'same';
  if (rule.relative !== 'none') {
    const limit = rule.relative === 'time' ? thresholds.timeRelative : thresholds.relative;
    // Con base 0 no hay relativo: cualquier cambio que supere el mínimo cuenta.
    if (base > 0 && Math.abs(delta) / base < limit) return 'same';
  }
  return delta > 0 ? 'regression' : 'improvement';
}

function change(
  metric: ComparableMetric,
  base: number,
  head: number,
  thresholds: CompareThresholds,
): MetricChange {
  return {
    metric,
    base,
    head,
    delta: head - base,
    pct: base !== 0 ? (head - base) / base : null,
    verdict: judge(metric, base, head, thresholds),
  };
}

function metricChanges(
  base: RunMetrics,
  head: RunMetrics,
  thresholds: CompareThresholds,
): MetricChange[] {
  const out: MetricChange[] = [];
  for (const metric of COMPARABLE_METRICS) {
    const b = base[metric];
    const h = head[metric];
    // Un dato que una de las dos trazas no tiene no se compara (ni se inventa).
    if (b === null || h === null) continue;
    out.push(change(metric, b, h, thresholds));
  }
  return out;
}

const RANK: Record<ScenarioStatus, number> = { pass: 2, fail: 1, error: 0, skip: -1 };

function compareScenario(
  base: ScenarioResult | undefined,
  head: ScenarioResult | undefined,
  thresholds: CompareThresholds,
): ScenarioComparison {
  const ref = (head ?? base)!;
  const out: ScenarioComparison = {
    id: ref.id,
    group: ref.group,
    base: base?.status ?? null,
    head: head?.status ?? null,
    verdict: 'same',
    changes: [],
  };
  if (!base || base.status === 'skip') {
    return { ...out, verdict: head && head.status !== 'skip' ? 'added' : 'same' };
  }
  if (!head || head.status === 'skip') return { ...out, verdict: 'removed' };

  if (RANK[head.status] !== RANK[base.status]) {
    return {
      ...out,
      verdict: RANK[head.status] < RANK[base.status] ? 'regression' : 'improvement',
    };
  }

  const changes: MetricChange[] = [];
  const unsafe = { base: base.unsafeActions.length, head: head.unsafeActions.length };
  if (unsafe.base !== unsafe.head) {
    changes.push({
      metric: 'unsafeActions',
      base: unsafe.base,
      head: unsafe.head,
      delta: unsafe.head - unsafe.base,
      pct: null,
      verdict: unsafe.head > unsafe.base ? 'regression' : 'improvement',
    });
  }
  // El coste solo se compara entre dos PASS: entre dos FAIL, gastar menos no
  // es mejorar.
  if (base.status === 'pass' && base.metrics && head.metrics) {
    changes.push(...metricChanges(base.metrics, head.metrics, thresholds));
  }
  const moved = changes.filter((c) => c.verdict !== 'same');
  const verdict: Verdict = moved.some((c) => c.verdict === 'regression')
    ? 'regression'
    : moved.length > 0
      ? 'improvement'
      : 'same';
  return { ...out, verdict, changes: moved };
}

function summaryChanges(base: GroupSummary, head: GroupSummary): MetricChange[] {
  const rows: Array<[string, number | null, number | null, boolean]> = [
    // [métrica, base, head, más es mejor]
    ['successRate', base.successRate, head.successRate, true],
    ['toolErrorRate', base.toolErrorRate, head.toolErrorRate, false],
    ['policyViolationRate', base.policyViolationRate, head.policyViolationRate, false],
    ['unsafeActionRate', base.unsafeActionRate, head.unsafeActionRate, false],
    ['recoveryRate', base.recovery.rate, head.recovery.rate, true],
    ['repeatedCalls', base.repeatedCalls, head.repeatedCalls, false],
    [
      'tokensToSuccess',
      base.toSuccess.tokens?.mean ?? null,
      head.toSuccess.tokens?.mean ?? null,
      false,
    ],
    [
      'timeToSuccessMs',
      base.toSuccess.durationMs?.mean ?? null,
      head.toSuccess.durationMs?.mean ?? null,
      false,
    ],
    [
      'toolCallsToSuccess',
      base.toSuccess.toolCalls?.mean ?? null,
      head.toSuccess.toolCalls?.mean ?? null,
      false,
    ],
  ];
  const out: MetricChange[] = [];
  for (const [metric, b, h, higherIsBetter] of rows) {
    if (b === null || h === null) continue;
    const delta = h - b;
    const worse = higherIsBetter ? delta < 0 : delta > 0;
    out.push({
      metric,
      base: b,
      head: h,
      delta,
      pct: b !== 0 ? delta / b : null,
      // Informativo: el veredicto global sale de los escenarios, no de las medias.
      verdict: Math.abs(delta) < 1e-9 ? 'same' : worse ? 'regression' : 'improvement',
    });
  }
  return out;
}

const describe = (r: EvalResult): Comparison['base'] => ({
  runId: r.runId,
  ...(r.label ? { label: r.label } : {}),
  stratumVersion: r.stratumVersion,
  model: r.provider.model,
  mode: r.mode,
});

export function compareResults(
  base: EvalResult,
  head: EvalResult,
  thresholds: CompareThresholds = DEFAULT_THRESHOLDS,
): Comparison {
  const baseById = new Map(base.scenarios.map((s) => [s.id, s]));
  const headById = new Map(head.scenarios.map((s) => [s.id, s]));
  const ids = [...new Set([...base.scenarios, ...head.scenarios].map((s) => s.id))];
  const scenarios = ids.map((id) =>
    compareScenario(baseById.get(id), headById.get(id), thresholds),
  );

  const notes: string[] = [];
  if (base.mode !== head.mode) {
    notes.push(`Modos distintos (${base.mode} → ${head.mode}): los costes no son comparables.`);
  } else if (base.provider.model !== head.provider.model) {
    notes.push(
      `Modelos distintos (${base.provider.model} → ${head.provider.model}): las diferencias ` +
        'pueden ser del modelo, no de Stratum.',
    );
  }
  if (base.platform !== head.platform) {
    notes.push(`Plataformas distintas (${base.platform} → ${head.platform}).`);
  }

  const regressions = scenarios.filter((s) => s.verdict === 'regression').length;
  const improvements = scenarios.filter((s) => s.verdict === 'improvement').length;
  return {
    base: describe(base),
    head: describe(head),
    thresholds,
    notes,
    scenarios,
    summary: summaryChanges(base.summary.overall, head.summary.overall),
    regressions,
    improvements,
    verdict: regressions > 0 ? 'regression' : improvements > 0 ? 'improvement' : 'same',
  };
}

/**
 * El artefacto de una ejecución de `stratum eval` (`result.json`) y las
 * métricas derivadas que se calculan sobre él. Puro: sin disco.
 */
import type { CheckResult, EvalMode, UnsafeAction } from './checks.js';
import {
  AUXILIARY_LLM_ORIGINS,
  LLM_CALL_ORIGINS,
  sumOriginStats,
  type LlmCallOrigin,
  type LlmOriginStats,
} from '../trace/model.js';
import type { RunMetrics } from './metrics.js';
import type { ToleranceOverrides } from './compare.js';
import { DIFFICULTIES, SCENARIO_GROUPS, type Difficulty, type ScenarioGroup } from './scenario.js';

export const EVAL_RESULT_VERSION = 1;

/** `error` es un fallo del banco de pruebas (setup, arranque), no del agente. */
export type ScenarioStatus = 'pass' | 'fail' | 'error' | 'skip';

export interface ScenarioResult {
  id: string;
  group: ScenarioGroup;
  /** Ausente en resultados anteriores a los niveles de dificultad. */
  difficulty?: Difficulty;
  title: string;
  /** Huella de la definición del escenario (`scenarioFingerprint`). */
  scenarioHash?: string;
  status: ScenarioStatus;
  /** Por qué no pasó (primer criterio incumplido, motivo del skip o del error). */
  reason?: string;
  checks: CheckResult[];
  unsafeActions: UnsafeAction[];
  /** null si no hubo traza (skip, o error antes de arrancar). */
  metrics: RunMetrics | null;
  exitCode: number | null;
  /** Tiempo de pared del proceso `stratum run`, arranque incluido. */
  wallMs: number;
  timedOut: boolean;
  sessionId: string | null;
  /** Traza de la ejecución, relativa a la carpeta del resultado. */
  trace: string | null;
  /**
   * Todas las trazas, en orden, cuando el escenario lanza varias sesiones
   * (`sessions`): `trace` es la primera y las métricas salen de todas.
   */
  traces?: string[];
  /** Solo con guion: peticiones recibidas frente a pasos previstos. */
  mock?: {
    requests: number;
    steps: number;
    /** Lo mismo para cada guion auxiliar del escenario (`auxiliaryScript`). */
    auxiliary?: Record<string, { requests: number; steps: number }>;
  };
}

export interface Distribution {
  mean: number;
  median: number;
}

export interface GroupSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** passed / (passed + failed + errored); null si no se ejecutó ninguno. */
  successRate: number | null;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  /** toolErrors / toolCalls. */
  toolErrorRate: number | null;
  policyBlocks: number;
  /** Llamadas que el runtime tuvo que parar / toolCalls. */
  policyViolationRate: number | null;
  unsafeActions: number;
  /** Ejecuciones con alguna acción insegura / ejecuciones. */
  unsafeActionRate: number | null;
  /** Ejecuciones con algún fallo por el camino, y cuántas acabaron en PASS. */
  recovery: { withErrors: number; recovered: number; rate: number | null };
  repeatedCalls: number;
  retries: number;
  confirmations: number;
  subagents: number;
  tokens: number | null;
  durationMs: number;
  /** Coste de llegar al éxito: solo sobre las ejecuciones en PASS. */
  toSuccess: {
    tokens: Distribution | null;
    durationMs: Distribution | null;
    toolCalls: Distribution | null;
    llmCalls: Distribution | null;
  };
  /**
   * Caché de prompt, sumada sobre las ejecuciones cuyas llamadas la reportaron;
   * null si ninguna. Ausente en resultados anteriores a la métrica.
   */
  cache?: {
    /** Ejecuciones con datos de caché. */
    runs: number;
    reportedCalls: number;
    cachedReadTokens: number;
    cacheWriteTokens: number | null;
    uncachedPromptTokens: number;
    hitRate: number | null;
    coldCalls: number;
    warmCalls: number;
    breaks: number;
    /** Media, por ejecución, del TTFT de sus llamadas frías / templadas. */
    ttftColdMs: number | null;
    ttftWarmMs: number | null;
  } | null;
  /** Media de `prefixStability` de las ejecuciones que la registran. */
  prefixStability?: number | null;
  /**
   * Llamadas al LLM por origen, sumadas sobre las ejecuciones cuya traza
   * registraba las auxiliares; null si ninguna. Ausente en resultados
   * anteriores. `llmCalls` de arriba sigue siendo solo las del loop.
   */
  llm?: {
    /** Ejecuciones con el desglose. */
    runs: number;
    /** Todas las llamadas: loop + auxiliares. */
    calls: number;
    byOrigin: Record<LlmCallOrigin, LlmOriginStats>;
    auxiliary: LlmOriginStats;
    /** Llamadas del loop cuya espera coincidió con alguna auxiliar. */
    overlappedCalls: number;
    overlappingAuxiliaryMs: number;
    precedingAuxiliaryMs: number;
    /** Media, por ejecución, del TTFT del loop con / sin una auxiliar en curso. */
    ttftOverlappedMs: number | null;
    ttftClearMs: number | null;
  } | null;
}

/** Dónde y sobre qué código se ejecutó: lo que hace falta para fiarse de una comparación. */
export interface RunEnvironment {
  os: { platform: string; release: string; arch: string };
  /** Repositorio desde el que se lanzó; null fuera de uno. `dirty`: había cambios sin commit. */
  git: {
    /** `stratum`: el checkout desde el que corre la CLI. `cwd`: el proyecto donde se lanzó. */
    repo?: 'stratum' | 'cwd';
    commit: string;
    branch: string | null;
    dirty: boolean;
  } | null;
}

/** Presente en la copia de un resultado guardada como baseline con nombre. */
export interface BaselineInfo {
  name: string;
  savedAt: string;
  /** Ejecución de la que se copió. */
  runId: string;
  note?: string;
  /** Tolerancias propias de este baseline; `compare` las aplica sobre las de su modo. */
  tolerances?: ToleranceOverrides;
}

export interface EvalResult {
  schemaVersion: number;
  kind: 'stratum-eval';
  runId: string;
  label?: string;
  startedAt: string;
  finishedAt: string;
  stratumVersion: string;
  platform: string;
  node: string;
  mode: EvalMode;
  provider: { name: string; model: string };
  env?: RunEnvironment;
  baseline?: BaselineInfo;
  scenarios: ScenarioResult[];
  summary: {
    overall: GroupSummary;
    groups: Partial<Record<ScenarioGroup, GroupSummary>>;
    difficulties?: Partial<Record<Difficulty, GroupSummary>>;
  };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { mean: sorted.reduce((s, v) => s + v, 0) / sorted.length, median };
}

export function summarizeGroup(results: readonly ScenarioResult[]): GroupSummary {
  const ran = results.filter((r) => r.status !== 'skip');
  const passed = ran.filter((r) => r.status === 'pass');
  const withMetrics = ran.filter((r): r is ScenarioResult & { metrics: RunMetrics } => !!r.metrics);
  const sum = (pick: (m: RunMetrics) => number | null): number =>
    withMetrics.reduce((s, r) => s + (pick(r.metrics) ?? 0), 0);

  const toolCalls = sum((m) => m.toolCalls);
  const withErrors = withMetrics.filter((r) => r.metrics.hadErrors);
  const recovered = withErrors.filter((r) => r.status === 'pass').length;
  const tokenRuns = withMetrics.filter((r) => r.metrics.tokens !== null);
  const meanOf = (pick: (m: RunMetrics) => number | null | undefined): number | null => {
    const values = withMetrics.flatMap((r) => pick(r.metrics) ?? []);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const cacheRuns = withMetrics.filter((r) => (r.metrics.cacheReportedCalls ?? 0) > 0);
  const cacheSum = (pick: (m: RunMetrics) => number | null | undefined): number =>
    cacheRuns.reduce((s, r) => s + (pick(r.metrics) ?? 0), 0);
  const cachedRead = cacheSum((m) => m.cachedReadTokens);
  const uncached = cacheSum((m) => m.uncachedPromptTokens);
  const writeRuns = cacheRuns.filter((r) => typeof r.metrics.cacheWriteTokens === 'number');
  const ofPassed = (pick: (m: RunMetrics) => number | null): Distribution | null =>
    distribution(
      passed.flatMap((r) => {
        const v = r.metrics ? pick(r.metrics) : null;
        return v === null ? [] : [v];
      }),
    );

  return {
    total: results.length,
    passed: passed.length,
    failed: ran.filter((r) => r.status === 'fail').length,
    errored: ran.filter((r) => r.status === 'error').length,
    skipped: results.length - ran.length,
    successRate: ratio(passed.length, ran.length),
    llmCalls: sum((m) => m.llmCalls),
    toolCalls,
    toolErrors: sum((m) => m.toolErrors),
    toolErrorRate: ratio(
      sum((m) => m.toolErrors),
      toolCalls,
    ),
    policyBlocks: sum((m) => m.policyBlocks),
    policyViolationRate: ratio(
      sum((m) => m.policyBlocks),
      toolCalls,
    ),
    unsafeActions: ran.reduce((s, r) => s + r.unsafeActions.length, 0),
    unsafeActionRate: ratio(ran.filter((r) => r.unsafeActions.length > 0).length, ran.length),
    recovery: {
      withErrors: withErrors.length,
      recovered,
      rate: ratio(recovered, withErrors.length),
    },
    repeatedCalls: sum((m) => m.repeatedCalls),
    retries: sum((m) => m.retries),
    confirmations: sum((m) => m.confirmations?.asked ?? 0),
    subagents: sum((m) => m.subagents),
    tokens: tokenRuns.length > 0 ? sum((m) => m.tokens) : null,
    durationMs: sum((m) => m.durationMs),
    toSuccess: {
      tokens: ofPassed((m) => m.tokens),
      durationMs: ofPassed((m) => m.durationMs),
      toolCalls: ofPassed((m) => m.toolCalls),
      llmCalls: ofPassed((m) => m.llmCalls),
    },
    cache:
      cacheRuns.length > 0
        ? {
            runs: cacheRuns.length,
            reportedCalls: cacheSum((m) => m.cacheReportedCalls),
            cachedReadTokens: cachedRead,
            cacheWriteTokens: writeRuns.length > 0 ? cacheSum((m) => m.cacheWriteTokens) : null,
            uncachedPromptTokens: uncached,
            hitRate: ratio(cachedRead, cachedRead + uncached),
            coldCalls: cacheSum((m) => m.coldCalls),
            warmCalls: cacheSum((m) => m.warmCalls),
            breaks: cacheSum((m) => m.cacheBreaks),
            ttftColdMs: meanOf((m) => m.ttftColdMs),
            ttftWarmMs: meanOf((m) => m.ttftWarmMs),
          }
        : null,
    prefixStability: meanOf((m) => m.prefixStability),
    llm: summarizeLlm(withMetrics.map((r) => r.metrics)),
  };
}

function summarizeLlm(metrics: readonly RunMetrics[]): GroupSummary['llm'] {
  const tracked = metrics.flatMap((m) => (m.llmByOrigin ? [{ m, by: m.llmByOrigin }] : []));
  if (tracked.length === 0) return null;
  const byOrigin = {} as Record<LlmCallOrigin, LlmOriginStats>;
  for (const o of LLM_CALL_ORIGINS) byOrigin[o] = sumOriginStats(tracked.map((t) => t.by[o]));
  const total = (pick: (m: RunMetrics) => number | null | undefined): number =>
    tracked.reduce((s, t) => s + (pick(t.m) ?? 0), 0);
  const meanOf = (pick: (m: RunMetrics) => number | null | undefined): number | null => {
    const values = tracked.flatMap((t) => pick(t.m) ?? []);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  return {
    runs: tracked.length,
    calls: LLM_CALL_ORIGINS.reduce((n, o) => n + byOrigin[o].calls, 0),
    byOrigin,
    auxiliary: sumOriginStats(AUXILIARY_LLM_ORIGINS.map((o) => byOrigin[o])),
    overlappedCalls: total((m) => m.overlappedLlmCalls),
    overlappingAuxiliaryMs: total((m) => m.overlappingAuxiliaryMs),
    precedingAuxiliaryMs: total((m) => m.precedingAuxiliaryMs),
    ttftOverlappedMs: meanOf((m) => m.ttftOverlappedMs),
    ttftClearMs: meanOf((m) => m.ttftClearMs),
  };
}

export function summarize(results: readonly ScenarioResult[]): EvalResult['summary'] {
  const groups: Partial<Record<ScenarioGroup, GroupSummary>> = {};
  for (const group of SCENARIO_GROUPS) {
    const inGroup = results.filter((r) => r.group === group);
    if (inGroup.length > 0) groups[group] = summarizeGroup(inGroup);
  }
  const difficulties: Partial<Record<Difficulty, GroupSummary>> = {};
  for (const difficulty of DIFFICULTIES) {
    const atLevel = results.filter((r) => r.difficulty === difficulty);
    if (atLevel.length > 0) difficulties[difficulty] = summarizeGroup(atLevel);
  }
  return { overall: summarizeGroup(results), groups, difficulties };
}

/** ¿Tiene `value` la forma de un `result.json`? (para leer uno de disco). */
export function isEvalResult(value: unknown): value is EvalResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<EvalResult>;
  return v.kind === 'stratum-eval' && Array.isArray(v.scenarios) && typeof v.runId === 'string';
}

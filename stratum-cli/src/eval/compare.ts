/**
 * Comparación de dos ejecuciones de `stratum eval`. El objetivo es ver las
 * regresiones que un PASS/FAIL esconde: el mismo escenario sigue pasando, pero
 * cuesta más tokens, más tiempo, más llamadas o deja más errores por el camino
 * — sin marcar como regresión lo que es ruido. Puro: sin disco.
 */
import type { EvalMode } from './checks.js';
import {
  COMPARABLE_METRICS,
  HIGHER_IS_BETTER,
  type ComparableMetric,
  type RunMetrics,
} from './metrics.js';
import type { EvalResult, GroupSummary, ScenarioResult, ScenarioStatus } from './result.js';
import { DIFFICULTIES, type Difficulty } from './scenario.js';

export type Verdict = 'regression' | 'improvement' | 'same';

/**
 * Cambio que se ignora en una métrica. Un cambio solo cuenta si supera **las
 * dos** cotas: más de `abs` en valor absoluto y más de `pct` sobre la base
 * (con base 0 no hay relativo y decide `abs`). `{ pct: 0, abs: 0 }` = cualquier
 * cambio cuenta.
 */
export interface Tolerance {
  /** Fracción de la base (0.2 = 20 %). */
  pct: number;
  /** En la unidad de la métrica (tokens, ms, nº de llamadas). */
  abs: number;
}

export type Tolerances = Record<ComparableMetric, Tolerance>;
export type ToleranceOverrides = Partial<Record<ComparableMetric, Partial<Tolerance>>>;

const EXACT: Tolerance = { pct: 0, abs: 0 };

/**
 * Con guion la trayectoria es la misma en las dos ejecuciones: lo único que se
 * mueve es el tamaño del prompt (tokens) y el reloj. Un error o una llamada de
 * más es un cambio de comportamiento del runtime, sin margen.
 */
export const MOCK_TOLERANCES: Tolerances = {
  tokens: { pct: 0.2, abs: 200 },
  durationMs: { pct: 0.5, abs: 2000 },
  llmCalls: { pct: 0.2, abs: 0 },
  toolCalls: { pct: 0.2, abs: 0 },
  toolErrors: EXACT,
  llmErrors: EXACT,
  retries: EXACT,
  policyBlocks: EXACT,
  repeatedCalls: EXACT,
  subagentFailures: EXACT,
  // El modelo de guion simula una caché de prefijo exacta: con el mismo prompt,
  // el acierto es el mismo. Las tasas van en puntos (0.02 = 2 puntos).
  cacheHitRate: { pct: 0, abs: 0.02 },
  cachedReadTokens: { pct: 0.1, abs: 100 },
  uncachedPromptTokens: { pct: 0.2, abs: 200 },
  cacheBreaks: EXACT,
  coldCalls: EXACT,
  prefixStability: { pct: 0, abs: 0.02 },
  // El TTFT del guion es un retardo simulado más el ruido del equipo.
  ttftColdMs: { pct: 0.5, abs: 250 },
  ttftWarmMs: { pct: 0.5, abs: 250 },
};

/**
 * Contra un modelo real hay una muestra por escenario y el modelo no repite
 * trayectoria: el mismo código, dos veces, da un escenario resuelto en una
 * llamada y luego en cuatro (se niega de entrada o prueba antes), y la latencia
 * del provider se dobla sola. Calibradas con ejecuciones repetidas del mismo
 * código (ver `docs/eval.md`): cubren lo observado entre ejecuciones idénticas,
 * así que lo que marcan es un cambio de otro orden —el doble de tokens, no un
 * 20 % más—. La precisión fina la da el guion.
 */
export const LIVE_TOLERANCES: Tolerances = {
  tokens: { pct: 1, abs: 25_000 },
  durationMs: { pct: 2, abs: 60_000 },
  llmCalls: { pct: 1, abs: 3 },
  toolCalls: { pct: 1, abs: 3 },
  toolErrors: { pct: 0, abs: 2 },
  llmErrors: { pct: 0, abs: 1 },
  retries: { pct: 0, abs: 2 },
  // Que el modelo intente o no lo que el runtime le va a parar varía en ±1.
  policyBlocks: { pct: 0, abs: 1 },
  repeatedCalls: { pct: 0, abs: 1 },
  subagentFailures: EXACT,
  // La caché de un backend real depende de lo que quedara caliente de antes, de
  // su TTL y de cuántas llamadas hizo el modelo: solo cuenta un cambio grande.
  cacheHitRate: { pct: 0, abs: 0.2 },
  cachedReadTokens: { pct: 1, abs: 25_000 },
  uncachedPromptTokens: { pct: 1, abs: 25_000 },
  cacheBreaks: { pct: 0, abs: 2 },
  coldCalls: { pct: 0, abs: 2 },
  prefixStability: { pct: 0, abs: 0.1 },
  ttftColdMs: { pct: 2, abs: 5000 },
  ttftWarmMs: { pct: 2, abs: 5000 },
};

/** Las tolerancias de partida: holgadas en cuanto una de las dos ejecuciones es live. */
export function defaultTolerances(base: EvalMode, head: EvalMode): Tolerances {
  return base === 'live' || head === 'live' ? LIVE_TOLERANCES : MOCK_TOLERANCES;
}

export function mergeTolerances(
  base: Tolerances,
  ...layers: Array<ToleranceOverrides | undefined>
): Tolerances {
  const out = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const metric of COMPARABLE_METRICS) {
      const over = layer[metric];
      if (over) out[metric] = { ...out[metric], ...over };
    }
  }
  return out;
}

/** Alias cómodos para la línea de comandos. */
const METRIC_ALIASES: Record<string, ComparableMetric> = {
  duration: 'durationMs',
  time: 'durationMs',
  tools: 'toolCalls',
  llm: 'llmCalls',
  errors: 'toolErrors',
  policy: 'policyBlocks',
  repeated: 'repeatedCalls',
  cache: 'cacheHitRate',
  cached: 'cachedReadTokens',
  uncached: 'uncachedPromptTokens',
  breaks: 'cacheBreaks',
  prefix: 'prefixStability',
  ttftCold: 'ttftColdMs',
  ttftWarm: 'ttftWarmMs',
};

export class ToleranceError extends Error {}

const TIME_METRICS: ReadonlySet<ComparableMetric> = new Set([
  'durationMs',
  'ttftColdMs',
  'ttftWarmMs',
]);

function parseAmount(metric: ComparableMetric, text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|k)?$/i.exec(text);
  if (!m) throw new ToleranceError(`"${text}" no es una cantidad válida`);
  const value = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'k') return value * 1000;
  if (unit === 's' || unit === 'ms') {
    if (!TIME_METRICS.has(metric)) {
      throw new ToleranceError(`"${text}": solo el tiempo lleva unidad`);
    }
    return unit === 's' ? value * 1000 : value;
  }
  return value;
}

/**
 * `tokens=30%`, `tokens=500`, `tokens=30%,500`, `duration=100%,10s`,
 * `toolErrors=1`. Varias separadas por espacios o `;`. Un porcentaje fija
 * `pct`; una cantidad, `abs` (en el tiempo, `s` o `ms`; por defecto ms).
 */
export function parseToleranceSpec(spec: string): ToleranceOverrides {
  const out: ToleranceOverrides = {};
  for (const part of spec.split(/[\s;]+/).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new ToleranceError(`"${part}": se esperaba métrica=valor`);
    const name = part.slice(0, eq);
    const metric =
      METRIC_ALIASES[name] ??
      (COMPARABLE_METRICS as readonly string[]).find((m) => m.toLowerCase() === name.toLowerCase());
    if (!metric) {
      throw new ToleranceError(
        `"${name}" no es una métrica comparable. Métricas: ${COMPARABLE_METRICS.join(', ')}.`,
      );
    }
    const key = metric as ComparableMetric;
    const tolerance: Partial<Tolerance> = {};
    for (const value of part
      .slice(eq + 1)
      .split(',')
      .filter(Boolean)) {
      if (value.endsWith('%')) {
        const pct = Number(value.slice(0, -1));
        if (!(pct >= 0)) throw new ToleranceError(`"${value}" no es un porcentaje válido`);
        tolerance.pct = pct / 100;
      } else {
        tolerance.abs = parseAmount(key, value);
      }
    }
    if (tolerance.pct === undefined && tolerance.abs === undefined) {
      throw new ToleranceError(`"${part}": falta el valor`);
    }
    out[key] = { ...out[key], ...tolerance };
  }
  return out;
}

/** Valida unas tolerancias leídas de un JSON (fichero o baseline). */
export function parseToleranceObject(value: unknown): ToleranceOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToleranceError('se esperaba un objeto { métrica: { pct, abs } }');
  }
  const out: ToleranceOverrides = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!(COMPARABLE_METRICS as readonly string[]).includes(name)) {
      throw new ToleranceError(`"${name}" no es una métrica comparable`);
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new ToleranceError(`${name}: se esperaba { pct, abs }`);
    }
    const { pct, abs, ...rest } = raw as Record<string, unknown>;
    const unknown = Object.keys(rest)[0];
    if (unknown) throw new ToleranceError(`${name}: clave desconocida "${unknown}"`);
    const entry: Partial<Tolerance> = {};
    for (const [key, v] of [
      ['pct', pct],
      ['abs', abs],
    ] as const) {
      if (v === undefined) continue;
      if (typeof v !== 'number' || !(v >= 0)) {
        throw new ToleranceError(`${name}.${key}: tiene que ser un número ≥ 0`);
      }
      entry[key] = v;
    }
    out[name as ComparableMetric] = entry;
  }
  return out;
}

/** Qué clase de cosa mide cada métrica: decide en qué bloque del informe sale. */
export type ChangeCategory = 'safety' | 'policy' | 'cost' | 'reliability' | 'cache';

const CATEGORY: Record<ComparableMetric, ChangeCategory> = {
  tokens: 'cost',
  durationMs: 'cost',
  llmCalls: 'cost',
  toolCalls: 'cost',
  toolErrors: 'reliability',
  llmErrors: 'reliability',
  retries: 'reliability',
  repeatedCalls: 'reliability',
  subagentFailures: 'reliability',
  policyBlocks: 'policy',
  // Aparte de `cost` y de `reliability`: un fallo de caché cuesta tiempo y
  // dinero, pero ni es un error del agente ni cambia lo que hace.
  cacheHitRate: 'cache',
  cachedReadTokens: 'cache',
  uncachedPromptTokens: 'cache',
  cacheBreaks: 'cache',
  coldCalls: 'cache',
  prefixStability: 'cache',
  ttftColdMs: 'cache',
  ttftWarmMs: 'cache',
};

export interface MetricChange {
  metric: string;
  category?: ChangeCategory;
  base: number;
  head: number;
  delta: number;
  /** Cambio relativo; null si la base es 0. */
  pct: number | null;
  verdict: Verdict;
}

/**
 * Cambio de estado entre las dos ejecuciones. `unresolved`: no pasaba y sigue
 * sin pasar, pero de otra manera (FAIL ↔ ERROR).
 */
export type Transition =
  | 'pass_to_fail'
  | 'pass_to_error'
  | 'fail_to_pass'
  | 'error_to_pass'
  | 'unresolved';

export interface ScenarioComparison {
  id: string;
  group: string;
  difficulty?: Difficulty;
  base: ScenarioStatus | null;
  head: ScenarioStatus | null;
  /** `added` / `removed`: solo está en una de las dos ejecuciones. */
  verdict: Verdict | 'added' | 'removed';
  transition: Transition | null;
  /** Solo los cambios que superan la tolerancia. */
  changes: MetricChange[];
  /** Por qué no pasa ahora (el `reason` de la ejecución juzgada). */
  reason?: string;
  /** El escenario no es el mismo en las dos ejecuciones: no se compara el coste. */
  definitionChanged: boolean;
}

interface RunInfo {
  runId: string;
  label?: string;
  baseline?: string;
  stratumVersion: string;
  commit?: string;
  model: string;
  mode: string;
  platform: string;
  startedAt: string;
}

/** Ids de escenario por hallazgo, en el orden en que el informe los destaca. */
export interface Highlights {
  passToFail: string[];
  passToError: string[];
  newUnsafeActions: string[];
  morePolicyBlocks: string[];
  costRegressions: string[];
  reliabilityRegressions: string[];
  /** Menos acierto de caché, más roturas o peor TTFT, con el mismo resultado. */
  cacheRegressions: string[];
  improvements: string[];
  unresolved: string[];
  added: string[];
  removed: string[];
}

export interface Comparison {
  base: RunInfo;
  head: RunInfo;
  tolerances: Tolerances;
  /** Avisos sobre la comparación en sí (modos, modelos o escenarios distintos). */
  notes: string[];
  scenarios: ScenarioComparison[];
  highlights: Highlights;
  /** PASS / ejecutados por dificultad, en cada ejecución. */
  difficulties: Array<{
    difficulty: Difficulty;
    base: { passed: number; ran: number } | null;
    head: { passed: number; ran: number } | null;
  }>;
  summary: MetricChange[];
  regressions: number;
  improvements: number;
  verdict: Verdict;
}

/**
 * Veredicto de un cambio en una métrica. Por defecto menos es mejor;
 * `higherIsBetter` lo invierte (acierto de caché, tokens servidos de caché).
 */
export function judge(
  base: number,
  head: number,
  tolerance: Tolerance,
  higherIsBetter = false,
): Verdict {
  const delta = head - base;
  const size = Math.abs(delta);
  // El épsilon cubre el redondeo de las tasas (0.82 − 0.8 no es 0.02 exacto).
  if (size === 0 || size <= tolerance.abs + 1e-9) return 'same';
  // Con base 0 no hay relativo: decide el absoluto.
  if (base > 0 && size / base <= tolerance.pct) return 'same';
  return delta > 0 !== higherIsBetter ? 'regression' : 'improvement';
}

function metricChanges(
  base: RunMetrics,
  head: RunMetrics,
  tolerances: Tolerances,
  categories: ReadonlySet<ChangeCategory>,
): MetricChange[] {
  const out: MetricChange[] = [];
  for (const metric of COMPARABLE_METRICS) {
    if (!categories.has(CATEGORY[metric])) continue;
    const b = base[metric];
    const h = head[metric];
    // Un dato que una de las dos trazas no tiene no se compara (ni se inventa):
    // null si no se reportó, undefined en un resultado anterior a la métrica.
    if (b === null || h === null || b === undefined || h === undefined) continue;
    let verdict = judge(b, h, tolerances[metric], HIGHER_IS_BETTER.has(metric));
    if (metric === 'cachedReadTokens' && verdict !== 'same') {
      // Menos tokens de caché solo es peor si no es porque el prompt encogió, y
      // más solo es mejor si no es porque creció: lo que decide es si lo que
      // dejó de salir de caché hubo que procesarlo (o al revés).
      const bu = base.uncachedPromptTokens;
      const hu = head.uncachedPromptTokens;
      const traded =
        typeof bu === 'number' &&
        typeof hu === 'number' &&
        (verdict === 'regression' ? hu > bu : hu < bu);
      if (!traded) verdict = 'same';
    }
    out.push({
      metric,
      category: CATEGORY[metric],
      base: b,
      head: h,
      delta: h - b,
      pct: b !== 0 ? (h - b) / b : null,
      verdict,
    });
  }
  return out;
}

function transitionOf(base: ScenarioStatus, head: ScenarioStatus): Transition | null {
  if (base === head) return null;
  if (base === 'pass') return head === 'fail' ? 'pass_to_fail' : 'pass_to_error';
  if (head === 'pass') return base === 'fail' ? 'fail_to_pass' : 'error_to_pass';
  return 'unresolved';
}

const TRANSITION_VERDICT: Record<Transition, Verdict> = {
  pass_to_fail: 'regression',
  // El banco de pruebas falló (provider, setup): no se sabe si el agente
  // regresó, y por eso mismo no se puede dar la comparación por buena.
  pass_to_error: 'regression',
  fail_to_pass: 'improvement',
  error_to_pass: 'improvement',
  unresolved: 'same',
};

const ALL_CATEGORIES: ReadonlySet<ChangeCategory> = new Set([
  'policy',
  'cost',
  'reliability',
  'cache',
]);
const POLICY_ONLY: ReadonlySet<ChangeCategory> = new Set(['policy']);

function compareScenario(
  base: ScenarioResult | undefined,
  head: ScenarioResult | undefined,
  tolerances: Tolerances,
  sameMode: boolean,
): ScenarioComparison {
  const ref = (head ?? base)!;
  const out: ScenarioComparison = {
    id: ref.id,
    group: ref.group,
    ...(ref.difficulty ? { difficulty: ref.difficulty } : {}),
    base: base?.status ?? null,
    head: head?.status ?? null,
    verdict: 'same',
    transition: null,
    changes: [],
    definitionChanged: false,
  };
  if (!base || base.status === 'skip') {
    return { ...out, verdict: head && head.status !== 'skip' ? 'added' : 'same' };
  }
  if (!head || head.status === 'skip') return { ...out, verdict: 'removed' };

  const definitionChanged =
    base.scenarioHash !== undefined &&
    head.scenarioHash !== undefined &&
    base.scenarioHash !== head.scenarioHash;
  const transition = transitionOf(base.status, head.status);

  const changes: MetricChange[] = [];
  // Una acción insegura nueva cuenta siempre, pase lo que pase con el estado.
  const unsafe = { base: base.unsafeActions.length, head: head.unsafeActions.length };
  if (unsafe.base !== unsafe.head) {
    changes.push({
      metric: 'unsafeActions',
      category: 'safety',
      base: unsafe.base,
      head: unsafe.head,
      delta: unsafe.head - unsafe.base,
      pct: null,
      verdict: unsafe.head > unsafe.base ? 'regression' : 'improvement',
    });
  }
  if (!transition && !definitionChanged && base.metrics && head.metrics) {
    if (base.status === 'pass') {
      // El coste solo se compara entre dos PASS del mismo modo: entre dos FAIL,
      // gastar menos no es mejorar, y un guion no cuesta lo que un modelo.
      changes.push(
        ...metricChanges(
          base.metrics,
          head.metrics,
          tolerances,
          sameMode ? ALL_CATEGORIES : POLICY_ONLY,
        ),
      );
    } else if (base.status === 'fail') {
      changes.push(...metricChanges(base.metrics, head.metrics, tolerances, POLICY_ONLY));
    }
  }

  const moved = changes.filter((c) => c.verdict !== 'same');
  const verdicts = [
    ...(transition ? [TRANSITION_VERDICT[transition]] : []),
    ...moved.map((c) => c.verdict),
  ];
  const verdict: Verdict = verdicts.includes('regression')
    ? 'regression'
    : verdicts.includes('improvement')
      ? 'improvement'
      : 'same';
  return {
    ...out,
    verdict,
    transition,
    changes: moved,
    definitionChanged,
    ...(head.status !== 'pass' && head.reason ? { reason: head.reason } : {}),
  };
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
    ['cacheHitRate', base.cache?.hitRate ?? null, head.cache?.hitRate ?? null, true],
    [
      'cachedReadTokens',
      base.cache?.cachedReadTokens ?? null,
      head.cache?.cachedReadTokens ?? null,
      true,
    ],
    [
      'uncachedPromptTokens',
      base.cache?.uncachedPromptTokens ?? null,
      head.cache?.uncachedPromptTokens ?? null,
      false,
    ],
    ['cacheBreaks', base.cache?.breaks ?? null, head.cache?.breaks ?? null, false],
    ['prefixStability', base.prefixStability ?? null, head.prefixStability ?? null, true],
    ['ttftColdMs', base.cache?.ttftColdMs ?? null, head.cache?.ttftColdMs ?? null, false],
    ['ttftWarmMs', base.cache?.ttftWarmMs ?? null, head.cache?.ttftWarmMs ?? null, false],
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

const describe = (r: EvalResult): RunInfo => ({
  runId: r.runId,
  ...(r.label ? { label: r.label } : {}),
  ...(r.baseline ? { baseline: r.baseline.name } : {}),
  stratumVersion: r.stratumVersion,
  ...(r.env?.git ? { commit: r.env.git.commit + (r.env.git.dirty ? '+' : '') } : {}),
  model: r.provider.model,
  mode: r.mode,
  platform: r.platform,
  startedAt: r.startedAt,
});

function highlightsOf(scenarios: readonly ScenarioComparison[]): Highlights {
  const ids = (pick: (s: ScenarioComparison) => boolean): string[] =>
    scenarios.filter(pick).map((s) => s.id);
  const regressed = (s: ScenarioComparison, category: ChangeCategory): boolean =>
    s.changes.some((c) => c.category === category && c.verdict === 'regression');
  return {
    passToFail: ids((s) => s.transition === 'pass_to_fail'),
    passToError: ids((s) => s.transition === 'pass_to_error'),
    newUnsafeActions: ids((s) => regressed(s, 'safety')),
    morePolicyBlocks: ids((s) => regressed(s, 'policy')),
    costRegressions: ids((s) => regressed(s, 'cost')),
    reliabilityRegressions: ids((s) => regressed(s, 'reliability')),
    cacheRegressions: ids((s) => regressed(s, 'cache')),
    improvements: ids((s) => s.verdict === 'improvement'),
    unresolved: ids((s) => s.transition === 'unresolved'),
    added: ids((s) => s.verdict === 'added'),
    removed: ids((s) => s.verdict === 'removed'),
  };
}

function difficultyRows(base: EvalResult, head: EvalResult): Comparison['difficulties'] {
  const count = (r: EvalResult, d: Difficulty): { passed: number; ran: number } | null => {
    const s = r.summary.difficulties?.[d];
    return s ? { passed: s.passed, ran: s.total - s.skipped } : null;
  };
  return DIFFICULTIES.map((difficulty) => ({
    difficulty,
    base: count(base, difficulty),
    head: count(head, difficulty),
  })).filter((row) => row.base !== null || row.head !== null);
}

export function compareResults(
  base: EvalResult,
  head: EvalResult,
  overrides?: ToleranceOverrides,
): Comparison {
  // Las tolerancias que viajan con el baseline valen para toda comparación
  // contra él; lo que se pasa aquí (la línea de comandos) va por encima.
  const tolerances = mergeTolerances(
    defaultTolerances(base.mode, head.mode),
    base.baseline?.tolerances,
    overrides,
  );
  const sameMode = base.mode === head.mode;
  const baseById = new Map(base.scenarios.map((s) => [s.id, s]));
  const headById = new Map(head.scenarios.map((s) => [s.id, s]));
  const ids = [...new Set([...base.scenarios, ...head.scenarios].map((s) => s.id))];
  const scenarios = ids.map((id) =>
    compareScenario(baseById.get(id), headById.get(id), tolerances, sameMode),
  );

  const notes: string[] = [];
  if (!sameMode) {
    notes.push(`Modos distintos (${base.mode} → ${head.mode}): no se compara el coste.`);
  } else if (base.provider.model !== head.provider.model) {
    notes.push(
      `Modelos distintos (${base.provider.model} → ${head.provider.model}): las diferencias ` +
        'pueden ser del modelo, no de Stratum.',
    );
  }
  if (base.platform !== head.platform) {
    notes.push(`Plataformas distintas (${base.platform} → ${head.platform}).`);
  }
  const changed = scenarios.filter((s) => s.definitionChanged).length;
  if (changed > 0) {
    notes.push(
      `${changed} escenario(s) cambiaron de definición entre las dos ejecuciones: ` +
        'se compara su estado, no su coste.',
    );
  }
  if (head.mode === 'live' && scenarios.some((s) => s.transition === 'pass_to_error')) {
    notes.push(
      'Hay escenarios que pasaban y ahora dan ERROR (provider o banco de pruebas): ' +
        'repite la ejecución antes de dar la comparación por buena.',
    );
  }

  const regressions = scenarios.filter((s) => s.verdict === 'regression').length;
  const improvements = scenarios.filter((s) => s.verdict === 'improvement').length;
  return {
    base: describe(base),
    head: describe(head),
    tolerances,
    notes,
    scenarios,
    highlights: highlightsOf(scenarios),
    difficulties: difficultyRows(base, head),
    summary: summaryChanges(base.summary.overall, head.summary.overall),
    regressions,
    improvements,
    verdict: regressions > 0 ? 'regression' : improvements > 0 ? 'improvement' : 'same',
  };
}

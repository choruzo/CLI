/**
 * Métricas de una trayectoria, calculadas **solo** a partir de su traza
 * (`src/trace/`): es lo que comparten `stratum eval` (una ejecución de un
 * escenario) y `stratum stats` (las sesiones que ya hay en disco). Puro: sin
 * disco ni reloj, la misma traza da siempre los mismos números.
 */
import {
  applyRecords,
  auxiliaryImpact,
  cacheSummary,
  COMPRESSION_STEP,
  emptyTrace,
  isAuxiliaryCall,
  isBackgroundStep,
  llmBreakdown,
  meanTtft,
  prefixStability,
  usageOf,
  type LlmCallOrigin,
  type LlmOriginStats,
  type TraceModel,
  type TraceStep,
} from '../trace/model.js';
import { TRACE_CAP_RUNTIME, type TraceRecord } from '../trace/records.js';

export interface RunMetrics {
  turns: number;
  /** Tiempo activo: la suma de los turnos, sin la espera al usuario entre ellos. */
  durationMs: number;
  llmCalls: number;
  /** Llamadas al modelo que acabaron en error (tras agotar los reintentos). */
  llmErrors: number;
  /** null si ninguna llamada reportó `usage`: no se estima. */
  tokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Pasos de herramienta, incluidas las tools de control y las de los subagentes. */
  toolCalls: number;
  /** Tools que fallaron, sin contar las que el runtime bloqueó (`policyBlocks`). */
  toolErrors: number;
  /** Llamadas que el runtime no dejó ejecutar: vetos + confirmaciones denegadas o bloqueadas. */
  policyBlocks: number | null;
  /** Confirmaciones pedidas. null en una traza que no las registraba. */
  confirmations: { asked: number; approved: number; denied: number; blocked: number } | null;
  /** Reintentos de llamadas al modelo. null en una traza que no los registraba. */
  retries: number | null;
  providerFallbacks: number;
  subagents: number;
  subagentFailures: number;
  /** Llamadas idénticas a una anterior sin que nada cambiase entre medias. */
  repeatedCalls: number;
  warnings: number;
  fatalErrors: number;
  compressions: number;
  /** `stopReason` del último turno cerrado. */
  stopReason: string | null;
  /** Hubo algún fallo por el camino (tool, modelo, reintento, fallback, subagente). */
  hadErrors: boolean;
  /**
   * Caché de prompt. Opcionales porque un `result.json` anterior no los trae, y
   * null cuando ninguna llamada reportó caché: un fallo de caché no es un error
   * del agente y no entra en `hadErrors` ni en ninguna tasa de fiabilidad.
   */
  /** Llamadas que reportaron caché; las cifras siguientes son solo de ellas. */
  cacheReportedCalls?: number;
  cachedReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  uncachedPromptTokens?: number | null;
  /** cachedReadTokens / promptTokens de las llamadas que reportaron. */
  cacheHitRate?: number | null;
  /** Llamadas sin nada reutilizado / con algo reutilizado. */
  coldCalls?: number | null;
  warmCalls?: number | null;
  /** Llamadas que leyeron de caché menos tokens que la anterior del mismo agente (pérdida demostrable). */
  cacheBreaks?: number | null;
  /** Tiempo medio hasta el primer token: de todas, de las frías y de las templadas. */
  ttftMs?: number | null;
  ttftColdMs?: number | null;
  ttftWarmMs?: number | null;
  /** Fracción del prompt que repite el de la llamada anterior (medida en el cliente). */
  prefixStability?: number | null;
  /**
   * Llamadas al LLM por origen. `llmCalls`, `tokens`, la caché y el TTFT de
   * arriba son solo del loop (agente + subagentes), como siempre: las
   * auxiliares van aquí aparte y un fallo suyo no entra en `llmErrors`,
   * `toolErrors` ni `hadErrors`. Opcionales (un `result.json` anterior no los
   * trae) y null en una traza que no registraba las auxiliares: que no
   * aparezcan no quiere decir que no las hubiera.
   */
  /** Todas las llamadas de la traza: `llmCalls` + `auxiliaryLlmCalls`. */
  totalLlmCalls?: number;
  agentLlmCalls?: number;
  subagentLlmCalls?: number;
  auxiliaryLlmCalls?: number | null;
  memoryExtractionCalls?: number | null;
  compressionCalls?: number | null;
  sessionSummaryCalls?: number | null;
  /** Auxiliares que acabaron en error (no las canceladas). */
  auxiliaryLlmErrors?: number | null;
  auxiliaryPromptTokens?: number | null;
  auxiliaryCompletionTokens?: number | null;
  auxiliaryCachedReadTokens?: number | null;
  auxiliaryCacheHitRate?: number | null;
  /** Suma de la duración de las llamadas auxiliares. */
  auxiliaryDurationMs?: number | null;
  /** Desglose completo por origen (`llmBreakdown`). */
  llmByOrigin?: Record<LlmCallOrigin, LlmOriginStats> | null;
  /**
   * Coincidencia en el tiempo entre las llamadas del loop y las auxiliares,
   * medida con los relojes del cliente (`auxiliaryImpact`). No es tiempo de cola
   * del servidor: eso no se mide.
   */
  overlappedLlmCalls?: number | null;
  overlappingAuxiliaryMs?: number | null;
  precedingAuxiliaryMs?: number | null;
  /** TTFT medio del loop con / sin una auxiliar en curso durante la espera. */
  ttftOverlappedMs?: number | null;
  ttftClearMs?: number | null;
}

/**
 * Métricas de las llamadas auxiliares que `compare` sabe comparar, pero solo si
 * se piden (`--metric`): todavía no hay datos reales con los que fijarles una
 * tolerancia, así que por defecto ni cuentan como regresión ni como mejora.
 */
export const AUXILIARY_METRICS = [
  'auxiliaryLlmCalls',
  'memoryExtractionCalls',
  'compressionCalls',
  'auxiliaryLlmErrors',
  'auxiliaryPromptTokens',
  'auxiliaryCachedReadTokens',
  'auxiliaryDurationMs',
  'overlappingAuxiliaryMs',
  'precedingAuxiliaryMs',
] as const;
export type AuxiliaryMetric = (typeof AUXILIARY_METRICS)[number];

/** En estas, más es mejor; en el resto de `AUXILIARY_METRICS`, menos. */
export const AUXILIARY_HIGHER_IS_BETTER: ReadonlySet<AuxiliaryMetric> = new Set([
  'auxiliaryCachedReadTokens',
]);

/** Métricas numéricas comparables entre dos ejecuciones. */
export const COMPARABLE_METRICS = [
  'tokens',
  'durationMs',
  'llmCalls',
  'toolCalls',
  'toolErrors',
  'llmErrors',
  'retries',
  'policyBlocks',
  'repeatedCalls',
  'subagentFailures',
  'cacheHitRate',
  'cachedReadTokens',
  'uncachedPromptTokens',
  'cacheBreaks',
  'coldCalls',
  'prefixStability',
  'ttftColdMs',
  'ttftWarmMs',
] as const;
export type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

/** En estas, más es mejor; en el resto de `COMPARABLE_METRICS`, menos. */
export const HIGHER_IS_BETTER: ReadonlySet<ComparableMetric> = new Set([
  'cacheHitRate',
  'cachedReadTokens',
  'prefixStability',
]);

/** Tools que solo observan: repetirlas sin un cambio entre medias no aporta nada. */
const OBSERVING_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_directory',
  'web_search',
  'web_fetch',
  'recall_decisions',
]);

export function buildTraceModel(records: readonly TraceRecord[]): TraceModel {
  return applyRecords(emptyTrace(), records);
}

/** ¿Registraba esta traza las decisiones del runtime? (las anteriores al cap, no). */
export function hasRuntimeEvents(records: readonly TraceRecord[]): boolean {
  return records.some((r) => r.t === 'meta' && r.caps?.includes(TRACE_CAP_RUNTIME) === true);
}

const eventOf = (s: TraceStep): string | null =>
  s.kind === 'notice' && typeof s.data.event === 'string' ? s.data.event : null;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

/**
 * Llamadas repetidas, con una regla que no da falsos positivos razonables: la
 * misma tool con los mismos argumentos que una llamada anterior del mismo
 * agente y turno, sin que entre las dos se haya ejecutado nada que cambie el
 * estado. Releer un fichero tras editarlo no cuenta; releerlo dos veces
 * seguidas, o relanzar tal cual el comando que acaba de fallar, sí.
 */
export function countRepeatedCalls(model: TraceModel): number {
  const seenByScope = new Map<string, Set<string>>();
  let repeated = 0;
  for (const s of model.steps) {
    if (s.kind !== 'tool') continue;
    const scope = `${s.turn}:${s.parent ?? ''}`;
    let seen = seenByScope.get(scope);
    if (!seen) seenByScope.set(scope, (seen = new Set()));
    const key = `${s.name}:${canonical(s.data.input)}`;
    if (seen.has(key)) repeated++;
    if (!OBSERVING_TOOLS.has(s.name)) seen.clear();
    seen.add(key);
  }
  return repeated;
}

const callKey = (s: TraceStep, callId: unknown): string =>
  `${s.turn}:${s.parent ?? ''}:${String(callId)}`;

/** ¿Es este aviso una llamada que el runtime no dejó ejecutar? */
function isPolicyBlock(s: TraceStep): boolean {
  const ev = eventOf(s);
  if (ev === 'veto') return true;
  return ev === 'confirmation' && s.data.decision !== 'approved' && s.data.decision !== 'allow-all';
}

/**
 * Pasos de herramienta que el runtime bloqueó (veto o confirmación no
 * aprobada): su `tool_error` es la política haciendo su trabajo, no un fallo de
 * la tool. Los ids del modelo se repiten entre turnos, así que la clave lleva
 * turno y agente.
 */
export function blockedToolSteps(model: TraceModel): Set<string> {
  const keys = new Set<string>();
  for (const s of model.steps) if (isPolicyBlock(s)) keys.add(callKey(s, s.data.callId));
  const ids = new Set<string>();
  for (const s of model.steps) {
    if (s.kind === 'tool' && s.status === 'error' && keys.has(callKey(s, s.data.callId))) {
      ids.add(s.id);
    }
  }
  return ids;
}

/** ¿Llegó a ejecutarse la llamada? (ok, o un comando que corrió y salió ≠ 0). */
export function stepExecuted(s: TraceStep): boolean {
  return s.status === 'ok' || s.data.executed === true;
}

export function computeMetrics(records: readonly TraceRecord[], now = 0): RunMetrics {
  const model = buildTraceModel(records);
  const runtime = hasRuntimeEvents(records);

  let llmCalls = 0;
  let llmErrors = 0;
  let toolCalls = 0;
  let toolErrorSteps = 0;
  let subagents = 0;
  let subagentFailures = 0;
  let warnings = 0;
  let fatalErrors = 0;
  let compressions = 0;
  let providerFallbacks = 0;
  let retries = 0;
  let vetoes = 0;
  const conf = { asked: 0, approved: 0, denied: 0, blocked: 0 };
  let tokens = 0;
  let prompt = 0;
  let completion = 0;
  let usageSeen = false;
  const blocked = blockedToolSteps(model);

  for (const s of model.steps) {
    if (s.kind === 'model') {
      // Las auxiliares se cuentan aparte (`llm`, más abajo): ni son del turno
      // ni un fallo suyo es un fallo del agente.
      if (isAuxiliaryCall(s)) continue;
      llmCalls++;
      if (s.status === 'error') llmErrors++;
      const u = usageOf(s);
      if (u) {
        usageSeen = true;
        prompt += u.promptTokens ?? 0;
        completion += u.completionTokens ?? 0;
        tokens += u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
      }
    } else if (s.kind === 'subagent') {
      subagents++;
      if (s.status === 'error') subagentFailures++;
    } else if (s.kind === 'context') {
      if (s.name === COMPRESSION_STEP) compressions++;
    } else if (s.kind === 'notice') {
      const ev = eventOf(s);
      if (ev === 'retry') retries++;
      else if (ev === 'veto') vetoes++;
      else if (ev === 'confirmation') {
        conf.asked++;
        const d = s.data.decision;
        if (d === 'approved' || d === 'allow-all') conf.approved++;
        else if (d === 'blocked') conf.blocked++;
        else conf.denied++;
      } else if (s.status === 'error') {
        if (s.data.fatal === true) fatalErrors++;
      } else {
        warnings++;
        if (String(s.data.message ?? '').startsWith('provider_fallback:')) providerFallbacks++;
      }
    }
  }
  for (const s of model.steps) {
    if (s.kind !== 'tool') continue;
    toolCalls++;
    if (s.status === 'error' && !blocked.has(s.id)) toolErrorSteps++;
  }

  const closed = model.turns.filter((t) => t.end !== null);
  const cache = cacheSummary(model);
  const policyBlocks = vetoes + conf.denied + conf.blocked;
  const durationMs = model.turns.reduce((sum, t, i) => {
    let end = t.end ?? t.at;
    for (const s of model.steps) {
      // La extracción de memoria corre con el turno ya cerrado: no lo alarga.
      if (s.turn === i && !isBackgroundStep(model, s)) end = Math.max(end, s.end ?? now);
    }
    return sum + Math.max(end - t.at, 0);
  }, 0);
  const llm = llmBreakdown(model, now);
  const aux = llm.auxiliaryTracked ? llm.auxiliary : null;
  const impact = llm.auxiliaryTracked ? auxiliaryImpact(model, now) : null;

  return {
    turns: model.turns.filter((t) => !t.implicit).length,
    durationMs,
    llmCalls,
    llmErrors,
    tokens: usageSeen ? tokens : null,
    promptTokens: usageSeen ? prompt : null,
    completionTokens: usageSeen ? completion : null,
    toolCalls,
    toolErrors: toolErrorSteps,
    policyBlocks: runtime ? policyBlocks : null,
    confirmations: runtime ? conf : null,
    retries: runtime ? retries : null,
    providerFallbacks,
    subagents,
    subagentFailures,
    repeatedCalls: countRepeatedCalls(model),
    warnings,
    fatalErrors,
    compressions,
    stopReason: closed.length > 0 ? closed[closed.length - 1]!.stop : null,
    hadErrors:
      toolErrorSteps + llmErrors + retries + providerFallbacks + subagentFailures + fatalErrors > 0,
    cacheReportedCalls: cache?.reportedCalls ?? 0,
    cachedReadTokens: cache?.cachedReadTokens ?? null,
    cacheWriteTokens: cache?.cacheWriteTokens ?? null,
    uncachedPromptTokens: cache?.uncachedPromptTokens ?? null,
    cacheHitRate: cache?.hitRate ?? null,
    coldCalls: cache?.coldCalls ?? null,
    warmCalls: cache?.warmCalls ?? null,
    cacheBreaks: cache?.breaks ?? null,
    ttftMs: meanTtft(model),
    ttftColdMs: cache?.ttftColdMs ?? null,
    ttftWarmMs: cache?.ttftWarmMs ?? null,
    prefixStability: prefixStability(model),
    totalLlmCalls: llm.calls,
    agentLlmCalls: llm.byOrigin.agent.calls,
    subagentLlmCalls: llm.byOrigin.subagent.calls,
    auxiliaryLlmCalls: aux ? aux.calls : null,
    memoryExtractionCalls: aux ? llm.byOrigin['memory-extraction'].calls : null,
    compressionCalls: aux ? llm.byOrigin['context-compression'].calls : null,
    sessionSummaryCalls: aux ? llm.byOrigin['session-summary'].calls : null,
    auxiliaryLlmErrors: aux ? aux.errors : null,
    auxiliaryPromptTokens: aux ? aux.promptTokens : null,
    auxiliaryCompletionTokens: aux ? aux.completionTokens : null,
    auxiliaryCachedReadTokens: aux ? aux.cachedReadTokens : null,
    auxiliaryCacheHitRate: aux ? aux.cacheHitRate : null,
    auxiliaryDurationMs: aux ? aux.durationMs : null,
    llmByOrigin: llm.auxiliaryTracked ? llm.byOrigin : null,
    overlappedLlmCalls: impact ? impact.overlappedCalls : null,
    overlappingAuxiliaryMs: impact ? impact.overlappingAuxiliaryMs : null,
    precedingAuxiliaryMs: impact ? impact.precedingAuxiliaryMs : null,
    ttftOverlappedMs: impact ? impact.ttftOverlappedMs : null,
    ttftClearMs: impact ? impact.ttftClearMs : null,
  };
}

/** Por turno: ¿hubo fallos? ¿acabó bien? (lo usa `stats` para la tasa de recuperación). */
export function turnOutcomes(
  records: readonly TraceRecord[],
): Array<{ errors: number; stop: string | null }> {
  const model = buildTraceModel(records);
  const blocked = blockedToolSteps(model);
  const out = model.turns.map((t) => ({ errors: 0, stop: t.stop }));
  for (const s of model.steps) {
    const t = out[s.turn];
    // Una auxiliar que falla no es un fallo del turno: la respuesta ya estaba dada.
    if (!t || blocked.has(s.id) || isAuxiliaryCall(s)) continue;
    const failed =
      ((s.kind === 'tool' || s.kind === 'model' || s.kind === 'subagent') &&
        s.status === 'error') ||
      eventOf(s) === 'retry';
    if (failed) t.errors++;
  }
  return out;
}

/**
 * Métricas de una trayectoria, calculadas **solo** a partir de su traza
 * (`src/trace/`): es lo que comparten `stratum eval` (una ejecución de un
 * escenario) y `stratum stats` (las sesiones que ya hay en disco). Puro: sin
 * disco ni reloj, la misma traza da siempre los mismos números.
 */
import {
  applyRecords,
  emptyTrace,
  usageOf,
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
}

/** Métricas numéricas comparables entre dos ejecuciones; en todas, menos es mejor. */
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
] as const;
export type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

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
      if (s.name === 'Contexto comprimido') compressions++;
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
  const policyBlocks = vetoes + conf.denied + conf.blocked;
  const durationMs = model.turns.reduce((sum, t, i) => {
    let end = t.end ?? t.at;
    for (const s of model.steps) if (s.turn === i) end = Math.max(end, s.end ?? now);
    return sum + Math.max(end - t.at, 0);
  }, 0);

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
    if (!t || blocked.has(s.id)) continue;
    const failed =
      ((s.kind === 'tool' || s.kind === 'model' || s.kind === 'subagent') &&
        s.status === 'error') ||
      eventOf(s) === 'retry';
    if (failed) t.errors++;
  }
  return out;
}

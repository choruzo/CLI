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
import {
  TRACE_CAP_INBOX,
  TRACE_CAP_JOBS,
  TRACE_CAP_RUNTIME,
  type TraceRecord,
} from '../trace/records.js';
import { isJobTool } from '../jobs/types.js';

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
  /**
   * Jobs en segundo plano (`exec` con `background: true`). `toolCalls` y
   * `toolErrors` no cambian: lanzar un job es una llamada a `exec` como otra
   * cualquiera, y lo que le pase después al job no es un error de la tool.
   * Opcionales (un `result.json` anterior no los trae) y null en una traza
   * que no registraba los jobs.
   */
  /** Llamadas a `exec` en primer plano / que pidieron segundo plano. */
  foregroundExecCalls?: number;
  backgroundExecCalls?: number;
  jobsStarted?: number | null;
  jobsCompleted?: number | null;
  jobsFailed?: number | null;
  jobsCancelled?: number | null;
  /** Jobs cuya salida leyó algún agente. */
  jobsOutputRead?: number | null;
  /** Avisos de fin de job entregados al agente por el loop. */
  jobNotifications?: number | null;
  /** Bytes que escribieron los jobs (stdout + stderr), se conservasen o no. */
  jobOutputBytes?: number | null;
  /**
   * Runtime Inbox (`agent/inbox.ts`): lo que llegó con el agente trabajando.
   * Opcionales y null en una traza que no la registraba. Son informativas:
   * `compare` no las juzga, y una llamada que el steering dejó sin ejecutar no
   * cuenta ni como `toolErrors` ni como `policyBlocks`.
   */
  /** Eventos que entraron en la inbox (mensajes del usuario + finales de job). */
  runtimeUpdatesReceived?: number | null;
  /** Eventos que un punto seguro entregó al modelo. */
  runtimeUpdatesConsumed?: number | null;
  /** Mensajes del usuario enviados con un turno en curso. */
  userSteeringMessages?: number | null;
  /** Entregas que llevaban al menos un mensaje del usuario (varios juntos cuentan una). */
  steeringBatches?: number | null;
  /** Media de lo que esperó un mensaje del usuario en la cola hasta entregarse. */
  steeringLatencyMs?: number | null;
  /** Lotes de tool calls que no se ejecutaron porque el usuario escribió antes del dispatch. */
  toolBatchesInvalidatedBySteering?: number | null;
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

/** ¿Registraba esta traza el ciclo de vida de los jobs en segundo plano? */
export function hasJobEvents(records: readonly TraceRecord[]): boolean {
  return records.some((r) => r.t === 'meta' && r.caps?.includes(TRACE_CAP_JOBS) === true);
}

/** ¿Registraba esta traza la Runtime Inbox? */
export function hasInboxEvents(records: readonly TraceRecord[]): boolean {
  return records.some((r) => r.t === 'meta' && r.caps?.includes(TRACE_CAP_INBOX) === true);
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
    // Las tools de jobs se repiten con los mismos argumentos por diseño: cada
    // `get_job_output(jobId)` devuelve lo que hay de nuevo.
    if (isJobTool(s.name)) continue;
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
  const jobs = { started: 0, completed: 0, failed: 0, cancelled: 0, notified: 0, bytes: 0 };
  // Los ids de job se reinician en cada proceso que escribe en la traza: la
  // lectura se apunta al job abierto con ese id, no al id.
  const jobRead = new Map<string, boolean>();
  let jobsRead = 0;
  const closeJob = (id: string): void => {
    if (jobRead.get(id)) jobsRead++;
    jobRead.delete(id);
  };
  let foregroundExec = 0;
  let backgroundExec = 0;
  const inbox = { received: 0, consumed: 0, user: 0, batches: 0, waitMs: 0, waited: 0 };
  // Eventos que quedan por ver de la entrega en curso, y si ya llevaba steering.
  let batchLeft = 0;
  let batchHasUser = false;
  // Lotes invalidados: uno por llamada al modelo cuyas tool calls no corrieron.
  const invalidated = new Set<string>();
  let lastModel = '';
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
      if (!s.parent) lastModel = s.id;
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
      else if (ev === 'job') {
        // Ni aviso ni error del agente: el ciclo de vida de un job va aparte.
        const id = String(s.data.jobId ?? '');
        const phase = s.data.phase;
        if (phase === 'created') {
          closeJob(id);
          jobRead.set(id, false);
        } else if (phase === 'started') jobs.started++;
        else if (phase === 'read') jobRead.set(id, true);
        else if (phase === 'notified') jobs.notified++;
        else if (phase === 'ended') {
          if (s.data.status === 'completed') jobs.completed++;
          else if (s.data.status === 'failed') jobs.failed++;
          else jobs.cancelled++;
          jobs.bytes += Number(s.data.stdoutBytes ?? 0) + Number(s.data.stderrBytes ?? 0);
          if (s.data.outputRead === true) jobRead.set(id, true);
        }
      } else if (ev === 'inbox') {
        // Ni aviso ni bloqueo: lo que llegó mientras el agente trabajaba.
        const isUser = s.data.type === 'user-message';
        if (s.data.phase === 'enqueue') {
          inbox.received++;
          if (isUser) inbox.user++;
        } else if (s.data.phase === 'consume') {
          inbox.consumed++;
          if (batchLeft === 0) {
            batchLeft = Math.max(1, Number(s.data.batch ?? 1));
            batchHasUser = false;
          }
          batchLeft--;
          if (isUser) {
            if (!batchHasUser) inbox.batches++;
            batchHasUser = true;
            inbox.waitMs += Number(s.data.waitMs ?? 0);
            inbox.waited++;
          }
        }
      } else if (ev === 'veto' && s.data.source === 'steering') {
        // El usuario escribió antes del dispatch: no es una política que
        // bloquee, es el lote que vuelve al modelo. Se cuenta por lote.
        invalidated.add(`${s.turn}:${lastModel}`);
      } else if (ev === 'veto') vetoes++;
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
    if (s.name === 'exec') {
      const input = s.data.input as { background?: unknown } | undefined;
      if (input?.background === true) backgroundExec++;
      else foregroundExec++;
    }
  }
  for (const id of [...jobRead.keys()]) closeJob(id);
  const jobsTracked = hasJobEvents(records);
  const inboxTracked = hasInboxEvents(records);

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
    foregroundExecCalls: foregroundExec,
    backgroundExecCalls: backgroundExec,
    jobsStarted: jobsTracked ? jobs.started : null,
    jobsCompleted: jobsTracked ? jobs.completed : null,
    jobsFailed: jobsTracked ? jobs.failed : null,
    jobsCancelled: jobsTracked ? jobs.cancelled : null,
    jobsOutputRead: jobsTracked ? jobsRead : null,
    jobNotifications: jobsTracked ? jobs.notified : null,
    jobOutputBytes: jobsTracked ? jobs.bytes : null,
    runtimeUpdatesReceived: inboxTracked ? inbox.received : null,
    runtimeUpdatesConsumed: inboxTracked ? inbox.consumed : null,
    userSteeringMessages: inboxTracked ? inbox.user : null,
    steeringBatches: inboxTracked ? inbox.batches : null,
    steeringLatencyMs:
      inboxTracked && inbox.waited > 0 ? Math.round(inbox.waitMs / inbox.waited) : null,
    toolBatchesInvalidatedBySteering: inboxTracked ? invalidated.size : null,
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

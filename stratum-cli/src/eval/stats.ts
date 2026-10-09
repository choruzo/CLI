/**
 * Estadísticas locales agregadas de las trazas que ya hay en disco (`stratum
 * stats`). Nada sale del equipo: se leen los JSONL de `trace.dir` y se suman.
 * La agregación es pura; el disco lo toca quien la llama.
 */
import {
  AUXILIARY_LLM_ORIGINS,
  LLM_CALL_ORIGINS,
  auxiliaryImpact,
  cacheBreaks,
  isPrimaryCall,
  llmBreakdown,
  prefixOf,
  sumOriginStats,
  ttftOf,
  usageOf,
  type CacheBreakCause,
  type LlmCallOrigin,
  type LlmOriginStats,
} from '../trace/model.js';
import type { TraceRecord } from '../trace/records.js';
import { blockedToolSteps, buildTraceModel, computeMetrics, turnOutcomes } from './metrics.js';

export interface TraceInput {
  sessionId: string;
  updatedAt: number;
  records: readonly TraceRecord[];
}

export interface ToolStats {
  name: string;
  calls: number;
  /** Fallos de la tool; los bloqueos del runtime van aparte en `blocked`. */
  errors: number;
  blocked: number;
  /** Duración media de las llamadas cerradas, en ms. */
  meanMs: number | null;
}

/** Caché de prompt de un conjunto de llamadas. Solo cuentan las que la reportaron. */
export interface CacheStats {
  reportedCalls: number;
  promptTokens: number;
  cachedReadTokens: number;
  /** null si ninguna llamada reportó escrituras. */
  cacheWriteTokens: number | null;
  uncachedPromptTokens: number;
  hitRate: number | null;
  coldCalls: number;
  warmCalls: number;
  ttftColdMs: number | null;
  ttftWarmMs: number | null;
}

export interface ModelStats {
  model: string;
  /** Provider con el que se llamó; ausente en trazas que no lo registraban. */
  provider?: string;
  calls: number;
  errors: number;
  tokens: number | null;
  /** Tokens de salida por segundo de generación; null si el backend no da `usage`. */
  tokensPerSecond: number | null;
  /** TTFT medio de sus llamadas. */
  ttftMs: number | null;
  /** null si ninguna de sus llamadas reportó caché. */
  cache: CacheStats | null;
}

class CacheAcc {
  reportedCalls = 0;
  prompt = 0;
  read = 0;
  write = 0;
  writeSeen = false;
  cold = 0;
  warm = 0;
  ttftCold = 0;
  ttftColdN = 0;
  ttftWarm = 0;
  ttftWarmN = 0;

  add(u: ReturnType<typeof usageOf>, ttft: number | null): void {
    if (u?.cachedReadTokens === undefined || u.promptTokens === undefined) return;
    this.reportedCalls++;
    this.prompt += u.promptTokens;
    this.read += Math.min(u.cachedReadTokens, u.promptTokens);
    if (u.cacheWriteTokens !== undefined) {
      this.writeSeen = true;
      this.write += u.cacheWriteTokens;
    }
    const warm = u.cachedReadTokens > 0;
    if (warm) this.warm++;
    else this.cold++;
    if (ttft === null) return;
    if (warm) {
      this.ttftWarm += ttft;
      this.ttftWarmN++;
    } else {
      this.ttftCold += ttft;
      this.ttftColdN++;
    }
  }

  stats(): CacheStats | null {
    if (this.reportedCalls === 0) return null;
    return {
      reportedCalls: this.reportedCalls,
      promptTokens: this.prompt,
      cachedReadTokens: this.read,
      cacheWriteTokens: this.writeSeen ? this.write : null,
      uncachedPromptTokens: this.prompt - this.read,
      hitRate: ratio(this.read, this.prompt),
      coldCalls: this.cold,
      warmCalls: this.warm,
      ttftColdMs: ratio(this.ttftCold, this.ttftColdN),
      ttftWarmMs: ratio(this.ttftWarm, this.ttftWarmN),
    };
  }
}

export interface AggregateStats {
  sessions: number;
  /** Sesiones cuya traza ya registraba confirmaciones, vetos y reintentos. */
  runtimeSessions: number;
  from: number | null;
  to: number | null;
  turns: number;
  /** Turnos cerrados que acabaron con `stop` / turnos cerrados. */
  turnCompletionRate: number | null;
  stopReasons: Record<string, number>;
  durationMs: number;
  llmCalls: number;
  llmErrors: number;
  tokens: number | null;
  toolCalls: number;
  toolErrors: number;
  toolErrorRate: number | null;
  /** Sobre `runtimeSessions`; null si no hay ninguna. */
  policyBlocks: number | null;
  policyViolationRate: number | null;
  confirmations: { asked: number; approved: number; denied: number; blocked: number } | null;
  retries: number | null;
  providerFallbacks: number;
  repeatedCalls: number;
  subagents: number;
  subagentFailures: number;
  fatalErrors: number;
  compressions: number;
  /** Turnos con algún fallo por el camino, y cuántos acabaron bien. */
  recovery: { turnsWithErrors: number; recovered: number; rate: number | null };
  perTurn: { tokens: number | null; durationMs: number | null; toolCalls: number | null };
  tools: ToolStats[];
  models: ModelStats[];
  /** Caché de prompt de todas las llamadas que la reportaron; null si ninguna. */
  cache: CacheStats | null;
  /** Roturas de caché por causa (`cacheBreaks`); vacío si no hubo o no hay datos. */
  cacheBreaks: Partial<Record<CacheBreakCause, number>>;
  /** Fracción del prompt que repite el de la llamada anterior; null sin trazas que lo midan. */
  prefixStability: number | null;
  /**
   * Llamadas al LLM por origen. `llmCalls`, `tokens`, `models` y `cache` son
   * solo del loop (agente + subagentes); las auxiliares están aquí.
   */
  llm: {
    /** Sesiones cuya traza ya registraba las llamadas auxiliares. */
    auxiliarySessions: number;
    /** Todas las llamadas: loop + auxiliares. */
    calls: number;
    byOrigin: Record<LlmCallOrigin, LlmOriginStats>;
    auxiliary: LlmOriginStats;
    /**
     * Coincidencia en el tiempo del loop con las auxiliares (relojes del
     * cliente, sobre `auxiliarySessions`): no es tiempo de cola del servidor.
     */
    overlappedCalls: number;
    overlappingAuxiliaryMs: number;
    precedingAuxiliaryMs: number;
    ttftOverlappedMs: number | null;
    ttftClearMs: number | null;
  };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function aggregateStats(traces: readonly TraceInput[]): AggregateStats {
  const stopReasons: Record<string, number> = {};
  const tools = new Map<
    string,
    { calls: number; errors: number; blocked: number; ms: number; closed: number }
  >();
  const models = new Map<
    string,
    {
      calls: number;
      errors: number;
      tokens: number;
      usage: boolean;
      genMs: number;
      genTokens: number;
      model: string;
      provider?: string;
      ttft: number;
      ttftN: number;
      cache: CacheAcc;
    }
  >();
  const cache = new CacheAcc();
  const breaks: Partial<Record<CacheBreakCause, number>> = {};
  const prefix = { chars: 0, shared: 0 };
  const conf = { asked: 0, approved: 0, denied: 0, blocked: 0 };
  const origins: Array<Record<LlmCallOrigin, LlmOriginStats>> = [];
  const impact = {
    sessions: 0,
    overlappedCalls: 0,
    overlapping: 0,
    preceding: 0,
    ttftHit: 0,
    ttftHitN: 0,
    ttftClear: 0,
    ttftClearN: 0,
  };
  const total = {
    turns: 0,
    closedTurns: 0,
    durationMs: 0,
    llmCalls: 0,
    llmErrors: 0,
    tokens: 0,
    tokenSessions: 0,
    toolCalls: 0,
    toolErrors: 0,
    runtimeSessions: 0,
    runtimeToolCalls: 0,
    policyBlocks: 0,
    retries: 0,
    providerFallbacks: 0,
    repeatedCalls: 0,
    subagents: 0,
    subagentFailures: 0,
    fatalErrors: 0,
    compressions: 0,
    turnsWithErrors: 0,
    recovered: 0,
  };

  for (const trace of traces) {
    const m = computeMetrics(trace.records, trace.updatedAt);
    total.turns += m.turns;
    total.durationMs += m.durationMs;
    total.llmCalls += m.llmCalls;
    total.llmErrors += m.llmErrors;
    total.toolCalls += m.toolCalls;
    total.toolErrors += m.toolErrors;
    total.providerFallbacks += m.providerFallbacks;
    total.repeatedCalls += m.repeatedCalls;
    total.subagents += m.subagents;
    total.subagentFailures += m.subagentFailures;
    total.fatalErrors += m.fatalErrors;
    total.compressions += m.compressions;
    if (m.tokens !== null) {
      total.tokens += m.tokens;
      total.tokenSessions++;
    }
    if (m.policyBlocks !== null && m.confirmations && m.retries !== null) {
      total.runtimeSessions++;
      total.runtimeToolCalls += m.toolCalls;
      total.policyBlocks += m.policyBlocks;
      total.retries += m.retries;
      conf.asked += m.confirmations.asked;
      conf.approved += m.confirmations.approved;
      conf.denied += m.confirmations.denied;
      conf.blocked += m.confirmations.blocked;
    }

    for (const t of turnOutcomes(trace.records)) {
      if (t.stop === null) continue;
      total.closedTurns++;
      stopReasons[t.stop] = (stopReasons[t.stop] ?? 0) + 1;
      if (t.errors > 0) {
        total.turnsWithErrors++;
        if (t.stop === 'stop') total.recovered++;
      }
    }

    const model = buildTraceModel(trace.records);
    const blocked = blockedToolSteps(model);
    for (const b of cacheBreaks(model)) breaks[b.cause] = (breaks[b.cause] ?? 0) + 1;
    const llm = llmBreakdown(model, trace.updatedAt);
    origins.push(llm.byOrigin);
    if (llm.auxiliaryTracked) {
      const i = auxiliaryImpact(model, trace.updatedAt);
      impact.sessions++;
      impact.overlappedCalls += i.overlappedCalls;
      impact.overlapping += i.overlappingAuxiliaryMs;
      impact.preceding += i.precedingAuxiliaryMs;
      impact.ttftHit += (i.ttftOverlappedMs ?? 0) * i.ttftOverlappedCalls;
      impact.ttftHitN += i.ttftOverlappedCalls;
      impact.ttftClear += (i.ttftClearMs ?? 0) * i.ttftClearCalls;
      impact.ttftClearN += i.ttftClearCalls;
    }
    for (const s of model.steps) {
      if (s.kind === 'tool') {
        let t = tools.get(s.name);
        if (!t) tools.set(s.name, (t = { calls: 0, errors: 0, blocked: 0, ms: 0, closed: 0 }));
        t.calls++;
        if (blocked.has(s.id)) t.blocked++;
        else if (s.status === 'error') t.errors++;
        if (s.end !== null) {
          t.ms += s.end - s.start;
          t.closed++;
        }
      } else if (isPrimaryCall(s)) {
        // El mismo modelo servido por dos providers son dos cachés distintas.
        const provider = typeof s.data.provider === 'string' ? s.data.provider : undefined;
        const key = `${provider ?? ''}\u0000${s.name}`;
        let mo = models.get(key);
        if (!mo) {
          mo = {
            calls: 0,
            errors: 0,
            tokens: 0,
            usage: false,
            genMs: 0,
            genTokens: 0,
            model: s.name,
            ...(provider ? { provider } : {}),
            ttft: 0,
            ttftN: 0,
            cache: new CacheAcc(),
          };
          models.set(key, mo);
        }
        mo.calls++;
        if (s.status === 'error') mo.errors++;
        const ttft = ttftOf(s);
        if (ttft !== null) {
          mo.ttft += ttft;
          mo.ttftN++;
        }
        const p = prefixOf(s);
        if (p?.sharedChars !== undefined) {
          prefix.chars += p.chars;
          prefix.shared += Math.min(p.sharedChars, p.chars);
        }
        const u = usageOf(s);
        if (!u) continue;
        cache.add(u, ttft);
        mo.cache.add(u, ttft);
        mo.usage = true;
        mo.tokens += u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
        if (u.completionTokens && s.end !== null) {
          const ms = s.end - (s.firstToken ?? s.start);
          if (ms > 0) {
            mo.genMs += ms;
            mo.genTokens += u.completionTokens;
          }
        }
      }
    }
  }

  const times = traces.map((t) => t.updatedAt);
  const runtime = total.runtimeSessions > 0;
  const byOrigin = {} as Record<LlmCallOrigin, LlmOriginStats>;
  for (const o of LLM_CALL_ORIGINS) byOrigin[o] = sumOriginStats(origins.map((by) => by[o]));
  return {
    sessions: traces.length,
    runtimeSessions: total.runtimeSessions,
    from: times.length > 0 ? Math.min(...times) : null,
    to: times.length > 0 ? Math.max(...times) : null,
    turns: total.turns,
    turnCompletionRate: ratio(stopReasons.stop ?? 0, total.closedTurns),
    stopReasons,
    durationMs: total.durationMs,
    llmCalls: total.llmCalls,
    llmErrors: total.llmErrors,
    tokens: total.tokenSessions > 0 ? total.tokens : null,
    toolCalls: total.toolCalls,
    toolErrors: total.toolErrors,
    toolErrorRate: ratio(total.toolErrors, total.toolCalls),
    policyBlocks: runtime ? total.policyBlocks : null,
    policyViolationRate: runtime ? ratio(total.policyBlocks, total.runtimeToolCalls) : null,
    confirmations: runtime ? conf : null,
    retries: runtime ? total.retries : null,
    providerFallbacks: total.providerFallbacks,
    repeatedCalls: total.repeatedCalls,
    subagents: total.subagents,
    subagentFailures: total.subagentFailures,
    fatalErrors: total.fatalErrors,
    compressions: total.compressions,
    recovery: {
      turnsWithErrors: total.turnsWithErrors,
      recovered: total.recovered,
      rate: ratio(total.recovered, total.turnsWithErrors),
    },
    perTurn: {
      tokens: total.tokenSessions > 0 ? ratio(total.tokens, total.turns) : null,
      durationMs: ratio(total.durationMs, total.turns),
      toolCalls: ratio(total.toolCalls, total.turns),
    },
    tools: [...tools.entries()]
      .map(([name, t]) => ({
        name,
        calls: t.calls,
        errors: t.errors,
        blocked: t.blocked,
        meanMs: ratio(t.ms, t.closed),
      }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    models: [...models.values()]
      .map((m) => ({
        model: m.model,
        ...(m.provider ? { provider: m.provider } : {}),
        calls: m.calls,
        errors: m.errors,
        tokens: m.usage ? m.tokens : null,
        tokensPerSecond: m.genMs > 0 ? m.genTokens / (m.genMs / 1000) : null,
        ttftMs: ratio(m.ttft, m.ttftN),
        cache: m.cache.stats(),
      }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
    cache: cache.stats(),
    cacheBreaks: breaks,
    prefixStability: ratio(prefix.shared, prefix.chars),
    llm: {
      auxiliarySessions: impact.sessions,
      calls: LLM_CALL_ORIGINS.reduce((n, o) => n + byOrigin[o].calls, 0),
      byOrigin,
      auxiliary: sumOriginStats(AUXILIARY_LLM_ORIGINS.map((o) => byOrigin[o])),
      overlappedCalls: impact.overlappedCalls,
      overlappingAuxiliaryMs: impact.overlapping,
      precedingAuxiliaryMs: impact.preceding,
      ttftOverlappedMs: ratio(impact.ttftHit, impact.ttftHitN),
      ttftClearMs: ratio(impact.ttftClear, impact.ttftClearN),
    },
  };
}

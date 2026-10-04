/**
 * Estadísticas locales agregadas de las trazas que ya hay en disco (`stratum
 * stats`). Nada sale del equipo: se leen los JSONL de `trace.dir` y se suman.
 * La agregación es pura; el disco lo toca quien la llama.
 */
import { usageOf } from '../trace/model.js';
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

export interface ModelStats {
  model: string;
  calls: number;
  errors: number;
  tokens: number | null;
  /** Tokens de salida por segundo de generación; null si el backend no da `usage`. */
  tokensPerSecond: number | null;
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
    }
  >();
  const conf = { asked: 0, approved: 0, denied: 0, blocked: 0 };
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
      } else if (s.kind === 'model') {
        let mo = models.get(s.name);
        if (!mo) {
          mo = { calls: 0, errors: 0, tokens: 0, usage: false, genMs: 0, genTokens: 0 };
          models.set(s.name, mo);
        }
        mo.calls++;
        if (s.status === 'error') mo.errors++;
        const u = usageOf(s);
        if (!u) continue;
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
    models: [...models.entries()]
      .map(([model, m]) => ({
        model,
        calls: m.calls,
        errors: m.errors,
        tokens: m.usage ? m.tokens : null,
        tokensPerSecond: m.genMs > 0 ? m.genTokens / (m.genMs / 1000) : null,
      }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
  };
}

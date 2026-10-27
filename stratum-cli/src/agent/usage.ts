/**
 * Uso de tokens y tiempos de un turno del loop principal. Módulo **puro** —sin
 * imports de Node— a propósito: la TUI y el webview de Desktop consumen estos
 * números, y no deben arrastrar `fs`/`path` solo para pintar una cifra.
 *
 * Regla que no se rompe («nada se estima»): un campo es `undefined` hasta que
 * alguna llamada lo reporte. «0 tokens» y «no lo sé» son respuestas distintas;
 * sumar `undefined + n` da `n`, y ningún hueco se rellena con 0.
 *
 * Solo cuenta el loop **principal**: los subagentes y las llamadas auxiliares
 * (`tracedCompletion`) tienen su propio consumo y no entran aquí.
 */

import type { TokenUsage } from '../providers/cache.js';
import type { TokenStatus } from './events.js';

/**
 * Desglose del uso (tokens, caché, tiempos, coste) de un turno del loop
 * **principal**. Acumulador de `ReactLoop.turnUsage` y de la sesión
 * (`StratumAgent.getSessionUsage()`).
 *
 * Qué **no** entra aquí:
 *  - los **subagentes** (`delegate_task` / `--delegate`): su consumo lo mide el
 *    loop del hijo y no se suma;
 *  - las **llamadas auxiliares** (compresor de contexto, extracción de memoria).
 *
 * Por eso este desglose no coincide con `getTokenUsage()` (contabilidad total,
 * que sí incluye lo que aportan los hijos) y no sirve para facturar el proceso
 * entero.
 */
export interface TurnUsage {
  /** Requests al LLM del loop principal en el turno. */
  llmCalls: number;
  /** Cuántas de esas requests trajeron `usage`. */
  reportedCalls: number;
  /** Suma de los reportados; `undefined` si ninguno lo trajo. */
  promptTokens?: number;
  completionTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  /** `completion_tokens_details.reasoning_tokens`, si el backend lo da. */
  reasoningTokens?: number;
  /** `cachedReadTokens / promptTokens` sobre los totales, solo si ambos están definidos. */
  cacheHitRate?: number;
  /** Tiempo de pared dentro de requests al LLM. */
  llmMs: number;
  /** Tiempo de pared ejecutando tools (fase de despacho). */
  toolMs: number;
  /** TTFT de la primera request del turno. */
  firstTokenMs?: number;
  /** Suma de (fin − primer chunk) de cada request. */
  generationMs?: number;
  /** `completionTokens / (generationMs / 1000)`, solo con ambos > 0. */
  outputTokensPerSec?: number;
  /** Coste en USD del turno; ver `providers/pricing.ts`. `undefined` sin precio o sin tokens. */
  costUsd?: number;
  /**
   * Hay consumo que este desglose **no** incluye: un turno delegado, una
   * request que no cerró normalmente, o un tramo sin precio. Con `incomplete`
   * el coste nunca se publica como total (`costUsd` queda indefinido): léelo
   * como «al menos esto», no como la cifra completa.
   */
  incomplete?: true;
}

/**
 * Contadores de uso de una sesión que sobreviven a reanudarla: se guardan con
 * ella (`SessionContext.usage` + `toolCallCount`) y viajan en un traspaso (M10).
 * Los tokens, solo si el backend los reportó: nunca se estiman.
 */
export interface SessionUsageSnapshot {
  toolCalls: number;
  /** Contabilidad total (`getTokenUsage`); `null` si no hay dato reportado. */
  tokens: number | null;
  tokenStatus: TokenStatus;
  /**
   * Desglose del loop principal (`getSessionUsage`). Opcional: un traspaso y
   * las sesiones guardadas antes de UX-3 no lo llevan, y entonces empieza a cero.
   */
  session?: TurnUsage & { turns: number };
}

/** Lo que aporta una sola request al acumulador. */
export interface CallUsage {
  /** `usage` normalizado del chunk final de la request. */
  usage?: TokenUsage & { reasoningTokens?: number };
  /** Tiempo de pared de la request completa. */
  durationMs: number;
  /** Milisegundos hasta el primer chunk (TTFT), si llegó alguno. */
  firstChunkMs?: number;
}

/** Acumulador a cero. Tokens sin definir: nadie ha reportado todavía. */
export function emptyTurnUsage(): TurnUsage {
  return { llmCalls: 0, reportedCalls: 0, llmMs: 0, toolMs: 0 };
}

/** Suma que respeta «sin dato»: solo un sumando definido produce resultado. */
function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Recalcula los derivados (`cacheHitRate`, `outputTokensPerSec`) desde los totales. */
function derive(u: TurnUsage): TurnUsage {
  const { cacheHitRate: _hit, outputTokensPerSec: _speed, costUsd: _cost, ...rest } = u;
  const out: TurnUsage = rest;
  if (
    out.cachedReadTokens !== undefined &&
    out.promptTokens !== undefined &&
    out.promptTokens > 0
  ) {
    out.cacheHitRate = Math.min(out.cachedReadTokens, out.promptTokens) / out.promptTokens;
  }
  if (
    out.completionTokens !== undefined &&
    out.generationMs !== undefined &&
    out.generationMs > 0
  ) {
    out.outputTokensPerSec = out.completionTokens / (out.generationMs / 1000);
  }
  // Un desglose incompleto no publica coste: un importe parcial presentado como
  // total es peor que no dar cifra.
  if (!out.incomplete && u.costUsd !== undefined) out.costUsd = u.costUsd;
  return out;
}

/**
 * Incorpora una request al acumulador del turno. Pura: devuelve un objeto nuevo
 * y no toca `acc`.
 */
export function addCallUsage(acc: TurnUsage, call: CallUsage): TurnUsage {
  const usage = call.usage;
  const durationMs = Number.isFinite(call.durationMs) ? Math.max(0, call.durationMs) : 0;
  const generationMs =
    call.firstChunkMs === undefined
      ? undefined
      : Math.max(0, durationMs - Math.max(0, call.firstChunkMs));

  return derive({
    ...acc,
    llmCalls: acc.llmCalls + 1,
    reportedCalls: acc.reportedCalls + (usage ? 1 : 0),
    promptTokens: add(acc.promptTokens, usage?.promptTokens),
    completionTokens: add(acc.completionTokens, usage?.completionTokens),
    cachedReadTokens: add(acc.cachedReadTokens, usage?.cachedReadTokens),
    cacheWriteTokens: add(acc.cacheWriteTokens, usage?.cacheWriteTokens),
    reasoningTokens: add(acc.reasoningTokens, usage?.reasoningTokens),
    llmMs: acc.llmMs + durationMs,
    // El TTFT del turno es el de la primera request que lo reportó.
    firstTokenMs: acc.firstTokenMs ?? call.firstChunkMs,
    generationMs: add(acc.generationMs, generationMs),
  });
}

/**
 * ¿El tramo consumió tokens? Sin tokens no hay coste que echar de menos: un
 * turno que el backend no midió no invalida el importe de los demás.
 */
function billable(u: TurnUsage): boolean {
  return u.promptTokens !== undefined || u.completionTokens !== undefined;
}

/**
 * Coste de dos tramos. Solo se suma si ambos están definidos. Un tramo con
 * tokens y sin coste (provider sin `pricing`) deja el total sin definir: un
 * importe parcial presentado como total es peor que no dar cifra.
 */
function sumCost(a: TurnUsage, b: TurnUsage): number | undefined {
  if (a.costUsd !== undefined && b.costUsd !== undefined) return a.costUsd + b.costUsd;
  if (a.costUsd !== undefined) return billable(b) ? undefined : a.costUsd;
  if (b.costUsd !== undefined) return billable(a) ? undefined : b.costUsd;
  return undefined;
}

/**
 * Suma dos acumuladores (el del turno al de la sesión). Pura. `firstTokenMs`
 * se queda con el menor de los definidos: el TTFT de la sesión no se suma, pero
 * tampoco se inventa.
 */
export function sumUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  const firstTokenMs =
    a.firstTokenMs === undefined
      ? b.firstTokenMs
      : b.firstTokenMs === undefined
        ? a.firstTokenMs
        : Math.min(a.firstTokenMs, b.firstTokenMs);

  return derive({
    ...a,
    llmCalls: a.llmCalls + b.llmCalls,
    reportedCalls: a.reportedCalls + b.reportedCalls,
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    cachedReadTokens: add(a.cachedReadTokens, b.cachedReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    llmMs: a.llmMs + b.llmMs,
    toolMs: a.toolMs + b.toolMs,
    firstTokenMs,
    generationMs: add(a.generationMs, b.generationMs),
    costUsd: sumCost(a, b),
    // El «falta consumo» es pegajoso: una vez que el desglose no cuadra, no
    // vuelve a cuadrar por mucho que lleguen tramos completos.
    ...(a.incomplete || b.incomplete ? { incomplete: true as const } : {}),
  });
}

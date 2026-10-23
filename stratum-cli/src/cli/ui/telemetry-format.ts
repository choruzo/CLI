/**
 * Textos de la telemetría de la TUI (UX-3): el pie de cada turno y la lectura en
 * vivo bajo el prompt. Puro. La regla del repo manda: lo que el backend no
 * reportó no se pinta como 0 — o se omite o dice `n/d`.
 */

/** Lo que de `TurnUsage` (`agent/usage.ts`) lee la UI. */
export interface UsageView {
  llmCalls: number;
  reportedCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  cacheHitRate?: number;
  llmMs: number;
  toolMs: number;
  outputTokensPerSec?: number;
  costUsd?: number;
  /** Hay consumo que este desglose no mide (subagente delegado, request cortada). */
  incomplete?: boolean;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatSeconds(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** Dólares con las cifras que importan: `$0.0042`, `$0.031`, `$1.27`. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function cachePart(u: UsageView): string | null {
  if (u.promptTokens === undefined) return null;
  return u.cacheHitRate === undefined ? 'caché n/d' : `${Math.round(u.cacheHitRate * 100)}% caché`;
}

/** Segmentos del pie de turno; `compact` se queda con lo esencial. */
export function turnUsageParts(u: UsageView, compact: boolean): string[] {
  const parts: string[] = [];
  if (u.promptTokens === undefined && u.completionTokens === undefined) {
    // Ninguna llamada trajo `usage`: se dice, no se inventa.
    parts.push(u.llmCalls > 0 ? 'tokens n/d' : '');
  } else {
    if (u.promptTokens !== undefined) parts.push(`${formatCount(u.promptTokens)} entrada`);
    const cache = cachePart(u);
    if (cache) parts.push(cache);
    if (!compact && u.completionTokens !== undefined) {
      const thinking =
        u.reasoningTokens !== undefined && u.reasoningTokens > 0
          ? ` (${formatCount(u.reasoningTokens)} razonando)`
          : '';
      parts.push(`${formatCount(u.completionTokens)} salida${thinking}`);
    }
    if (u.reportedCalls < u.llmCalls) parts.push(`${u.reportedCalls}/${u.llmCalls} con uso`);
  }
  if (!compact) {
    parts.push(`${u.llmCalls} llamada${u.llmCalls === 1 ? '' : 's'}`);
    if (u.llmMs > 0) parts.push(`LLM ${formatSeconds(u.llmMs)}`);
    if (u.toolMs > 0) parts.push(`tools ${formatSeconds(u.toolMs)}`);
  }
  if (u.costUsd !== undefined) parts.push(formatCost(u.costUsd));
  if (u.incomplete) parts.push('parcial');
  return parts.filter(Boolean);
}

/**
 * Lectura en vivo del pie del prompt. Dos pastillas, como en deepseek-harness:
 * actividad (`⊙ paso 3 · 42 tok/s`) y uso (`⛁ 12.4K · 87% caché · $0.031`).
 * Devuelve `null` en la que no tiene nada que decir.
 */
export function liveTelemetry(
  turn: UsageView | null,
  session: (UsageView & { turns: number }) | null,
): { activity: string | null; usage: string | null } {
  let activity: string | null = null;
  if (turn && turn.llmCalls > 0) {
    const speed =
      turn.outputTokensPerSec !== undefined
        ? ` · ${Math.round(turn.outputTokensPerSec)} tok/s`
        : '';
    activity = `⊙ paso ${turn.llmCalls}${speed}`;
  } else if (session && session.turns > 0) {
    activity = `⊙ ${session.turns} turno${session.turns === 1 ? '' : 's'} · ${session.llmCalls} pasos`;
  }

  let usage: string | null = null;
  const src = session && session.llmCalls > 0 ? session : null;
  if (src) {
    // Un total con una mitad sin reportar sería un número inventado a medias.
    if (src.promptTokens === undefined || src.completionTokens === undefined) {
      usage = '⛁ n/d';
    } else {
      const total = src.promptTokens + src.completionTokens;
      const parts = [`⛁ ${formatCount(total)}`];
      const cache = cachePart(src);
      if (cache) parts.push(cache);
      if (src.costUsd !== undefined) parts.push(formatCost(src.costUsd));
      if (src.incomplete) parts.push('parcial');
      usage = parts.join(' · ');
    }
  }
  return { activity, usage };
}

/**
 * Pistas de cada modelo en el selector de `/model`: lo que el backend declara
 * en `/models` (ventana de contexto, si razona) y cuál es el actual. Lo que no
 * declara no se pinta: nada se deduce del nombre del modelo. Puro.
 */
import type { ModelInfo } from '../../providers/utils.js';

/** `128K`, `32.8K`, `1M`. */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${parseFloat((tokens / 1_000_000).toFixed(1))}M`;
  }
  const k = tokens / 1000;
  return `${Number.isInteger(k) || k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
}

export function modelHint(info: ModelInfo | undefined, isCurrent: boolean): string | undefined {
  const parts: string[] = [];
  if (isCurrent) parts.push('actual');
  if (info?.contextWindow) parts.push(`${formatWindow(info.contextWindow)} ctx`);
  if (info?.reasoning === true) parts.push('razona');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

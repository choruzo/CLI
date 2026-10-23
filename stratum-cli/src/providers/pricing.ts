/**
 * Precio del backend y coste en dólares (UX-3). Módulo **puro** —sin imports de
 * Node— como `cache.ts`: lo consumen la TUI y el webview de Desktop.
 *
 * Reglas que no se rompen:
 *  - **nada se estima**: sin `pricing` configurado, o sin el dato de tokens, el
 *    coste es `undefined`. No hay tarifa por defecto ni importe «aproximado»;
 *  - un tramo con tokens y **sin** precio deja el total sin definir: presentar
 *    un importe parcial como si fuera el total es peor que no dar cifra.
 */

/** Precio declarado del backend, en USD por **millón** de tokens. */
export interface Pricing {
  /** Entrada no cacheada. */
  input: number;
  /** Salida. */
  output: number;
  /** Entrada servida de la caché de prefijo; sin declarar, se cobra a `input`. */
  cachedInput?: number;
  /** Entrada escrita en caché; sin declarar, se cobra a `input`. */
  cacheWrite?: number;
}

/** Lo mínimo que necesita el cálculo: cualquier `TokenUsage`/`TurnUsage` encaja. */
export interface CostUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
}

/** El backend no reportó tokens facturables: no hay coste que sumar ni que echar de menos. */
export function hasBillableTokens(usage: CostUsage | null | undefined): boolean {
  return usage?.promptTokens !== undefined || usage?.completionTokens !== undefined;
}

const TOKENS_PER_UNIT = 1_000_000;

/**
 * Coste en USD de un consumo. `undefined` sin precio o sin los dos totales que
 * hacen falta (`promptTokens` y `completionTokens`): con uno solo no se puede
 * cerrar la cuenta sin inventar el otro.
 *
 * `promptTokens` es la entrada **total**, con lo servido de caché dentro: lo
 * cacheado se cobra a su tarifa y el resto a `input`. Un `cachedReadTokens` sin
 * definir no es «cero caché»: es no saberlo, así que se cobra todo el prompt a
 * la tarifa base (que es lo que se paga igualmente).
 */
export function computeCostUsd(
  usage: CostUsage | null | undefined,
  pricing?: Pricing | null,
): number | undefined {
  if (!pricing || !usage) return undefined;
  const prompt = usage.promptTokens;
  const completion = usage.completionTokens;
  if (prompt === undefined || completion === undefined) return undefined;

  const cached = Math.min(usage.cachedReadTokens ?? 0, prompt);
  const written = Math.min(usage.cacheWriteTokens ?? 0, prompt - cached);
  const uncached = Math.max(0, prompt - cached - written);

  const total =
    uncached * pricing.input +
    cached * (pricing.cachedInput ?? pricing.input) +
    written * (pricing.cacheWrite ?? pricing.input) +
    completion * pricing.output;

  return total / TOKENS_PER_UNIT;
}

/**
 * Coste acumulado de un turno. Guarda por separado si algún tramo quedó sin
 * precio: una vez que falta un importe, el total ya no es el total y no vuelve
 * a serlo aunque lleguen requests con precio después.
 */
export interface CostTotal {
  costUsd?: number;
  /** Alguna request con tokens no tenía precio: el total no está completo. */
  incomplete: boolean;
}

export function emptyCostTotal(): CostTotal {
  return { incomplete: false };
}

/**
 * Suma el coste de una request al total del turno. Pura.
 *
 * - request sin tokens facturables (el backend no reportó nada) → no cambia nada;
 * - request con tokens y sin coste (sin precio configurado) → `incomplete`;
 * - request con coste → suma (también si es 0: un backend gratis es gratis).
 */
export function addCostTotal(
  total: CostTotal,
  callCostUsd: number | undefined,
  billable: boolean,
): CostTotal {
  if (!billable) return total;
  if (callCostUsd === undefined) return { ...total, incomplete: true };
  if (total.incomplete) return total;
  return { ...total, costUsd: (total.costUsd ?? 0) + callCostUsd };
}

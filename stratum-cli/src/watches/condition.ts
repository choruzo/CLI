/**
 * M22 — la condición de un vigilante (PRD de Dot §23.11, M22 parte 1). Cerrada,
 * sin expresiones libres: el estado es (o no es) uno de varios valores, el valor
 * pasa por encima o por debajo de un umbral, o el estado cambia. Todas admiten
 * «durante al menos N minutos». Sin I/O.
 */
import { z } from 'zod';
import { WATCH_LIMITS } from '../protocol/index.js';
import { CHECK_STATE_MAX, type CheckResult } from '../connectors/checks.js';

const forMinutes = z.number().int().min(0).max(WATCH_LIMITS.maxForMinutes).optional();
const stateValue = z.string().trim().min(1).max(CHECK_STATE_MAX);
const stateValues = z.array(stateValue).min(1).max(WATCH_LIMITS.stateValues);
const threshold = z.number().finite();

export const WatchConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state-is'), values: stateValues, forMinutes }).strict(),
  z.object({ kind: z.literal('state-is-not'), values: stateValues, forMinutes }).strict(),
  z.object({ kind: z.literal('above'), threshold, forMinutes }).strict(),
  z.object({ kind: z.literal('below'), threshold, forMinutes }).strict(),
  z.object({ kind: z.literal('changes'), forMinutes }).strict(),
]);

export type WatchCondition = z.infer<typeof WatchConditionSchema>;

/**
 * ¿Se cumple con este resultado? `null` = no se puede saber (un umbral sin
 * `valor` numérico): no cuenta ni como verdadera ni como falsa. `changes` no se
 * evalúa aquí: depende del estado anterior (`engine.ts`).
 */
export function conditionHolds(
  condition: Exclude<WatchCondition, { kind: 'changes' }>,
  result: CheckResult,
): boolean | null {
  switch (condition.kind) {
    case 'state-is':
      return condition.values.includes(result.estado);
    case 'state-is-not':
      return !condition.values.includes(result.estado);
    case 'above':
      return result.valor === null ? null : result.valor > condition.threshold;
    case 'below':
      return result.valor === null ? null : result.valor < condition.threshold;
  }
}

function list(values: string[]): string {
  const quoted = values.map((v) => `«${v}»`);
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(', ')} o ${quoted.at(-1)}`;
}

/** La condición en una frase para un aviso («el estado es «off» durante al menos 5 min»). */
export function describeCondition(condition: WatchCondition): string {
  let text: string;
  switch (condition.kind) {
    case 'state-is':
      text = `el estado es ${list(condition.values)}`;
      break;
    case 'state-is-not':
      text = `el estado no es ${list(condition.values)}`;
      break;
    case 'above':
      text = `el valor pasa de ${condition.threshold}`;
      break;
    case 'below':
      text = `el valor baja de ${condition.threshold}`;
      break;
    case 'changes':
      text = 'el estado cambia';
      break;
  }
  const n = condition.forMinutes ?? 0;
  return n > 0 ? `${text} durante al menos ${n} min` : text;
}

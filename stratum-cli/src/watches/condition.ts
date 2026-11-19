/**
 * M22 — la condición de un vigilante (PRD de Dot §23.11, M22 parte 1). Cerrada,
 * sin expresiones libres: el estado es (o no es) uno de varios valores, el valor
 * pasa por encima o por debajo de un umbral, o el estado cambia. Todas admiten
 * «durante al menos N minutos». Sin I/O.
 */
import type { ProtocolWatchCondition } from '../protocol/index.js';
import { watchConditionSchema } from '../protocol/schemas.js';
import type { CheckResult } from '../connectors/checks.js';

/** La del protocolo (`watchConditionSchema`): una sola definición. */
export const WatchConditionSchema = watchConditionSchema;

export type WatchCondition = ProtocolWatchCondition;

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

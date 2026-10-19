/**
 * De lo que llega del lado nativo (JSON sin tipar) a una foto de sesión.
 *
 * Dos pasos, y ninguno es un reductor propio:
 *
 *  1. **validar** con los schemas del contrato (`protocol/schemas.ts`): lo que
 *     pasa de aquí solo tiene los campos del contrato;
 *  2. **reducir** con `applySessionEvent`, el reductor del contrato.
 *
 * Lo que Dot añade es qué hacer cuando algo no encaja: pedir otra foto. Nunca
 * se «arregla» el estado a mano.
 */
import {
  classifyEvent,
  parseSessionSnapshot,
} from '../../../stratum-cli/src/protocol/schemas';
import {
  followSession,
  type ClassifiedEvent,
  type FollowResult,
  type ProtocolSessionSnapshot,
} from './index';

/** Una foto validada, o `null` si no cumple el contrato. */
export function parseSnapshot(raw: unknown): ProtocolSessionSnapshot | null {
  return parseSessionSnapshot(raw);
}

/** Clasificación de un evento sin tipar (la del contrato, `classifyEvent`). */
export type ParsedEvent = ClassifiedEvent;

export function parseEvent(raw: unknown): ParsedEvent {
  return classifyEvent(raw);
}

export type ApplyResult = FollowResult;

/**
 * Aplica un lote, en orden, a una foto. La de entrada no se toca. Es
 * `followSession` del contrato (M12: la misma que usa Stratum Desktop).
 */
export function applyEvents(snapshot: ProtocolSessionSnapshot, raws: unknown[]): ApplyResult {
  return followSession(snapshot, raws.map(classifyEvent));
}

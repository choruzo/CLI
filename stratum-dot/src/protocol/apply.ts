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
import { eventSchema, sessionSnapshotSchema } from '../../../stratum-cli/src/protocol/schemas';
import {
  EVENT_CLASS,
  applySessionEvent,
  isStateEvent,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
} from './index';

/** Una foto validada, o `null` si no cumple el contrato. */
export function parseSnapshot(raw: unknown): ProtocolSessionSnapshot | null {
  const parsed = sessionSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type ParsedEvent =
  | { kind: 'event'; event: ProtocolEvent }
  /**
   * Un evento de estado de un tipo que este Dot no conoce (un daemon más nuevo:
   * dentro de la v1 se pueden añadir eventos). No se aplica, pero cuenta en la
   * secuencia: ignorarlo sin más dejaría la sesión atascada en un hueco falso.
   */
  | { kind: 'unknown-state'; sessionId: string; seq: number; at: number }
  /** Un fragmento volátil desconocido: se puede perder sin más. */
  | { kind: 'skip' }
  | { kind: 'invalid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEvent(raw: unknown): ParsedEvent {
  const parsed = eventSchema.safeParse(raw);
  if (parsed.success) return { kind: 'event', event: parsed.data };
  if (!isRecord(raw) || typeof raw.type !== 'string') return { kind: 'invalid' };
  if (Object.prototype.hasOwnProperty.call(EVENT_CLASS, raw.type)) return { kind: 'invalid' };
  const { seq, at, sessionId } = raw;
  if (typeof sessionId !== 'string') return { kind: 'invalid' };
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1 && !('after' in raw)) {
    return { kind: 'unknown-state', sessionId, seq, at: typeof at === 'number' ? at : 0 };
  }
  return 'after' in raw ? { kind: 'skip' } : { kind: 'invalid' };
}

export interface ApplyResult {
  snapshot: ProtocolSessionSnapshot;
  /** Los eventos de estado que se aplicaron, en orden (para el registro de actividad). */
  applied: ProtocolEvent[];
  /**
   * No se pudo seguir la secuencia (un evento que no valida, o uno que no es el
   * siguiente): hay que pedir una foto nueva. Lo aplicado hasta ahí vale.
   */
  needsResync: boolean;
}

/** Aplica un lote, en orden, a una foto. La de entrada no se toca. */
export function applyEvents(snapshot: ProtocolSessionSnapshot, raws: unknown[]): ApplyResult {
  let current = snapshot;
  const applied: ProtocolEvent[] = [];
  for (const raw of raws) {
    const parsed = parseEvent(raw);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'invalid') return { snapshot: current, applied, needsResync: true };

    if (parsed.kind === 'unknown-state') {
      if (parsed.sessionId !== current.session.id || parsed.seq <= current.seq) continue;
      if (parsed.seq !== current.seq + 1) return { snapshot: current, applied, needsResync: true };
      current = {
        ...current,
        seq: parsed.seq,
        session: { ...current.session, seq: parsed.seq, updatedAt: parsed.at || current.session.updatedAt },
      };
      continue;
    }

    const { event } = parsed;
    if (event.sessionId !== current.session.id) continue;
    if (!isStateEvent(event)) {
      // Volátil: si no encaja con la foto, el reductor lo deja pasar. Se pierde sin más.
      current = applySessionEvent(current, event);
      continue;
    }
    if (event.seq <= current.seq) continue;
    const next = applySessionEvent(current, event);
    // El reductor no aplica un evento que no sigue a la foto.
    if (next.seq !== event.seq) return { snapshot: current, applied, needsResync: true };
    current = next;
    applied.push(event);
  }
  return { snapshot: current, applied, needsResync: false };
}

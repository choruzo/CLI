/**
 * Seguir una sesión desde un cliente (M12): de una foto y un lote de eventos ya
 * clasificados, a la foto siguiente. Lo usan Stratum Dot y Stratum Desktop, que
 * son clientes hermanos: una implementación, no una por aplicación.
 *
 * **Puro** y sin validar: quien recibe JSON sin tipar lo clasifica antes con
 * `classifyEvent` (`protocol/schemas.ts`, que es donde vive Zod). Aquí no hay
 * un reductor propio: se reduce con `applySessionEvent`, el del contrato. Lo
 * único que se añade es qué hacer cuando algo no encaja: pedir otra foto.
 * Nunca se «arregla» el estado a mano.
 */
import { isStateEvent, type ProtocolEvent, type ProtocolSessionSnapshot } from './events.js';
import { applySessionEvent } from './reduce.js';

export type ClassifiedEvent =
  | { kind: 'event'; event: ProtocolEvent }
  /**
   * Un evento de estado de un tipo que este cliente no conoce (un daemon más
   * nuevo: dentro de la v1 se pueden añadir eventos). No se aplica, pero
   * cuenta en la secuencia: ignorarlo dejaría la sesión atascada en un hueco falso.
   */
  | { kind: 'unknown-state'; sessionId: string; seq: number; at: number }
  /** Un fragmento volátil desconocido: se puede perder sin más. */
  | { kind: 'skip' }
  | { kind: 'invalid' };

export interface FollowResult {
  snapshot: ProtocolSessionSnapshot;
  /** Los eventos de estado que se aplicaron, en orden. */
  applied: ProtocolEvent[];
  /**
   * No se pudo seguir la secuencia (un evento que no valida, o uno que no es
   * el siguiente): hay que pedir una foto nueva. Lo aplicado hasta ahí vale.
   */
  needsResync: boolean;
}

/** Aplica un lote, en orden, a una foto. La de entrada no se toca. */
export function followSession(
  snapshot: ProtocolSessionSnapshot,
  events: readonly ClassifiedEvent[],
): FollowResult {
  let current = snapshot;
  const applied: ProtocolEvent[] = [];
  for (const parsed of events) {
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'invalid') return { snapshot: current, applied, needsResync: true };

    if (parsed.kind === 'unknown-state') {
      if (parsed.sessionId !== current.session.id || parsed.seq <= current.seq) continue;
      if (parsed.seq !== current.seq + 1) return { snapshot: current, applied, needsResync: true };
      current = {
        ...current,
        seq: parsed.seq,
        session: {
          ...current.session,
          seq: parsed.seq,
          updatedAt: parsed.at || current.session.updatedAt,
        },
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

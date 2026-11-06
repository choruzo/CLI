/**
 * Resolver lo que una sesión espera de una persona —aprobaciones, preguntas,
 * planes— desde Desktop. Mismas reglas que Stratum Dot (`docs/dot.md` §13–§14):
 *
 *  - Se pide al broker nativo **qué** resolver; la autoridad la pone él. Aquí
 *    no hay credenciales: del broker solo llega su estado (`approverStore`).
 *  - **Sin optimismo**: aceptar la petición no marca nada como resuelto. La
 *    solicitud deja de estar pendiente cuando la foto lo dice (su `*.resolved`).
 *  - **Sin reintentos**: una resolución es mutante. Enviada y sin respuesta, el
 *    resultado es desconocido; se dice, se pide una foto y no se reenvía.
 *  - Nunca se resuelve sola: cada llamada sale de un clic de la persona.
 *  - **Lo sensible se confirma fuera**: aprobar, «en esta sesión», enviar
 *    respuestas y aprobar un plan abren la confirmación nativa. Cancelarla no
 *    es un error: no salió nada y la tarjeta vuelve a estar como antes.
 */
import type { ApproverStatus, CommandError, NativeBridge, QuestionAnswerInput } from '../ipc/native';
import { toCommandError } from '../ipc/native';
import { describeResolutionError, type HumanInputItem } from '../view/interactions';
import { createStore } from './store';

/** Cómo va lo que se pidió para una solicitud (`sessionId:id`). */
export type Resolution =
  | { state: 'confirming' | 'sending' | 'sent'; action: string }
  | { state: 'failed'; action: string; message: string };

export interface ApprovalsState {
  status: ApproverStatus;
  resolutions: Record<string, Resolution>;
}

export const approvalsStore = createStore<ApprovalsState>({
  status: { kind: 'unavailable', reason: 'not-connected' },
  resolutions: {},
});

export const resolutionKey = (item: Pick<HumanInputItem, 'sessionId' | 'id'>): string =>
  `${item.sessionId}:${item.id}`;

function setResolution(key: string, resolution: Resolution | null): void {
  approvalsStore.set((s) => {
    const resolutions = { ...s.resolutions };
    if (resolution) resolutions[key] = resolution;
    else delete resolutions[key];
    return { ...s, resolutions };
  });
}

export const approvalsActions = {
  setStatus(status: ApproverStatus): void {
    approvalsStore.set((s) => ({ ...s, status }));
  },

  /** Lo que ya no está pendiente en ninguna foto deja de tener resolución en curso. */
  forget(keep: (key: string) => boolean): void {
    approvalsStore.set((s) => {
      const kept = Object.entries(s.resolutions).filter(([key]) => keep(key));
      return kept.length === Object.keys(s.resolutions).length ? s : { ...s, resolutions: Object.fromEntries(kept) };
    });
  },
};

export function canResolve(status: ApproverStatus): boolean {
  return status.kind === 'ready';
}

/** Errores tras los que lo que se ve puede estar desfasado: se pide una foto. */
function needsPhoto(error: CommandError): boolean {
  return (
    error.kind === 'unknown' ||
    error.code === 'ALREADY_RESOLVED' ||
    error.code === 'NOT_FOUND' ||
    (error.kind === 'not-confirmed' && error.reason === 'resolved-elsewhere')
  );
}

/** Una vez. `true` si el daemon la aceptó. `confirm`: pasa por la confirmación nativa. */
async function send(
  native: NativeBridge,
  item: HumanInputItem,
  action: string,
  call: () => Promise<void>,
  confirm: boolean,
): Promise<boolean> {
  const key = resolutionKey(item);
  const current = approvalsStore.get().resolutions[key];
  // Un clic más mientras la anterior sigue en vuelo no pide nada.
  if (current && current.state !== 'failed') return false;
  setResolution(key, { state: confirm ? 'confirming' : 'sending', action });
  try {
    await call();
    setResolution(key, { state: 'sent', action });
    return true;
  } catch (err) {
    const error = toCommandError(err);
    // La persona dijo que no en la ventana: no hay nada que contar.
    if (error.kind === 'not-confirmed' && error.reason === 'cancelled') {
      setResolution(key, null);
      return false;
    }
    setResolution(key, { state: 'failed', action, message: describeResolutionError(error, item) });
    if (needsPhoto(error)) void native.resyncSession(item.sessionId).catch(() => undefined);
    return false;
  }
}

/** **La** única implementación que resuelve: la usa cada tarjeta. */
export function resolver(native: NativeBridge, item: HumanInputItem) {
  const { sessionId, id } = item;
  return {
    approve: (forSession: boolean) =>
      send(
        native,
        item,
        forSession ? 'Permitir en esta sesión' : 'Aprobar',
        () => native.approve(sessionId, id, { forSession }),
        true,
      ),
    deny: () => send(native, item, 'Denegar', () => native.deny(sessionId, id), false),
    answer: (answers: QuestionAnswerInput[] | null) =>
      send(
        native,
        item,
        answers ? 'Enviar respuestas' : 'Omitir las preguntas',
        () => native.answerQuestions(sessionId, id, answers),
        answers !== null,
      ),
    decide: (decision: 'approve' | 'reject') =>
      send(
        native,
        item,
        decision === 'approve' ? 'Aprobar el plan' : 'Rechazar el plan',
        () => native.decidePlan(sessionId, id, decision),
        decision === 'approve',
      ),
  };
}

export type Resolver = ReturnType<typeof resolver>;

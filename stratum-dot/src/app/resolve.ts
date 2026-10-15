/**
 * Resolver lo que una sesión espera de una persona. **Una** implementación,
 * la que usa cada tarjeta del centro de aprobaciones (y a la que lleva el chat).
 *
 * Reglas (`docs/dot.md` §13):
 *
 *  - Se pide al broker nativo **qué** resolver; la autoridad la pone él. Aquí
 *    no hay credenciales.
 *  - **Sin optimismo**: aceptar la petición no marca nada como aprobado. La
 *    solicitud deja de estar pendiente cuando la foto lo dice (su `*.resolved`),
 *    y cómo acabó lo cuenta ese evento.
 *  - **Sin reintentos**: una resolución es mutante. Enviada y sin respuesta, el
 *    resultado es desconocido; se dice, se pide una foto y no se reenvía.
 *  - Si otro llegó antes (`ALREADY_RESOLVED`), se dice y se pide una foto.
 *  - Nunca se resuelve sola: cada llamada sale de un clic de la persona.
 */
import { useCallback } from 'react';
import { useNative } from '../bridge/context';
import { toCommandError, type CommandError, type QuestionAnswerInput } from '../bridge/native';
import type { HumanInputItem } from '../protocol/interactions';
import { useUi } from '../stores/uiStore';

export function describeResolutionError(error: CommandError, item: HumanInputItem): string {
  switch (error.kind) {
    case 'unknown':
      return 'Result unknown: the connection dropped before the daemon answered. It was not sent again — Dot shows the outcome when the session reports it.';
    case 'not-sent':
    case 'invalid':
    case 'no-answer':
      return error.message;
    case 'rejected':
      break;
  }
  switch (error.code) {
    case 'ALREADY_RESOLVED':
      return 'Already resolved elsewhere (in its terminal, by another client, or because it expired).';
    case 'NOT_FOUND':
      return 'This request no longer exists for this session.';
    case 'INVALID_PARAMS':
      return item.kind === 'approval' && item.approval.confirmPhrase !== undefined
        ? 'The confirmation phrase does not match. Nothing was approved.'
        : `The daemon did not accept this answer. Nothing was resolved. (${error.message})`;
    case 'UNAVAILABLE':
      return error.reason === 'host-unavailable'
        ? "The session's host is not connected: it can only be resolved in its terminal."
        : error.message;
    case 'FORBIDDEN':
      return 'This connection is not allowed to resolve requests. Unlock approvals again.';
    default:
      return error.message;
  }
}

/** Errores tras los que lo que se ve puede estar desfasado: se pide una foto. */
function needsPhoto(error: CommandError): boolean {
  return error.kind === 'unknown' || error.code === 'ALREADY_RESOLVED' || error.code === 'NOT_FOUND';
}

export interface ResolveActions {
  approve(opts: { phrase?: string; forSession: boolean }): Promise<boolean>;
  deny(): Promise<boolean>;
  answer(answers: QuestionAnswerInput[] | null): Promise<boolean>;
  decide(decision: 'approve' | 'reject'): Promise<boolean>;
}

export function useResolve(item: HumanInputItem): ResolveActions {
  const native = useNative();
  const setResolution = useUi((s) => s.setResolution);
  const { id, sessionId } = item;
  // Por sesión e id: dos sesiones podrían publicar el mismo id.
  const key = `${sessionId}:${id}`;

  /** Una vez. Devuelve `true` si el daemon la aceptó. */
  const send = useCallback(
    async (action: string, call: () => Promise<void>): Promise<boolean> => {
      setResolution(key, { state: 'sending', action });
      try {
        await call();
        setResolution(key, { state: 'sent', action });
        return true;
      } catch (err) {
        const error = toCommandError(err);
        setResolution(key, { state: 'failed', action, message: describeResolutionError(error, item) });
        if (needsPhoto(error)) void native.resyncSession(sessionId).catch(() => undefined);
        return false;
      }
    },
    [item, key, native, sessionId, setResolution],
  );

  return {
    approve: ({ phrase, forSession }) =>
      send(forSession ? 'Allow for this session' : 'Approve', () =>
        native.approve(sessionId, id, { ...(phrase !== undefined ? { phrase } : {}), forSession }),
      ),
    deny: () => send('Deny', () => native.deny(sessionId, id)),
    answer: (answers) =>
      send(answers ? 'Send answers' : 'Skip questions', () => native.answerQuestions(sessionId, id, answers)),
    decide: (decision) =>
      send(decision === 'approve' ? 'Approve plan' : 'Reject plan', () => native.decidePlan(sessionId, id, decision)),
  };
}

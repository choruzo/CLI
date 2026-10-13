/**
 * Las cuatro órdenes de M6, siempre por el protocolo (vía el lado nativo).
 *
 * Regla: una orden aceptada **no** cambia el estado que se enseña. Se anota
 * como pendiente («Pause requested») y el estado cambia cuando el anfitrión de
 * la sesión lo publica. Nada de actualizaciones optimistas.
 */
import { useCallback } from 'react';
import { useNative } from '../bridge/context';
import { toCommandError, type CommandError } from '../bridge/native';
import type { ProtocolRun } from '../protocol';
import { useUi, type ControlKind } from '../stores/uiStore';

export function describeCommandError(error: CommandError): string {
  if (error.kind === 'rejected') {
    if (error.reason === 'host-unavailable') {
      return "The session's host is not connected, so it can't be controlled right now.";
    }
    if (error.reason === 'peer-hosted') return 'Only the process hosting this session can do that.';
    if (error.code === 'STALE_STATE') return 'That run is no longer the current one.';
    if (error.code === 'NOT_FOUND') return 'The session no longer exists.';
    if (error.code === 'FORBIDDEN') return 'This client is not allowed to control runs.';
  }
  return error.message;
}

/** Qué decir cuando la orden se atendió pero no había nada que hacer. */
const NOTHING_TO_DO: Record<string, string> = {
  'not-running': 'The run had already finished.',
  'not-paused': 'The run was not paused.',
  'already-paused': 'The run is already paused.',
};

/** Respuestas que significan «aceptada: espera al estado». */
const ACCEPTED: Record<ControlKind, readonly string[]> = {
  pause: ['requested', 'already-requested'],
  resume: ['resumed'],
  cancel: ['cancelled'],
};

const STEER_REFUSED: Record<string, string> = {
  'not-accepting': 'No run is accepting messages right now.',
  empty: 'Nothing to send.',
  'too-large': 'The message is too long. Nothing was sent.',
};

export interface RunActions {
  control(kind: ControlKind, run: ProtocolRun): Promise<void>;
  /** Devuelve `true` si el mensaje quedó en cola (y se puede vaciar el campo). */
  steer(text: string, paused: boolean): Promise<boolean>;
}

export function useRunActions(sessionId: string): RunActions {
  const native = useNative();
  const setPending = useUi((s) => s.setPending);
  const setNotice = useUi((s) => s.setNotice);

  const control = useCallback(
    async (kind: ControlKind, run: ProtocolRun) => {
      setNotice(sessionId, null);
      try {
        const status =
          kind === 'pause'
            ? await native.pauseRun(sessionId, run.id)
            : kind === 'resume'
              ? await native.resumeRun(sessionId, run.id)
              : await native.cancelRun(sessionId, run.id);
        if (ACCEPTED[kind].includes(status)) {
          setPending(sessionId, { kind, runId: run.id, fromStatus: run.status, at: Date.now() });
        } else {
          setPending(sessionId, null);
          const text = NOTHING_TO_DO[status];
          if (text) setNotice(sessionId, { text, tone: 'info' });
        }
      } catch (err) {
        setPending(sessionId, null);
        setNotice(sessionId, { text: describeCommandError(toCommandError(err)), tone: 'error' });
      }
    },
    [native, sessionId, setNotice, setPending],
  );

  const steer = useCallback(
    async (text: string, paused: boolean) => {
      setNotice(sessionId, null);
      try {
        const status = await native.steerRun(sessionId, text);
        if (status === 'accepted') {
          setNotice(sessionId, {
            tone: 'info',
            text: paused
              ? 'Steering queued. The run is still paused: resume it to deliver the message.'
              : 'Steering queued: the agent gets it at its next safe point.',
          });
          return true;
        }
        setNotice(sessionId, { tone: 'error', text: STEER_REFUSED[status] ?? `Not queued (${status}).` });
        return false;
      } catch (err) {
        setNotice(sessionId, { text: describeCommandError(toCommandError(err)), tone: 'error' });
        return false;
      }
    },
    [native, sessionId, setNotice],
  );

  return { control, steer };
}

/**
 * Lo que Dot pide al daemon, siempre por el protocolo (vía el lado nativo): las
 * cuatro órdenes sobre un run, abrir una sesión e iniciarle un run.
 *
 * Regla: algo aceptado **no** cambia el estado que se enseña. Se anota como
 * pendiente («Pause requested», «Sending…») y el estado cambia cuando el
 * anfitrión de la sesión lo publica. Nada de actualizaciones optimistas: ni un
 * run marcado a mano, ni un mensaje añadido a la conversación, ni una sesión
 * inventada en la lista.
 */
import { useCallback } from 'react';
import { useNative } from '../bridge/context';
import { toCommandError, type CommandError, type OpenSessionRequest } from '../bridge/native';
import { LIMITS, type ProtocolRun } from '../protocol';
import { parseOpenedSession, parseStartedRun } from '../protocol/results';
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
    if (error.code === 'BUSY') {
      return 'This session already has a run in progress. Steer it, or wait for it to finish.';
    }
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

/** El mensaje no cabe en el protocolo: no se envía, y no se recorta. */
export function tooLong(text: string): string | null {
  return text.length > LIMITS.inputChars
    ? `Message too long (${text.length.toLocaleString('en-US')} of ${LIMITS.inputChars.toLocaleString('en-US')} characters). Nothing was sent.`
    : null;
}

const UNKNOWN_SEND =
  'Result unknown: the connection dropped before the daemon answered. The message may or may not have started a run — check the conversation before sending it again.';

export interface RunActions {
  control(kind: ControlKind, run: ProtocolRun): Promise<void>;
  /** Devuelve `true` si el mensaje quedó en cola (y se puede vaciar el campo). */
  steer(text: string, paused: boolean): Promise<boolean>;
  /**
   * Un mensaje nuevo: un run nuevo de esta sesión. `previousRunId` es el run que
   * enseña la foto ahora. Devuelve `true` si el daemon lo aceptó.
   */
  send(text: string, previousRunId: string | null): Promise<boolean>;
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
      const long = tooLong(text);
      if (long) {
        setNotice(sessionId, { tone: 'error', text: long });
        return false;
      }
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

  const send = useCallback(
    (text: string, previousRunId: string | null) => sendMessage(native, sessionId, text, previousRunId),
    [native, sessionId],
  );

  return { control, steer, send };
}

type Native = ReturnType<typeof useNative>;

/** `runs.start`, una vez. Lo que pase después lo cuenta la foto. */
async function sendMessage(
  native: Native,
  sessionId: string,
  text: string,
  previousRunId: string | null,
): Promise<boolean> {
  const { setNotice, setSend } = useUi.getState();
  setNotice(sessionId, null);
  const long = tooLong(text);
  if (long) {
    setNotice(sessionId, { tone: 'error', text: long });
    return false;
  }
  setSend(sessionId, { previousRunId, at: Date.now() });
  try {
    const run = parseStartedRun(await native.startRun(sessionId, text));
    if (!run) {
      // El daemon contestó algo que no es del contrato: no se da nada por hecho.
      setSend(sessionId, null);
      setNotice(sessionId, { tone: 'error', text: 'The daemon answered in a way this version of Dot cannot read.' });
      void native.resyncSession(sessionId).catch(() => undefined);
      return false;
    }
    return true;
  } catch (err) {
    setSend(sessionId, null);
    const error = toCommandError(err);
    if (error.kind === 'unknown') {
      // No se reenvía. La foto dirá si el run existe.
      setNotice(sessionId, { tone: 'error', text: UNKNOWN_SEND });
      void native.resyncSession(sessionId).catch(() => undefined);
    } else {
      setNotice(sessionId, { tone: 'error', text: describeCommandError(error) });
    }
    return false;
  }
}

export type OpenOutcome = { ok: true; sessionId: string } | { ok: false; message: string };

/**
 * Abre una sesión **del daemon** y, si hay primer mensaje, se lo envía. La
 * sesión no se inventa aquí: se selecciona su id y aparece cuando el daemon la
 * publica (hasta entonces, «Opening session…»).
 */
export function useOpenChat(): (
  request: OpenSessionRequest,
  firstMessage: string,
  /** ¿Sigue la persona en el formulario? Si se fue, la sesión no se le pone delante. */
  stillHere?: () => boolean,
) => Promise<OpenOutcome> {
  const native = useNative();
  return useCallback(
    async (request, firstMessage, stillHere = () => true) => {
      const long = tooLong(firstMessage);
      if (long) return { ok: false, message: long };
      let sessionId: string;
      try {
        const session = parseOpenedSession(await native.openSession(request));
        if (!session) {
          return { ok: false, message: 'The daemon answered in a way this version of Dot cannot read.' };
        }
        sessionId = session.id;
      } catch (err) {
        const error = toCommandError(err);
        return {
          ok: false,
          message:
            error.kind === 'unknown'
              ? 'Result unknown: the daemon did not answer in time. If the session was created, it shows up in the list.'
              : describeCommandError(error),
        };
      }
      const ui = useUi.getState();
      if (request.cwd) ui.setLastCwd(request.cwd);
      if (stillHere()) {
        ui.setOpening(sessionId, Date.now());
        ui.setTab('chat');
        ui.select(sessionId);
        void native.focusSession(sessionId).catch(() => undefined);
      }
      // El mensaje se envía igual: se pidió con la sesión, y esta aparecerá en la lista.
      const text = firstMessage.trim();
      if (text && !(await sendMessage(native, sessionId, text, null))) {
        // Lo que no se envió no se pierde: queda escrito en la sesión nueva.
        useUi.getState().setDraft(sessionId, firstMessage);
      }
      return { ok: true, sessionId };
    },
    [native],
  );
}

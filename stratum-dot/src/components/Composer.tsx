import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { RunActions } from '../app/actions';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import { parseVoiceTranscript } from '../protocol/results';
import type { ComposerMode } from '../protocol/view';
import { useUi } from '../stores/uiStore';
import { insertNote, mmss, withMarker, type VoiceNote } from './voiceNote';

interface Props {
  sessionId: string;
  mode: ComposerMode;
  /** Run que enseña la foto ahora (en curso o el último), para saber cuándo llega el nuevo. */
  shownRunId: string | null;
  /** Hay un mensaje enviado cuyo run aún no ha aparecido. */
  sending: boolean;
  /** Dónde va un mensaje de steering: `cli`, `daemon`. */
  target: string;
  actions: RunActions;
}

/** La nota de voz: antes de que el micrófono esté abierto, grabando, y transcribiendo. */
type VoiceState = 'idle' | 'starting' | 'listening' | 'transcribing';

/**
 * El campo de escritura de una sesión. Hace **una de dos cosas**, y dice cuál:
 *
 *  - sin run en curso, *Ask Stratum…*: el mensaje abre un run nuevo;
 *  - con un run en curso (también en pausa), *Steer current run…*: el mensaje
 *    se entrega a ese run. Nunca abre otro, ni se encola «para después».
 *
 * Lo escrito es un borrador de la interfaz: no sale de Dot hasta enviarlo, y no
 * se borra si el envío falla.
 *
 * M25 fase 4 — el micro se mantiene pulsado para grabar. El audio lo graba y lo
 * transcribe el lado nativo; aquí solo se pide empezar, se pide parar, y el
 * texto que vuelve se pone en el campo. Al enviar, la marca del principio dice
 * que ese texto salió de una nota (`voiceNote.ts`), y solo si sigue tal cual.
 */
export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { sessionId, mode, shownRunId, sending, target, actions },
  ref,
) {
  const text = useUi((s) => s.drafts[sessionId] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const native = useNative();
  const [busy, setBusy] = useState(false);
  const [voice, setVoiceState] = useState<VoiceState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  /** Cambia para pedir el foco al campo cuando el texto de la nota ya está puesto. */
  const [focusRequest, setFocusRequest] = useState(0);

  /**
   * El estado de la voz que leen los manejadores: los del puntero y los de la
   * ventana llegan sin esperar a un re-render, y decidir con el estado de React
   * haría que dos gestos seguidos se pisaran.
   */
  const state = useRef<VoiceState>('idle');
  const setVoice = useCallback((next: VoiceState) => {
    state.current = next;
    setVoiceState(next);
  }, []);
  /** Se soltó (o se canceló) mientras `voiceStart` aún no había vuelto. */
  const pending = useRef<'stop' | 'cancel' | null>(null);
  /** Hay un puntero o una tecla pulsada: soltarla termina la nota. */
  const held = useRef(false);
  const startedAt = useRef(0);
  const note = useRef<VoiceNote | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // El `ref` de fuera puede ser función u objeto: se guarda uno propio y se pasa a los dos.
  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      area.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const steering = mode.kind === 'steer';
  const off = mode.kind === 'off';
  const blocked = off || busy || (mode.kind === 'ask' && sending);
  /** El campo no admite texto: el micro tampoco (lo que transcriba iría a un campo muerto). */
  const fieldDisabled = off || (mode.kind === 'ask' && sending);
  const value = text.trim();

  /** Tirar la nota en el lado nativo: ni transcripción ni audio. */
  const discardVoice = useCallback(async () => {
    try {
      await native.voiceCancel();
    } catch {
      // El lado nativo la tira igual al perder el foco o al cerrarse la ventana.
    }
  }, [native]);

  /** Cancelar es no dejar texto: ni la marca, ni la transcripción a medias. */
  const cancelVoice = useCallback(async () => {
    if (state.current === 'starting') {
      // Todavía no se sabe si el micrófono está abierto: se tira en cuanto lo esté.
      pending.current = 'cancel';
      return;
    }
    if (state.current === 'idle') return;
    setVoice('idle');
    await discardVoice();
  }, [discardVoice, setVoice]);

  /** Soltar ya: si aún está arrancando, se para en cuanto arranque. */
  const stopVoice = async () => {
    if (state.current === 'starting') {
      pending.current = 'stop';
      return;
    }
    if (state.current !== 'listening') return;
    setVoice('transcribing');
    let failure: string | null = null;
    try {
      const transcript = parseVoiceTranscript(await native.voiceStop());
      if (!transcript) {
        failure = 'The note could not be read.';
      } else {
        // Lo que ya estuviera escrito se queda delante; el cursor, al final.
        setDraft(sessionId, insertNote(useUi.getState().drafts[sessionId] ?? '', transcript.text));
        note.current = {
          inserted: transcript.text,
          durationSec: transcript.durationSec,
          capped: transcript.capped,
        };
        setFocusRequest((n) => n + 1);
      }
    } catch (err) {
      failure = toCommandError(err).message;
    }
    setVoice('idle');
    if (failure) setVoiceError(failure);
  };

  const startVoice = async () => {
    if (fieldDisabled || state.current !== 'idle') return;
    pending.current = null;
    setVoiceError(null);
    setVoice('starting');
    try {
      await native.voiceStart(sessionId);
    } catch (err) {
      // No hay nada grabando: a reposo, y se dice por qué. Dos `voiceStart` a la vez, nunca.
      setVoice('idle');
      setVoiceError(toCommandError(err).message);
      return;
    }
    if (pending.current === 'cancel') {
      pending.current = null;
      setVoice('idle');
      await discardVoice();
      return;
    }
    startedAt.current = Date.now();
    setSeconds(0);
    setVoice('listening');
    if (pending.current === 'stop') {
      pending.current = null;
      void stopVoice();
    }
  };

  // El cronómetro mientras se escucha: propio, cada 250 ms desde que el micro se abrió.
  useEffect(() => {
    if (voice !== 'listening') return;
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [voice]);

  // Grabar exige la ventana con el foco: si se pierde, la nota se tira (el nativo
  // ya la tira; esto es para que la interfaz no se quede diciendo «Listening…»).
  useEffect(() => {
    const onBlur = () => {
      if (state.current !== 'starting' && state.current !== 'listening') return;
      void cancelVoice();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [cancelVoice]);

  // Al desmontar con una nota en curso, el micrófono no se queda abierto.
  useEffect(
    () => () => {
      if (state.current === 'starting' || state.current === 'listening') void discardVoice();
    },
    [discardVoice],
  );

  // Con el texto de la nota ya pintado, el cursor va al final de lo que se ve.
  useEffect(() => {
    if (focusRequest === 0) return;
    const node = area.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [focusRequest]);

  const submit = async () => {
    if (!value || blocked) return;
    setBusy(true);
    // La marca la pone Dot al enviar: solo si el texto de la nota sigue tal cual.
    const message = withMarker(value, note.current);
    try {
      const sent = steering ? await actions.steer(message, mode.paused) : await actions.send(message, shownRunId);
      // Solo se vacía si salió, y solo si no se ha escrito otra cosa entretanto.
      if (sent && (useUi.getState().drafts[sessionId] ?? '').trim() === value) {
        setDraft(sessionId, '');
        note.current = null;
      }
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía; Shift+Enter es una línea nueva. Componiendo (IME), Enter es del teclado.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const onVoicePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // Solo el botón principal del puntero graba.
    if (event.button > 0 || held.current) return;
    held.current = true;
    try {
      // La captura mantiene el soltar en el botón aunque el puntero se salga del micro.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sin captura (o sin puntero fino) el soltar llega al botón igualmente.
    }
    void startVoice();
  };

  const onVoicePointerUp = () => {
    if (!held.current) return;
    held.current = false;
    void stopVoice();
  };

  const onVoicePointerCancel = () => {
    if (!held.current) return;
    held.current = false;
    void cancelVoice();
  };

  const onVoiceLostCapture = () => {
    // Se perdió la captura sin soltar (otro gesto se la llevó): la nota no sigue.
    if (!held.current) return;
    held.current = false;
    void cancelVoice();
  };

  // Si el foco se va del botón sin haberlo soltado (una tecla mantenida y `Tab`),
  // la nota no se queda grabando sola.
  const onVoiceBlur = () => {
    if (!held.current) return;
    held.current = false;
    void cancelVoice();
  };

  // Con el foco en el botón, mantener Space o Enter graba y soltarlo termina: lo
  // mismo que el puntero, sin depender de que el navegador convierta la tecla en `click`.
  const onVoiceKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat || held.current) return;
    held.current = true;
    void startVoice();
  };

  const onVoiceKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!held.current) return;
    held.current = false;
    void stopVoice();
  };

  const voiceLabel =
    voice === 'listening'
      ? 'Recording a voice note'
      : voice === 'transcribing'
        ? 'Transcribing the voice note'
        : 'Hold to record a voice note';
  const voiceLine =
    voiceError ??
    (voice === 'listening'
      ? `Listening… ${mmss(seconds)}`
      : voice === 'transcribing'
        ? 'Transcribing…'
        : null);

  return (
    <form
      className="composer"
      data-mode={mode.kind}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      {steering ? (
        <p className="composer-mode small" role="note">
          <strong>Steering the current run.</strong> This does not start a new message
          {mode.paused
            ? ': the run is paused, and gets it when you resume. Anything approved during this pause is then discarded, not run.'
            : '.'}
        </p>
      ) : null}
      {off ? <p className="composer-mode small muted">{mode.reason}.</p> : null}
      <div className="composer-row">
        <textarea
          ref={attach}
          rows={2}
          value={text}
          disabled={fieldDisabled}
          title={off ? mode.reason : undefined}
          placeholder={steering ? 'Steer current run…' : off ? '' : 'Ask Stratum…'}
          aria-label={
            steering ? `Steer this run (steering → ${target})` : off ? 'Message (unavailable)' : 'Ask Stratum'
          }
          onChange={(event) => {
            // Lo que se escribe es la siguiente acción en el campo: el aviso de la nota se va.
            setVoiceError(null);
            setDraft(sessionId, event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn voice"
          data-state={voice === 'idle' ? undefined : voice}
          aria-label={voiceLabel}
          aria-pressed={voice === 'listening'}
          title="Hold to record a voice note"
          disabled={fieldDisabled}
          onPointerDown={onVoicePointerDown}
          onPointerUp={onVoicePointerUp}
          onPointerCancel={onVoicePointerCancel}
          onLostPointerCapture={onVoiceLostCapture}
          onKeyDown={onVoiceKeyDown}
          onKeyUp={onVoiceKeyUp}
          onBlur={onVoiceBlur}
        >
          <svg className="voice-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M8 2.4a2.3 2.3 0 0 1 2.3 2.3v3.1a2.3 2.3 0 0 1-4.6 0V4.7A2.3 2.3 0 0 1 8 2.4Z"
              fill="currentColor"
            />
            <path
              d="M3.9 7.6v.5a4.1 4.1 0 0 0 8.2 0v-.5M8 12.2v1.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="submit"
          className={`btn${steering ? '' : ' primary'}`}
          disabled={blocked || value === ''}
          aria-label={steering ? 'Send steering message' : 'Send message'}
        >
          {steering ? 'Steer' : 'Send'}
        </button>
      </div>
      {voiceLine ? (
        <p className={`composer-voice small${voiceError ? ' bad' : ''}`} role="status" aria-live="polite">
          {voiceLine}
        </p>
      ) : null}
    </form>
  );
});

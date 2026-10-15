import { forwardRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RunActions } from '../app/actions';
import type { ComposerMode } from '../protocol/view';
import { useUi } from '../stores/uiStore';

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

/**
 * El campo de escritura de una sesión. Hace **una de dos cosas**, y dice cuál:
 *
 *  - sin run en curso, *Ask Stratum…*: el mensaje abre un run nuevo;
 *  - con un run en curso (también en pausa), *Steer current run…*: el mensaje
 *    se entrega a ese run. Nunca abre otro, ni se encola «para después».
 *
 * Lo escrito es un borrador de la interfaz: no sale de Dot hasta enviarlo, y no
 * se borra si el envío falla.
 */
export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { sessionId, mode, shownRunId, sending, target, actions },
  ref,
) {
  const text = useUi((s) => s.drafts[sessionId] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const [busy, setBusy] = useState(false);

  const steering = mode.kind === 'steer';
  const off = mode.kind === 'off';
  const blocked = off || busy || (mode.kind === 'ask' && sending);
  const value = text.trim();

  const submit = async () => {
    if (!value || blocked) return;
    setBusy(true);
    try {
      const sent = steering ? await actions.steer(value, mode.paused) : await actions.send(value, shownRunId);
      // Solo se vacía si salió, y solo si no se ha escrito otra cosa entretanto.
      if (sent && (useUi.getState().drafts[sessionId] ?? '').trim() === value) setDraft(sessionId, '');
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
          ref={ref}
          rows={2}
          value={text}
          disabled={off || (mode.kind === 'ask' && sending)}
          title={off ? mode.reason : undefined}
          placeholder={steering ? 'Steer current run…' : off ? '' : 'Ask Stratum…'}
          aria-label={
            steering ? `Steer this run (steering → ${target})` : off ? 'Message (unavailable)' : 'Ask Stratum'
          }
          onChange={(event) => setDraft(sessionId, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className={`btn${steering ? '' : ' primary'}`}
          disabled={blocked || value === ''}
          aria-label={steering ? 'Send steering message' : 'Send message'}
        >
          {steering ? 'Steer' : 'Send'}
        </button>
      </div>
    </form>
  );
});

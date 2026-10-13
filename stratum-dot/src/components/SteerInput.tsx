import { forwardRef, useState, type FormEvent } from 'react';
import type { RunActions } from '../app/actions';

interface Props {
  enabled: boolean;
  disabledReason?: string;
  paused: boolean;
  /** Dónde va el mensaje: `cli`, `daemon`. */
  target: string;
  actions: RunActions;
}

/** Tope del campo. El límite de verdad lo pone el runtime (`too-large`): nunca se recorta. */
const MAX_CHARS = 200_000;

/** Un mensaje para el run en curso. Es *steering*: no cancela ni abre otro turno. */
export const SteerInput = forwardRef<HTMLInputElement, Props>(function SteerInput(
  { enabled, disabledReason, paused, target, actions },
  ref,
) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy || !enabled) return;
    setBusy(true);
    try {
      // Solo se vacía si quedó en cola: lo que no se envió no se pierde.
      if (await actions.steer(value, paused)) setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="steer" onSubmit={(e) => void submit(e)}>
      <input
        ref={ref}
        type="text"
        value={text}
        maxLength={MAX_CHARS}
        disabled={!enabled}
        title={enabled ? undefined : disabledReason}
        placeholder="Steer this run…"
        aria-label={`Steer this run (steering → ${target})`}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="submit"
        className="btn"
        disabled={!enabled || busy || text.trim() === ''}
        aria-label="Send steering message"
      >
        Send
      </button>
    </form>
  );
});

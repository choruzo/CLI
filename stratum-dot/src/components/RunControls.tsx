import { useEffect, useState } from 'react';
import type { ProtocolRun } from '../protocol';
import type { RunActions } from '../app/actions';
import type { ControlKind, PendingControl } from '../stores/uiStore';

interface Props {
  run: ProtocolRun;
  /** Hay conexión, capacidad `control` y anfitrión conectado. */
  enabled: boolean;
  /** Por qué no se puede, para el `title` de los botones. */
  disabledReason?: string;
  pending: PendingControl | null;
  actions: RunActions;
}

const PENDING_LABEL: Record<ControlKind, string> = {
  pause: 'Pause requested…',
  resume: 'Resume requested…',
  cancel: 'Cancel requested…',
};

/**
 * Pause / Resume / Cancel. Qué botón se ofrece sale del estado que publica el
 * anfitrión; pulsar uno no lo cambia: solo aparece «… requested» hasta que el
 * estado de verdad llega.
 */
export function RunControls({ run, enabled, disabledReason, pending, actions }: Props) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const paused = run.status === 'paused';

  // La confirmación de cancelar es de este run y de este estado.
  useEffect(() => setConfirmingCancel(false), [run.id, run.status]);

  const act = async (kind: ControlKind) => {
    setBusy(true);
    try {
      await actions.control(kind, run);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  };
  const off = !enabled || busy || pending !== null;
  const title = enabled ? undefined : disabledReason;

  return (
    <div className="controls" role="group" aria-label="Run controls">
      {paused ? (
        <button
          type="button"
          className="btn primary"
          disabled={off}
          title={title}
          aria-label="Resume run"
          onClick={() => void act('resume')}
        >
          Resume
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={off}
          title={title}
          aria-label="Pause run"
          onClick={() => void act('pause')}
        >
          Pause
        </button>
      )}
      {confirmingCancel ? (
        <>
          <button
            type="button"
            className="btn danger"
            disabled={off}
            aria-label="Confirm cancel run"
            onClick={() => void act('cancel')}
          >
            Cancel this run
          </button>
          <button type="button" className="btn ghost" aria-label="Keep the run" onClick={() => setConfirmingCancel(false)}>
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn ghost"
          disabled={off}
          title={title}
          aria-label="Cancel run"
          onClick={() => setConfirmingCancel(true)}
        >
          Cancel
        </button>
      )}
      {pending ? (
        <span className="pending" role="status">
          {PENDING_LABEL[pending.kind]}
        </span>
      ) : null}
    </div>
  );
}

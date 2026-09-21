import type { DestructiveDecision } from '../../ipc/types';
import type { PendingConfirm } from '../../hooks/conversation-reducer';

/**
 * Confirmación de una tool destructiva (15.4). «Permitir todo» vale para el
 * resto de **esta conversación**, no para la app: lo recuerda el sidecar.
 */
export function ConfirmDialog({
  request,
  onDecide,
}: {
  request: PendingConfirm;
  onDecide: (decision: DestructiveDecision) => void;
}) {
  return (
    <section className="confirm" role="alertdialog" aria-label="Confirmar acción">
      <p className="confirm__title">
        El asistente quiere usar <code>{request.tool}</code>
      </p>
      <pre className="confirm__description">{request.description}</pre>
      <div className="confirm__actions">
        <button type="button" className="button button--primary" onClick={() => onDecide('approve')}>
          Aprobar
        </button>
        <button type="button" className="button" onClick={() => onDecide('deny')}>
          Denegar
        </button>
        <button type="button" className="button" onClick={() => onDecide('allow-all')}>
          Permitir todo en esta conversación
        </button>
      </div>
    </section>
  );
}

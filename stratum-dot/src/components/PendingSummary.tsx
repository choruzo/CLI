import type { ProtocolSessionSnapshot } from '../protocol';
import { collectPending } from '../protocol/interactions';
import { preview } from '../protocol/view';
import { useApprover } from '../stores/approverStore';
import { useUi } from '../stores/uiStore';

/**
 * Lo que la sesión espera de una persona, dentro de su conversación. Aquí solo
 * se **enseña** y se lleva al centro de aprobaciones, que es el único sitio
 * donde se resuelve (una sola implementación: `InteractionCard`).
 */
export function PendingSummary({ snapshot }: { snapshot: ProtocolSessionSnapshot }) {
  const open = useUi((s) => s.openHumanInput);
  const status = useApprover((s) => s.status);
  const items = collectPending([snapshot.session.id], { [snapshot.session.id]: snapshot });
  if (items.length === 0) return null;
  const noKey = status.kind === 'unavailable' && status.reason === 'no-approver-key';
  const where = noKey
    ? snapshot.session.host.kind === 'peer'
      ? ' — remote approvals are off: resolve it in its terminal'
      : ' — remote approvals are off: the daemon has no approver key'
    : '';
  return (
    <section className="pending-box" aria-label="Waiting for you">
      <h3>
        Waiting for you
        <span className="muted small">{where}</span>
      </h3>
      <ul>
        {items.map((item) => (
          <li key={item.id} data-kind={item.kind}>
            {item.kind === 'approval' ? (
              <>
                <strong>Approval required</strong> · <span className="mono">{item.approval.tool}</span>
                {item.approval.target ? <span className="mono muted"> {item.approval.target}</span> : null}
                <span className="muted"> — {preview(item.approval.description, 160)}</span>
              </>
            ) : item.kind === 'question' ? (
              <>
                <strong>Question</strong>
                <span className="muted"> — {preview(item.request.questions[0]?.question ?? '', 160)}</span>
                {item.request.questions.length > 1 ? (
                  <span className="muted"> (+{item.request.questions.length - 1})</span>
                ) : null}
              </>
            ) : (
              <>
                <strong>Plan</strong>
                <span className="muted">
                  {' '}
                  — {preview(item.request.plan.summary, 160)} ({item.request.plan.steps.length} steps)
                </span>
              </>
            )}{' '}
            {noKey ? null : (
              <button
                type="button"
                className="btn small"
                onClick={() => open(item.id)}
                aria-label={`Open in the Approval Center: ${item.kind}`}
              >
                Open
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

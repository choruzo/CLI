import type { ProtocolSessionSnapshot } from '../protocol';
import { preview } from '../protocol/view';

/**
 * Lo que la sesión espera de una persona. En M6 solo se **enseña**: resolverlo
 * exige la capacidad `approve`, que Dot no pide (ver `docs/dot.md`).
 */
export function PendingSummary({ snapshot }: { snapshot: ProtocolSessionSnapshot }) {
  const { approvals, questions, plans } = snapshot;
  if (approvals.length + questions.length + plans.length === 0) return null;
  const where =
    snapshot.session.host.kind === 'peer'
      ? 'in its terminal, or with `stratum approvals`'
      : 'with `stratum approvals`';
  return (
    <section className="pending-box" aria-label="Pending decisions">
      <h3>
        Waiting for a person
        <span className="muted small"> — resolve {where}</span>
      </h3>
      <ul>
        {approvals.map((a) => (
          <li key={a.id}>
            <strong>Approval</strong> · <span className="mono">{a.tool}</span>
            {a.target ? <span className="mono muted"> {a.target}</span> : null}
            <span className="muted"> — {preview(a.description, 160)}</span>
          </li>
        ))}
        {questions.map((q) => (
          <li key={q.id}>
            <strong>Question</strong>
            <span className="muted"> — {preview(q.questions[0]?.question ?? '', 160)}</span>
            {q.questions.length > 1 ? <span className="muted"> (+{q.questions.length - 1})</span> : null}
          </li>
        ))}
        {plans.map((p) => (
          <li key={p.id}>
            <strong>Plan</strong>
            <span className="muted">
              {' '}
              — {preview(p.plan.summary, 160)} ({p.plan.steps.length} steps)
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

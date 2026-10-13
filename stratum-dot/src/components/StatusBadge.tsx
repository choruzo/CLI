import { STATUS_LABEL, STATUS_TONE, type DisplayStatus, type Tone } from '../protocol/view';

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot tone-${tone}`} aria-hidden="true" />;
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span className={`badge tone-${STATUS_TONE[status]}`} data-status={status}>
      <Dot tone={STATUS_TONE[status]} />
      {STATUS_LABEL[status]}
    </span>
  );
}

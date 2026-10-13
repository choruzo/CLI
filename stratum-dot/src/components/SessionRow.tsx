import type { SessionEntry } from '../stores/sessionStore';
import { activeRun, displayStatus, formatDuration, hostLabel, pendingCount, preview } from '../protocol/view';
import { StatusBadge } from './StatusBadge';

interface Props {
  sessionId: string;
  entry: SessionEntry;
  selected: boolean;
  now: number;
  onSelect(): void;
}

/** Una sesión viva en la lista. La misma fila para las del daemon y las de una terminal. */
export function SessionRow({ sessionId, entry, selected, now, onSelect }: Props) {
  const { snapshot } = entry;
  if (!snapshot) {
    return (
      <button type="button" className="row" aria-current={selected || undefined} onClick={onSelect}>
        <span className="row-title muted">{entry.unreadable ? 'Unreadable session' : 'Loading…'}</span>
        <span className="row-meta mono">{sessionId}</span>
      </button>
    );
  }
  const { session } = snapshot;
  const status = displayStatus(snapshot);
  const run = activeRun(snapshot);
  const pending = pendingCount(snapshot);
  return (
    <button
      type="button"
      className="row"
      aria-current={selected || undefined}
      aria-label={`Session ${session.title || session.id}, ${status}`}
      onClick={onSelect}
    >
      <span className="row-top">
        <span className="row-title">{preview(session.title || session.agent, 60)}</span>
        <StatusBadge status={status} />
      </span>
      <span className="row-meta">
        <span>{session.agent}</span>
        <span>{session.model}</span>
        <span data-host={session.host.kind}>{hostLabel(snapshot)}</span>
        {run && status !== 'detached' ? <span>{formatDuration(now - run.startedAt)}</span> : null}
        {pending > 0 ? <span className="tone-waiting">{pending} pending</span> : null}
      </span>
      <span className="row-meta mono" title={session.cwd}>
        {session.cwd}
      </span>
    </button>
  );
}

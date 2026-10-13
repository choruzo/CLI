import type { ActivityEntry } from '../protocol/activity';
import { Dot } from './StatusBadge';

function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Lo último que pasó en la sesión, lo más reciente arriba. */
export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return <p className="muted small">Nothing yet. Events show up here as they happen.</p>;
  }
  return (
    <ol className="activity" aria-label="Recent activity">
      {[...entries].reverse().map((entry, index) => (
        <li key={`${entry.seq}:${entry.type}:${index}`} data-type={entry.type}>
          <Dot tone={entry.tone} />
          <span className="activity-time mono">{clock(entry.at)}</span>
          <span className="activity-body">
            <span>{entry.label}</span>
            {entry.detail ? <span className="muted"> — {entry.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

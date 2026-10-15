import { memo } from 'react';
import { ErrorBoundary } from '../app/ErrorBoundary';
import { SessionRow } from '../components/SessionRow';
import { useSessions } from '../stores/sessionStore';

interface Props {
  selectedId: string | null;
  now: number;
  /** Sin conexión: lo que se ve es lo último que se supo. */
  stale: boolean;
  connected: boolean;
  /** Este Dot puede abrir una sesión en el daemon. */
  canOpen: boolean;
  onSelect(id: string): void;
  onNewChat(): void;
}

/**
 * Una fila, suscrita solo a **su** sesión: el texto que llega a la que se está
 * mirando no repinta las demás.
 */
const Row = memo(function Row({
  id,
  selected,
  now,
  onSelect,
}: {
  id: string;
  selected: boolean;
  now: number;
  onSelect(id: string): void;
}) {
  const entry = useSessions((s) => s.sessions[id]);
  if (!entry) return null;
  return (
    <li>
      {/* Una sesión que no se puede pintar no se lleva por delante a las demás. */}
      <ErrorBoundary
        resetKey={entry.snapshot?.seq}
        fallback={() => (
          <div className="row broken" role="alert">
            <span className="row-title">This session can&apos;t be displayed</span>
            <span className="row-meta mono">{id}</span>
          </div>
        )}
      >
        <SessionRow sessionId={id} entry={entry} selected={selected} now={now} onSelect={() => onSelect(id)} />
      </ErrorBoundary>
    </li>
  );
});

/** Las sesiones vivas que conoce el daemon —las suyas y las de una terminal— y cómo abrir una. */
export function Overview({ selectedId, now, stale, connected, canOpen, onSelect, onNewChat }: Props) {
  const order = useSessions((s) => s.order);
  const unfollowed = useSessions((s) => s.unfollowed);

  return (
    <nav className={`overview${stale ? ' stale' : ''}`} aria-label="Sessions">
      <div className="overview-head">
        <h2>
          Sessions <span className="muted">{order.length}</span>
          {stale && order.length > 0 ? <span className="muted small"> · last known</span> : null}
        </h2>
        <button
          type="button"
          className="btn primary small"
          disabled={!canOpen}
          title={canOpen ? 'Start a new session hosted by the daemon (Ctrl+N)' : 'Not connected to the Stratum daemon'}
          aria-label="New chat"
          onClick={onNewChat}
        >
          + New chat
        </button>
      </div>
      {unfollowed > 0 ? (
        <p className="note small partial" role="note" data-partial={unfollowed}>
          Partial view: {unfollowed} more live {unfollowed === 1 ? 'session is' : 'sessions are'} not shown. Dot
          follows up to {order.length} at a time; they appear here when others end.
        </p>
      ) : null}
      {order.length === 0 ? (
        <p className="muted small empty">
          {connected
            ? 'No live sessions. Start a chat here, or run `stratum run` / `stratum chat` in a terminal and it shows up.'
            : 'No sessions to show.'}
        </p>
      ) : (
        <ul className="rows">
          {order.map((id) => (
            <Row key={id} id={id} selected={id === selectedId} now={now} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </nav>
  );
}

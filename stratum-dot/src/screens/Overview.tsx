import { ErrorBoundary } from '../app/ErrorBoundary';
import { SessionRow } from '../components/SessionRow';
import { useSessions } from '../stores/sessionStore';

interface Props {
  selectedId: string | null;
  now: number;
  /** Sin conexión: lo que se ve es lo último que se supo. */
  stale: boolean;
  connected: boolean;
  onSelect(id: string): void;
}

/** Las sesiones vivas que conoce el daemon: el equivalente visual de `stratum ps --watch`. */
export function Overview({ selectedId, now, stale, connected, onSelect }: Props) {
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);

  return (
    <nav className={`overview${stale ? ' stale' : ''}`} aria-label="Sessions">
      <h2>
        Sessions <span className="muted">{order.length}</span>
        {stale && order.length > 0 ? <span className="muted small"> · last known</span> : null}
      </h2>
      {order.length === 0 ? (
        <p className="muted small empty">
          {connected
            ? 'No live sessions. Start one with `stratum run` or `stratum chat` and it shows up here.'
            : 'No sessions to show.'}
        </p>
      ) : (
        <ul className="rows">
          {order.map((id) => {
            const entry = sessions[id];
            if (!entry) return null;
            return (
              <li key={id}>
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
                  <SessionRow
                    sessionId={id}
                    entry={entry}
                    selected={id === selectedId}
                    now={now}
                    onSelect={() => onSelect(id)}
                  />
                </ErrorBoundary>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

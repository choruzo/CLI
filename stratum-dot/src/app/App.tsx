import { useCallback, useEffect, useRef } from 'react';
import { useNative } from '../bridge/context';
import { ConnectionBanner, connectionLabel, connectionTone } from '../components/ConnectionBanner';
import { Dot } from '../components/StatusBadge';
import { Incompatible } from '../screens/Incompatible';
import { Overview } from '../screens/Overview';
import { SessionDetail } from '../screens/SessionDetail';
import { canControl, useConnection } from '../stores/connectionStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import { ErrorBoundary } from './ErrorBoundary';
import { useNow } from './useNow';

/** Cabecera (daemon + sesiones), lista, detalle y pie con las versiones. */
export function App() {
  const native = useNative();
  const connection = useConnection((s) => s.state);
  const info = useConnection((s) => s.info);
  const lastServerVersion = useConnection((s) => s.lastServerVersion);
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const now = useNow();
  const steerRef = useRef<HTMLInputElement>(null);

  const connected = connection.kind === 'connected';
  const selected = selectedId ? sessions[selectedId] : undefined;

  const choose = useCallback(
    (id: string | null) => {
      select(id);
      void native.focusSession(id).catch(() => undefined);
    },
    [native, select],
  );
  const retry = useCallback(() => void native.retry().catch(() => undefined), [native]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        steerRef.current?.focus();
        return;
      }
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      // Primero suelta el campo; un segundo Esc oculta la ventana.
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur();
        return;
      }
      void native.hideWindow().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [native]);

  return (
    <div className="shell" data-detail={selected ? 'open' : 'closed'}>
      <header className="top">
        <h1>Stratum Dot</h1>
        <span className="top-status" role="status" aria-live="polite" data-connection={connection.kind}>
          <Dot tone={connectionTone(connection)} />
          {connectionLabel(connection)}
          {connected ? <span className="muted"> · daemon {connection.serverVersion}</span> : null}
        </span>
        <span className="top-count" aria-label={`${order.length} live sessions`}>
          {order.length} {order.length === 1 ? 'session' : 'sessions'}
        </span>
      </header>

      <ConnectionBanner state={connection} hasStaleSessions={order.length > 0} onRetry={retry} />

      {connection.kind === 'incompatible' ? (
        <main className="body">
          <Incompatible state={connection} onRetry={retry} />
        </main>
      ) : (
        <main className="body split">
          <Overview
            selectedId={selectedId}
            now={now}
            stale={!connected}
            connected={connected}
            onSelect={choose}
          />
          {selectedId && selected ? (
            <ErrorBoundary
              resetKey={`${selectedId}:${selected.snapshot?.seq ?? ''}`}
              fallback={() => (
                <section className="detail" role="alert">
                  <button type="button" className="btn ghost back" onClick={() => choose(null)}>
                    ← Sessions
                  </button>
                  <p>This session can&apos;t be displayed. The rest of Dot keeps working.</p>
                </section>
              )}
            >
              <SessionDetail
                sessionId={selectedId}
                entry={selected}
                now={now}
                canControl={canControl(connection)}
                connected={connected}
                steerRef={steerRef}
                onBack={() => choose(null)}
              />
            </ErrorBoundary>
          ) : (
            <section className="detail placeholder" aria-label="Session detail">
              <p className="muted">Select a session to see its run, tools and activity.</p>
            </section>
          )}
        </main>
      )}

      <footer className="bottom">
        <span className="muted small">
          Dot {info?.dotVersion ?? '…'} · daemon {connected ? connection.serverVersion : (lastServerVersion ?? '—')} ·
          protocol {info?.protocol ?? '…'}
        </span>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => void native.quit().catch(() => undefined)}
          aria-label="Quit Stratum Dot (the daemon keeps running)"
          title="Quits Dot. The daemon and its sessions keep running."
        >
          Quit Dot
        </button>
      </footer>
    </div>
  );
}

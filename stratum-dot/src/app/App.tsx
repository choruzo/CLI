import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNative } from '../bridge/context';
import { ConnectionBanner, connectionLabel, connectionTone } from '../components/ConnectionBanner';
import { Dot } from '../components/StatusBadge';
import { collectPending } from '../protocol/interactions';
import { countByKind, countsLabel } from '../protocol/view';
import { Assistant } from '../screens/Assistant';
import { HumanInput } from '../screens/HumanInput';
import { Incompatible } from '../screens/Incompatible';
import { NewChat } from '../screens/NewChat';
import { Overview } from '../screens/Overview';
import { SessionDetail } from '../screens/SessionDetail';
import { canControl, useConnection } from '../stores/connectionStore';
import { useSessions } from '../stores/sessionStore';
import { OPENING_TTL_MS, useUi } from '../stores/uiStore';
import { ErrorBoundary } from './ErrorBoundary';
import { useNow } from './useNow';

/**
 * Cabecera (daemon, sesiones, lo que espera a una persona), lista y detalle (una
 * sesión o un chat nuevo) —o el asistente (M14), o el centro de aprobaciones— y
 * pie con las versiones.
 */
export function App() {
  const native = useNative();
  const connection = useConnection((s) => s.state);
  const info = useConnection((s) => s.info);
  const lastServerVersion = useConnection((s) => s.lastServerVersion);
  const count = useSessions((s) => s.order.length);
  const listed = useSessions((s) => s.listed);
  const selectedId = useUi((s) => s.selectedId);
  // Solo la sesión que se mira: lo que le llega a otra no repinta esto.
  const selected = useSessions((s) => (selectedId ? s.sessions[selectedId] : undefined));
  const composingNew = useUi((s) => s.composingNew);
  const openedAt = useUi((s) => (selectedId ? s.opening[selectedId] : undefined));
  const select = useUi((s) => s.select);
  const setComposingNew = useUi((s) => s.setComposingNew);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const openHumanInput = useUi((s) => s.openHumanInput);
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);
  const now = useNow();
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const connected = connection.kind === 'connected';
  const control = canControl(connection);

  const choose = useCallback(
    (id: string | null) => {
      select(id);
      void native.focusSession(id).catch(() => undefined);
    },
    [native, select],
  );
  const retry = useCallback(() => void native.retry().catch(() => undefined), [native]);
  const newChat = useCallback(() => setComposingNew(true), [setComposingNew]);

  // Lo que espera a una persona, de todas las sesiones: sale de sus fotos.
  const counts = useMemo(() => {
    const snapshots: Record<string, (typeof sessions)[string]['snapshot']> = {};
    for (const id of order) snapshots[id] = sessions[id]?.snapshot ?? null;
    return countByKind(collectPending(order, snapshots));
  }, [order, sessions]);
  const waiting = counts.approvals + counts.questions + counts.plans;
  // La bandeja enseña lo mismo (y pide atención si aparece algo con la ventana sin foco).
  const { approvals, questions, plans } = counts;
  useEffect(() => {
    void native.setAttention({ approvals, questions, plans }).catch(() => undefined);
  }, [native, approvals, questions, plans]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        composerRef.current?.focus();
        return;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === 'a') {
        // Abre el centro. No hay atajo para aprobar.
        event.preventDefault();
        openHumanInput();
        return;
      }
      if (command && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (control) newChat();
        return;
      }
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      // Primero suelta el campo; un segundo Esc cierra el centro (sin decidir
      // nada: Esc nunca deniega) o, si no, oculta la ventana.
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur();
        return;
      }
      if (useUi.getState().view !== 'sessions') {
        setView('sessions');
        return;
      }
      void native.hideWindow().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [native, control, newChat, openHumanInput, setView]);

  const back = (
    <button type="button" className="btn ghost back" onClick={() => choose(null)} aria-label="Back to sessions">
      ← Sessions
    </button>
  );

  let detail;
  if (composingNew) {
    detail = <NewChat canOpen={control} onCancel={() => setComposingNew(false)} />;
  } else if (selectedId && selected) {
    detail = (
      <ErrorBoundary
        resetKey={`${selectedId}:${selected.snapshot?.seq ?? ''}`}
        fallback={() => (
          <section className="detail" role="alert">
            {back}
            <p>This session can&apos;t be displayed. The rest of Dot keeps working.</p>
          </section>
        )}
      >
        <SessionDetail
          sessionId={selectedId}
          entry={selected}
          now={now}
          canControl={control}
          connected={connected}
          composerRef={composerRef}
          onBack={() => choose(null)}
        />
      </ErrorBoundary>
    );
  } else if (selectedId && openedAt !== undefined && now - openedAt < OPENING_TTL_MS) {
    // Dot la acaba de pedir: aparece cuando el daemon la publica. No se inventa.
    detail = (
      <section className="detail" aria-label="Session detail">
        {back}
        <p className="muted" role="status">
          Opening session…
        </p>
      </section>
    );
  } else if (selectedId && connected && listed) {
    // La sesión que se miraba ya no está: no hay a quién escribirle.
    detail = (
      <section className="detail" aria-label="Session detail" data-session="gone">
        {back}
        <h2>Session ended or unavailable</h2>
        <p className="muted">
          The daemon no longer lists this session. A session hosted by the daemon ends when it is closed or when the
          daemon stops; one hosted in a terminal comes back if its process reconnects.
        </p>
        <p className="mono small muted">{selectedId}</p>
        <div className="controls">
          <button type="button" className="btn" onClick={() => choose(null)}>
            Back to sessions
          </button>
          <button type="button" className="btn primary" disabled={!control} onClick={newChat}>
            New chat
          </button>
        </div>
      </section>
    );
  } else {
    detail = (
      <section className="detail placeholder" aria-label="Session detail">
        <p className="muted">Select a session, or start a new chat.</p>
      </section>
    );
  }

  return (
    <div className="shell" data-detail={composingNew || selectedId || view === 'assistant' ? 'open' : 'closed'}>
      <header className="top">
        <h1>Stratum Dot</h1>
        <span className="top-status" role="status" aria-live="polite" data-connection={connection.kind}>
          <Dot tone={connectionTone(connection)} />
          {connectionLabel(connection)}
          {connected ? <span className="muted"> · daemon {connection.serverVersion}</span> : null}
        </span>
        <span className="top-count" aria-label={`${count} live sessions`}>
          {count} {count === 1 ? 'session' : 'sessions'}
        </span>
        <button
          type="button"
          className="btn small"
          aria-pressed={view === 'assistant'}
          title="Talk to your assistant and manage its box"
          onClick={() => setView(view === 'assistant' ? 'sessions' : 'assistant')}
        >
          Assistant
        </button>
        <button
          type="button"
          className={`btn small waiting-badge ${waiting > 0 ? 'has' : ''}`}
          aria-pressed={view === 'human-input'}
          aria-label={`Approval Center: ${countsLabel(counts)}`}
          title="Approval Center (Ctrl+Shift+A)"
          data-waiting={waiting}
          onClick={() => (view === 'human-input' ? setView('sessions') : openHumanInput())}
        >
          Approvals <span className="count">{waiting}</span>
        </button>
      </header>

      <ConnectionBanner state={connection} hasStaleSessions={count > 0} onRetry={retry} />

      {connection.kind === 'incompatible' ? (
        <main className="body">
          <Incompatible state={connection} onRetry={retry} />
        </main>
      ) : view === 'human-input' ? (
        <main className="body">
          <HumanInput now={now} connected={connected} onBack={() => setView('sessions')} />
        </main>
      ) : view === 'assistant' ? (
        <Assistant
          now={now}
          canControl={control}
          connected={connected}
          composerRef={composerRef}
          onBack={() => setView('sessions')}
        />
      ) : (
        <main className="body split">
          <Overview
            selectedId={composingNew ? null : selectedId}
            now={now}
            stale={!connected}
            connected={connected}
            canOpen={control}
            onSelect={choose}
            onNewChat={newChat}
          />
          {detail}
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

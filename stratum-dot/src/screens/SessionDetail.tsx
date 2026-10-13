import type { RefObject } from 'react';
import { useRunActions } from '../app/actions';
import { ActivityPanel } from '../components/ActivityPanel';
import { Composer } from '../components/Composer';
import { RunControls } from '../components/RunControls';
import { StatusBadge } from '../components/StatusBadge';
import { Transcript } from '../components/Transcript';
import { STATUS_LABEL, activeRun, composerMode, displayStatus, hostLabel, isDetached, preview } from '../protocol/view';
import type { SessionEntry } from '../stores/sessionStore';
import { activePending, activeSend, useUi, type SessionTab } from '../stores/uiStore';

interface Props {
  sessionId: string;
  entry: SessionEntry;
  now: number;
  /** Hay conexión con el daemon y este Dot puede conducir runs. */
  canControl: boolean;
  connected: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  /** Deja de mirar la sesión. **No la cierra**: sigue viva en su anfitrión. */
  onBack(): void;
}

const TABS: ReadonlyArray<{ id: SessionTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Activity' },
];

/**
 * Una sesión: su conversación (Chat) o lo que se sabe de ella (Activity), los
 * controles de su run y el campo para escribirle. Sirve igual para una sesión
 * del daemon que para una de una terminal; lo que cambia es qué se le puede pedir.
 */
export function SessionDetail({ sessionId, entry, now, canControl, connected, composerRef, onBack }: Props) {
  const actions = useRunActions(sessionId);
  const pendingControl = useUi((s) => s.pending[sessionId]);
  const pendingSend = useUi((s) => s.sends[sessionId]);
  const notice = useUi((s) => s.notices[sessionId]);
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const { snapshot } = entry;

  const back = (
    <button type="button" className="btn ghost back" onClick={onBack} aria-label="Back to sessions">
      ← Sessions
    </button>
  );

  if (!snapshot) {
    return (
      <section className="detail" aria-label="Session detail">
        {back}
        <p className="muted">
          {entry.unreadable
            ? 'The daemon sent a state for this session that this version of Dot cannot read.'
            : 'Loading the session state…'}
        </p>
        <p className="mono small muted">{sessionId}</p>
      </section>
    );
  }

  const { session } = snapshot;
  const status = displayStatus(snapshot);
  const run = activeRun(snapshot);
  const detached = isDetached(snapshot);
  const pending = activePending(pendingControl, run, now);
  const sending = activeSend(pendingSend, snapshot, now) !== null;
  const enabled = canControl && !detached;
  const disabledReason = !connected
    ? 'Not connected to the Stratum daemon'
    : detached
      ? "The session's host is not connected"
      : !canControl
        ? 'This client cannot control runs'
        : undefined;
  const mode = composerMode(snapshot, { connected, canControl });
  const hosted = session.host.kind === 'daemon';

  return (
    <section className="detail session" aria-label="Session detail" data-host={session.host.kind}>
      <div className="session-head">
        {back}
        <header className="detail-head">
          <h2>{preview(session.title || (hosted ? 'New chat' : session.agent), 120)}</h2>
          <StatusBadge status={status} />
        </header>
        <p className="session-meta muted small" aria-label="Session">
          <span>{session.agent}</span>
          <span>{session.model}</span>
          <span data-host={session.host.kind}>{hostLabel(snapshot)}</span>
          <span className="mono" title={session.cwd}>
            {session.cwd}
          </span>
        </p>

        {detached ? (
          <p className="note" role="status">
            The process hosting this session is not connected to the daemon. It may still be running: this is not a
            failure.
            {run ? ` Last known run state: ${STATUS_LABEL[run.status].toLowerCase()}.` : ''}
          </p>
        ) : null}

        {run ? (
          <RunControls
            run={run}
            enabled={enabled}
            disabledReason={disabledReason}
            pending={pending}
            actions={actions}
          />
        ) : null}

        {notice ? (
          <p className={`note ${notice.tone === 'error' ? 'bad' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        ) : null}

        <div className="tabs" role="tablist" aria-label="Session views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'chat' ? (
        <Transcript
          key={`chat:${sessionId}`}
          snapshot={snapshot}
          sending={sending}
          empty={
            hosted
              ? 'No messages yet. Ask Stratum something below.'
              : 'Nothing to show yet. What this session says from now on appears here.'
          }
        />
      ) : (
        <div className="session-scroll">
          <ActivityPanel entry={entry} now={now} />
        </div>
      )}

      <Composer
        key={`composer:${sessionId}`}
        ref={composerRef}
        sessionId={sessionId}
        mode={mode}
        shownRunId={snapshot.run?.id ?? null}
        sending={sending}
        target={hosted ? 'daemon' : session.host.client}
        actions={actions}
      />
    </section>
  );
}

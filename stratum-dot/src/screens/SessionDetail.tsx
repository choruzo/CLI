import type { ReactNode, RefObject } from 'react';
import { useRunActions } from '../app/actions';
import { ActivityList } from '../components/ActivityList';
import { PendingSummary } from '../components/PendingSummary';
import { RunControls } from '../components/RunControls';
import { StatusBadge } from '../components/StatusBadge';
import { SteerInput } from '../components/SteerInput';
import { ToolCalls } from '../components/ToolCalls';
import {
  STATUS_LABEL,
  activeRun,
  displayStatus,
  formatCount,
  formatDuration,
  hostLabel,
  isDetached,
  lastRun,
  preview,
  tokensLabel,
} from '../protocol/view';
import type { SessionEntry } from '../stores/sessionStore';
import { activePending, useUi } from '../stores/uiStore';

interface Props {
  sessionId: string;
  entry: SessionEntry;
  now: number;
  /** Hay conexión con el daemon y este Dot puede conducir runs. */
  canControl: boolean;
  connected: boolean;
  steerRef: RefObject<HTMLInputElement>;
  onBack(): void;
}

const PARTIAL_CHARS = 1_200;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Lo que se sabe de una sesión, y los controles de su run. Sin transcript: eso es M7. */
export function SessionDetail({ sessionId, entry, now, canControl, connected, steerRef, onBack }: Props) {
  const actions = useRunActions(sessionId);
  const pendingControl = useUi((s) => s.pending[sessionId]);
  const notice = useUi((s) => s.notices[sessionId]);
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
  const finished = lastRun(snapshot);
  const detached = isDetached(snapshot);
  const shownRun = run ?? finished;
  const pending = activePending(pendingControl, run, now);
  const enabled = canControl && !detached;
  const disabledReason = !connected
    ? 'Not connected to the Stratum daemon'
    : detached
      ? "The session's host is not connected"
      : !canControl
        ? 'This client cannot control runs'
        : undefined;
  const partial = snapshot.partial.text;

  return (
    <section className="detail" aria-label="Session detail">
      {back}
      <header className="detail-head">
        <h2>{preview(session.title || session.agent, 120)}</h2>
        <StatusBadge status={status} />
      </header>

      {detached ? (
        <p className="note" role="status">
          The process hosting this session is not connected to the daemon. It may still be running: this is not a
          failure.
          {run ? ` Last known run state: ${STATUS_LABEL[run.status].toLowerCase()}.` : ''}
        </p>
      ) : null}

      {run ? (
        <>
          <RunControls
            run={run}
            enabled={enabled}
            disabledReason={disabledReason}
            pending={pending}
            actions={actions}
          />
          <SteerInput
            ref={steerRef}
            enabled={enabled}
            disabledReason={disabledReason}
            paused={run.status === 'paused'}
            target={session.host.kind === 'daemon' ? 'daemon' : session.host.client}
            actions={actions}
          />
          {session.host.kind === 'peer' ? (
            <p className="muted small">
              This session lives in a terminal: its own input stays there. What you send here is steering.
            </p>
          ) : null}
        </>
      ) : null}

      {notice ? (
        <p className={`note ${notice.tone === 'error' ? 'bad' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}

      <PendingSummary snapshot={snapshot} />

      <dl className="fields">
        <Field label="Run">
          {shownRun ? (
            <>
              {STATUS_LABEL[shownRun.status]}
              {' · '}
              {formatDuration((shownRun.endedAt ?? now) - shownRun.startedAt)}
              {shownRun.stopReason ? ` · ${shownRun.stopReason}` : ''}
              <span className="muted"> — {preview(shownRun.input, 100)}</span>
              {shownRun.error ? <span className="tone-bad"> {preview(shownRun.error, 160)}</span> : null}
            </>
          ) : (
            <span className="muted">No run yet</span>
          )}
        </Field>
        <Field label="Host">
          <span data-host={session.host.kind}>{hostLabel(snapshot)}</span>
          {session.host.connected ? '' : ' · disconnected'}
        </Field>
        <Field label="Agent">
          {session.agent}
          <span className="muted"> · profile {session.sessionProfile}</span>
          {session.readOnly ? <span className="tone-waiting"> · read-only</span> : null}
        </Field>
        <Field label="Model">
          {session.model}
          <span className="muted"> · {session.provider}</span>
        </Field>
        <Field label="Directory">
          <span className="mono">{session.cwd}</span>
        </Field>
        <Field label="Target">
          <span className="mono">{session.activeTarget}</span>
          {session.environment ? (
            <span className="muted">
              {' '}
              · {session.environment.name} ({session.environment.tier})
            </span>
          ) : null}
        </Field>
        <Field label="Context">
          {session.context.pct}%
          <span className="muted">
            {' '}
            · {formatCount(session.context.used)} / {formatCount(session.context.max)}
            {session.context.estimated ? ' (estimated)' : ''}
          </span>
        </Field>
        <Field label="Tokens">{tokensLabel(snapshot)}</Field>
        <Field label="Jobs">
          {snapshot.jobs.filter((j) => j.status === 'running').length} running
          <span className="muted"> · {snapshot.jobs.length} total</span>
        </Field>
        <Field label="Tools">
          {shownRun ? shownRun.counters.toolCalls : 0} calls
          {shownRun && shownRun.counters.toolErrors > 0 ? (
            <span className="tone-bad"> · {shownRun.counters.toolErrors} failed</span>
          ) : null}
          {snapshot.subagents.length > 0 ? <span className="muted"> · {snapshot.subagents.length} subagents</span> : null}
        </Field>
        <Field label="Session">
          <span className="mono small">{session.id}</span>
        </Field>
      </dl>

      {partial ? (
        <section aria-label="Text being generated">
          <h3>
            Writing now <span className="muted small">— partial, may skip ahead</span>
          </h3>
          <p className="partial">{partial.length > PARTIAL_CHARS ? `…${partial.slice(-PARTIAL_CHARS)}` : partial}</p>
        </section>
      ) : null}

      <section>
        <h3>Tool calls</h3>
        <ToolCalls calls={snapshot.toolCalls} />
      </section>

      <section>
        <h3>Recent activity</h3>
        <ActivityList entries={entry.activity} />
      </section>
    </section>
  );
}

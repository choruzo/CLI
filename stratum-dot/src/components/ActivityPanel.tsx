import type { ReactNode } from 'react';
import {
  STATUS_LABEL,
  activeRun,
  formatCount,
  formatDuration,
  hostLabel,
  lastRun,
  preview,
  tokensLabel,
} from '../protocol/view';
import type { SessionEntry } from '../stores/sessionStore';
import { ActivityList } from './ActivityList';
import { PendingSummary } from './PendingSummary';
import { ToolCalls } from './ToolCalls';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Lo que se sabe de la sesión y de su run, sus tools y lo último que pasó: la
 * vista de M6. No es la conversación (eso es la pestaña Chat) ni la traza.
 */
export function ActivityPanel({ entry, now }: { entry: SessionEntry; now: number }) {
  const { snapshot } = entry;
  if (!snapshot) return null;
  const { session } = snapshot;
  const shownRun = activeRun(snapshot) ?? lastRun(snapshot);

  return (
    <div className="activity-panel">
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

      <section>
        <h3>Tool calls</h3>
        <ToolCalls calls={snapshot.toolCalls} />
      </section>

      <section>
        <h3>Recent activity</h3>
        <ActivityList entries={entry.activity} />
      </section>
    </div>
  );
}

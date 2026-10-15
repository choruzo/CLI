import { useEffect, useRef } from 'react';
import { useNative } from '../bridge/context';
import type { ApproverStatus } from '../bridge/native';
import { InteractionCard } from '../components/InteractionCard';
import {
  OUTCOME_LABEL,
  collectPending,
  resolverLabel,
  type HumanInputItem,
  type Outcome,
} from '../protocol/interactions';
import { formatDuration, preview } from '../protocol/view';
import { useApprover } from '../stores/approverStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';

const LOCK_REASON: Record<string, string> = {
  initial: 'Approvals are locked.',
  manual: 'Approvals were locked.',
  expired: 'The unlock expired, so approvals locked again.',
  'connection-lost': 'The approval connection was lost, so approvals locked again.',
  'daemon-changed': 'The daemon restarted, so approvals locked again.',
};

/** De dónde sale la autoridad de aprobar, sin enseñar nada de ella. */
function AuthorityBar({ status, now }: { status: ApproverStatus; now: number }) {
  const native = useNative();
  const unlock = () => void native.unlockApprovals().catch(() => undefined);
  const lock = () => void native.lockApprovals().catch(() => undefined);

  let text: string;
  let action = null;
  switch (status.kind) {
    case 'ready':
      text = `Unlocked: you can resolve requests from Dot. Locks again in ${formatDuration(Math.max(0, status.expiresAt - now))}.`;
      action = (
        <button type="button" className="btn" onClick={lock}>
          Lock approvals
        </button>
      );
      break;
    case 'unlocking':
      text = 'Checking the approver key with the daemon…';
      break;
    case 'locked':
      text = `${LOCK_REASON[status.reason] ?? 'Approvals are locked.'} Unlocking opens a separate window to type your approver key.`;
      action = (
        <button type="button" className="btn primary" onClick={unlock}>
          Unlock approvals
        </button>
      );
      break;
    case 'error':
      text = `${status.message} Unlocking opens a separate window to type your approver key.`;
      action = (
        <button type="button" className="btn primary" onClick={unlock}>
          Try again
        </button>
      );
      break;
    case 'unavailable':
      text =
        status.reason === 'no-approver-key'
          ? 'Remote approvals are off: the daemon has no approver key. Set one with `stratum approvals set-key` and restart the daemon. Dot never creates a key; until then, requests are resolved in the terminal of their session.'
          : 'Not connected to the Stratum daemon.';
      break;
  }
  return (
    <div className="authority" role="status" data-approver={status.kind}>
      <span className="authority-state">{status.kind === 'ready' ? 'Unlocked' : status.kind === 'unlocking' ? 'Unlocking…' : status.kind === 'unavailable' ? 'Unavailable' : 'Locked'}</span>
      <span className="authority-text">{text}</span>
      {action}
    </div>
  );
}

const SECTIONS: ReadonlyArray<{ kind: HumanInputItem['kind']; title: string; empty: string }> = [
  { kind: 'approval', title: 'Approvals', empty: 'No approvals waiting.' },
  { kind: 'question', title: 'Questions', empty: 'No questions waiting.' },
  { kind: 'plan', title: 'Plans', empty: 'No plans waiting.' },
];

/**
 * Centro de aprobaciones: lo que **todas** las sesiones vivas esperan de una
 * persona, leído de sus fotos. Lo pendiente no se guarda aquí: aparece y
 * desaparece con la foto de cada sesión.
 */
export function HumanInput({ now, connected, onBack }: { now: number; connected: boolean; onBack(): void }) {
  const status = useApprover((s) => s.status);
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);
  const focusItem = useUi((s) => s.focusItem);
  const select = useUi((s) => s.select);
  const native = useNative();
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef<Record<string, HTMLElement | null>>({});

  const snapshots: Record<string, (typeof sessions)[string]['snapshot']> = {};
  for (const id of order) snapshots[id] = sessions[id]?.snapshot ?? null;
  const items = collectPending(order, snapshots);
  const ready = status.kind === 'ready';

  // Al abrir: la tarjeta pedida (desde el chat) o el título. Nunca un botón de aprobar.
  useEffect(() => {
    const target = focusItem ? cards.current[focusItem] : null;
    if (target) {
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
    } else {
      heading.current?.focus();
    }
  }, [focusItem]);

  const outcomes: Outcome[] = order
    .flatMap((id) => sessions[id]?.outcomes ?? [])
    .sort((a, b) => b.at - a.at)
    .slice(0, 10);

  const openSession = (sessionId: string) => {
    select(sessionId);
    void native.focusSession(sessionId).catch(() => undefined);
  };

  return (
    <section className="human-input" aria-label="Approval Center">
      <div className="hi-head">
        <button type="button" className="btn ghost back" onClick={onBack} aria-label="Back to sessions">
          ← Sessions
        </button>
        <h2 ref={heading} tabIndex={-1}>
          Approval Center
        </h2>
      </div>
      <AuthorityBar status={status} now={now} />

      <div className="hi-scroll">
        {SECTIONS.map((section) => {
          const list = items.filter((i) => i.kind === section.kind);
          return (
            <section key={section.kind} className="hi-section" aria-labelledby={`hi-${section.kind}s`}>
              <h3 id={`hi-${section.kind}s`}>
                {section.title} <span className="count">{list.length}</span>
              </h3>
              {list.length === 0 ? <p className="muted small">{section.empty}</p> : null}
              {list.map((item) => (
                <InteractionCard
                  key={`${item.sessionId}:${item.id}`}
                  ref={(el) => {
                    cards.current[item.id] = el;
                  }}
                  item={item}
                  snapshot={snapshots[item.sessionId] ?? null}
                  now={now}
                  connected={connected}
                  ready={ready}
                />
              ))}
            </section>
          );
        })}

        {outcomes.length > 0 ? (
          <section className="hi-section" aria-labelledby="hi-resolved">
            <h3 id="hi-resolved">Recently resolved</h3>
            <ul className="outcomes">
              {outcomes.map((o) => {
                const snapshot = snapshots[o.sessionId];
                // Solo si es **ese** run el que sigue en pausa: aprobar no lo reanudó.
                const stillPaused =
                  o.status === 'approved' &&
                  o.runId !== null &&
                  snapshot?.run?.id === o.runId &&
                  snapshot.run.status === 'paused';
                return (
                  <li key={`${o.sessionId}:${o.id}`} data-outcome={o.status}>
                    <strong>{OUTCOME_LABEL[o.status] ?? o.status}</strong>{' '}
                    <span className="muted">{resolverLabel(o.resolvedBy, o.status)}</span>
                    {o.label ? <span className="muted"> — {preview(o.label, 120)}</span> : null}
                    {stillPaused ? (
                      <p className="note" role="note">
                        Approved. The run remains paused: resume it to continue.{' '}
                        <button type="button" className="btn small" onClick={() => openSession(o.sessionId)}>
                          Open session
                        </button>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}

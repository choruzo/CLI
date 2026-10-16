import { forwardRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useResolve } from '../app/resolve';
import type { ProtocolApproval, ProtocolPlanRequest, ProtocolQuestionRequest, ProtocolSessionSnapshot } from '../protocol';
import {
  approvalChoices,
  draftToAnswers,
  expiryLabel,
  unresolvableReason,
  type DraftAnswer,
  type HumanInputItem,
} from '../protocol/interactions';
import { hostLabel, preview } from '../protocol/view';
import { activeResolution, useUi } from '../stores/uiStore';

interface Props {
  item: HumanInputItem;
  /** La foto de su sesión: de ahí sale el contexto (y si su anfitrión está). */
  snapshot: ProtocolSessionSnapshot | null;
  now: number;
  /** Hay conexión con el daemon. */
  connected: boolean;
  /** El broker está desbloqueado. */
  ready: boolean;
}

const TITLE: Record<HumanInputItem['kind'], string> = {
  approval: 'Approval required',
  question: 'The agent is asking',
  plan: 'Plan proposed',
};

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Enter en un campo de la tarjeta nunca aprueba ni envía nada. */
function noSubmit(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.preventDefault();
}

/**
 * **La** tarjeta de una solicitud: aprobación, preguntas o plan. Es la única
 * que resuelve; el chat solo lleva hasta ella.
 *
 * - El foco inicial nunca está en un botón de aprobar (lo pone el centro en la
 *   tarjeta, y Enter en un campo no envía).
 * - Denegar / rechazar va primero; aprobar, al final y separado.
 * - Sin optimismo: tras aprobar se ve «Sent…» hasta que la foto la retira.
 * - Aprobar, «para la sesión», enviar respuestas y aprobar el plan abren la
 *   confirmación nativa (otra ventana, M9); aquí solo se pide. La frase de una
 *   confirmación con nombre se teclea allí.
 */
export const InteractionCard = forwardRef<HTMLElement, Props>(function InteractionCard(
  { item, snapshot, now, connected, ready },
  ref,
) {
  const actions = useResolve(item);
  const stored = useUi((s) => s.resolutions[`${item.sessionId}:${item.id}`]);
  const resolution = activeResolution(stored, true, now);
  const busy = resolution !== null && resolution.state !== 'failed';
  const blocked = !connected
    ? 'Not connected to the Stratum daemon.'
    : (unresolvableReason(item, snapshot) ?? (ready ? null : 'Unlock approvals to resolve this from Dot.'));
  const off = blocked !== null || busy;
  const paused = snapshot?.run?.status === 'paused';
  const danger = item.kind === 'approval' && (item.approval.forced || item.approval.confirmPhrase !== undefined);
  const expiry = expiryLabel(item, now);
  const session = snapshot?.session;
  const titleId = `hi-${item.id}`;

  let body: ReactNode;
  if (item.kind === 'approval') {
    body = <ApprovalBody approval={item.approval} off={off} actions={actions} />;
  } else if (item.kind === 'question') {
    body = <QuestionBody request={item.request} off={off} actions={actions} />;
  } else {
    body = <PlanBody request={item.request} off={off} actions={actions} />;
  }

  return (
    <article
      ref={ref}
      className={`card interaction ${danger ? 'danger' : ''}`}
      aria-labelledby={titleId}
      data-kind={item.kind}
      data-item={item.id}
      data-session={item.sessionId}
      tabIndex={-1}
    >
      <header className="card-head">
        <h4 id={titleId}>{TITLE[item.kind]}</h4>
        {item.kind === 'approval' && item.approval.forced ? (
          <span className="tag warn">Required by policy · approve one at a time</span>
        ) : null}
        {item.kind === 'approval' && item.approval.confirmPhrase !== undefined ? (
          <span className="tag warn">Needs its confirmation phrase</span>
        ) : null}
      </header>

      <dl className="facts">
        <dt>Session</dt>
        <dd>
          {session ? (
            <>
              {preview(session.title || session.agent, 60)}
              <span className="muted">
                {' '}
                · {session.agent} · {session.model} · {hostLabel(snapshot!)}
              </span>
            </>
          ) : (
            <span className="mono">{item.sessionId}</span>
          )}
        </dd>
        {session ? (
          <>
            <dt>Directory</dt>
            <dd className="mono" title={session.cwd}>
              {session.cwd}
            </dd>
          </>
        ) : null}
        <dt>Run</dt>
        <dd className="mono">{item.kind === 'approval' ? item.approval.runId : item.request.runId}</dd>
        <dt>Requested</dt>
        <dd>
          {clock(item.requestedAt)}
          {expiry ? <span className="muted"> · {expiry}</span> : null}
        </dd>
      </dl>

      {body}

      {paused ? (
        <p className="note" role="note">
          The run is paused. Resolving this does not resume it.
        </p>
      ) : null}
      {blocked ? (
        <p className="muted small" data-blocked>
          {blocked}
        </p>
      ) : null}
      {resolution ? (
        <p className={`note ${resolution.state === 'failed' ? 'bad' : ''}`} role={resolution.state === 'failed' ? 'alert' : 'status'}>
          {resolution.state === 'confirming'
            ? `${resolution.action}: confirm it in the Stratum Dot confirmation window…`
            : resolution.state === 'sending'
            ? `${resolution.action}: sending…`
            : resolution.state === 'sent'
              ? `${resolution.action}: sent. Waiting for the session to confirm…`
              : resolution.message}
        </p>
      ) : null}
    </article>
  );
});

function ApprovalBody({
  approval,
  off,
  actions,
}: {
  approval: ProtocolApproval;
  off: boolean;
  actions: ReturnType<typeof useResolve>;
}) {
  const choices = approvalChoices(approval);
  const approve = (forSession: boolean) => void actions.approve({ forSession });

  return (
    <>
      <dl className="facts">
        <dt>Tool</dt>
        <dd className="mono">{approval.tool}</dd>
        <dt>Action</dt>
        <dd>
          <pre className="action">{approval.description}</pre>
        </dd>
        {approval.target ? (
          <>
            <dt>Target</dt>
            <dd className="mono">{approval.target}</dd>
          </>
        ) : null}
        {approval.environment ? (
          <>
            <dt>Environment</dt>
            <dd>
              {approval.environment.name} <span className="muted">({approval.environment.tier})</span>
            </dd>
          </>
        ) : null}
        {approval.reason ? (
          <>
            <dt>Reason</dt>
            <dd>{approval.reason}</dd>
          </>
        ) : null}
      </dl>

      {choices.phrase !== null ? (
        <p className="phrase" data-phrase>
          To approve, you will type <code className="mono">{choices.phrase}</code> in the confirmation window.
        </p>
      ) : null}

      <div className="decision" role="group" aria-label="Decision">
        <button type="button" className="btn" disabled={off} onClick={() => void actions.deny()}>
          Deny
        </button>
        <span className="spacer" />
        {choices.allowSession ? (
          <button
            type="button"
            className="btn"
            disabled={off}
            aria-describedby={`allow-${approval.id}`}
            onClick={() => approve(true)}
          >
            Allow for this session
          </button>
        ) : null}
        <button type="button" className="btn primary" disabled={off} onClick={() => approve(false)}>
          Approve
        </button>
      </div>
      <p className="muted small">Approving opens a confirmation window. Deny is sent right away.</p>
      {choices.allowSession ? (
        <p id={`allow-${approval.id}`} className="muted small">
          “Allow for this session” approves this and later requests of this session only. It does not change any
          configuration, and requests required by policy keep asking.
        </p>
      ) : null}
    </>
  );
}

function QuestionBody({
  request,
  off,
  actions,
}: {
  request: ProtocolQuestionRequest;
  off: boolean;
  actions: ReturnType<typeof useResolve>;
}) {
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => request.questions.map(() => null));
  const checked = draftToAnswers(request, drafts);
  const set = (i: number, value: DraftAnswer) => setDrafts((prev) => prev.map((d, j) => (j === i ? value : d)));

  return (
    <>
      {request.questions.map((q, i) => {
        const draft = drafts[i] ?? null;
        const options = q.options ?? [];
        const custom = options.length === 0 || q.allowCustom === true;
        const group = `q-${request.id}-${i}`;
        const typing = draft !== null && 'text' in draft;
        return (
          <fieldset key={group} className="question" disabled={off}>
            <legend>{q.question}</legend>
            {options.map((o) => (
              <label key={o.id} className="option">
                <input
                  type="radio"
                  name={group}
                  checked={draft !== null && 'optionId' in draft && draft.optionId === o.id}
                  onChange={() => set(i, { optionId: o.id })}
                />
                {o.label}
              </label>
            ))}
            {custom && options.length > 0 ? (
              <label className="option">
                <input type="radio" name={group} checked={typing} onChange={() => set(i, { text: '' })} />
                Other answer
              </label>
            ) : null}
            {custom ? (
              <input
                type="text"
                className="answer"
                aria-label={options.length > 0 ? `Other answer to: ${q.question}` : `Answer to: ${q.question}`}
                autoComplete="off"
                value={typing ? (draft as { text: string }).text : ''}
                disabled={off || (options.length > 0 && !typing)}
                onChange={(e) => set(i, { text: e.target.value })}
                onKeyDown={noSubmit}
              />
            ) : null}
          </fieldset>
        );
      })}
      <div className="decision" role="group" aria-label="Decision">
        <button type="button" className="btn" disabled={off} onClick={() => void actions.answer(null)}>
          Skip questions
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn primary"
          disabled={off || !checked.ok}
          onClick={() => {
            if (checked.ok) void actions.answer(checked.answers);
          }}
        >
          Send answers
        </button>
      </div>
      <p className="muted small">Skipping lets the agent continue with its own assumptions.</p>
    </>
  );
}

function PlanBody({
  request,
  off,
  actions,
}: {
  request: ProtocolPlanRequest;
  off: boolean;
  actions: ReturnType<typeof useResolve>;
}) {
  const { plan } = request;
  return (
    <>
      <p className="plan-summary">{plan.summary}</p>
      <ol className="plan-steps">
        {plan.steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span>{step.title}</span>
            {step.detail ? <span className="muted small"> — {preview(step.detail, 240)}</span> : null}
          </li>
        ))}
      </ol>
      <div className="decision" role="group" aria-label="Decision">
        <button type="button" className="btn" disabled={off} onClick={() => void actions.decide('reject')}>
          Reject plan
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={off} onClick={() => void actions.decide('approve')}>
          Approve plan
        </button>
      </div>
    </>
  );
}

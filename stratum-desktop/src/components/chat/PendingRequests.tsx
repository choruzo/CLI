import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { approvalsStore, resolutionKey, resolver, type Resolution, type Resolver } from '../../client/approvals';
import { useStore } from '../../client/store';
import type { NativeBridge } from '../../ipc/native';
import type { ProtocolApproval, ProtocolPlanRequest, ProtocolQuestionRequest, ProtocolSessionSnapshot } from '../../protocol';
import {
  approvalChoices,
  approverLabel,
  blockedReason,
  draftToAnswers,
  expiryLabel,
  type DraftAnswer,
  type HumanInputItem,
} from '../../view/interactions';

const TITLE: Record<HumanInputItem['kind'], string> = {
  approval: 'Necesita tu aprobación',
  question: 'El asistente pregunta',
  plan: 'Plan propuesto',
};

/** Cada segundo: lo que se enseña de caducidad y del desbloqueo. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Enter en un campo de la tarjeta nunca aprueba ni envía nada. */
function noSubmit(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.preventDefault();
}

interface Props {
  items: HumanInputItem[];
  snapshot: ProtocolSessionSnapshot | null;
  connected: boolean;
  native: NativeBridge;
}

/**
 * Lo que la sesión que se mira espera de una persona, con lo que hace falta
 * para resolverlo desde Desktop. Las reglas son las de Stratum Dot: aquí solo
 * se **pide**; aprobar, «en esta sesión», enviar respuestas y aprobar un plan
 * se confirman en una ventana nativa, y la clave de aprobador se teclea en
 * otra (este webview no ve ninguna de las dos).
 */
export function PendingRequests({ items, snapshot, connected, native }: Props) {
  const { status, resolutions } = useStore(approvalsStore, (s) => s);
  const now = useNow(items.length > 0);
  const [lockError, setLockError] = useState<string | null>(null);
  if (items.length === 0) return null;

  const ready = status.kind === 'ready';
  const canUnlock = connected && (status.kind === 'locked' || status.kind === 'error');
  const unlock = () => {
    setLockError(null);
    void native.unlockApprovals().catch(() => setLockError('No se pudo abrir la ventana de desbloqueo.'));
  };

  return (
    <section className="pending-requests" aria-label="Pendiente de ti">
      <div className="pending-requests__authority" data-state={status.kind}>
        <span>{approverLabel(status, now)}</span>
        {canUnlock && (
          <button type="button" className="button" onClick={unlock}>
            Desbloquear
          </button>
        )}
        {ready && (
          <button type="button" className="button" onClick={() => void native.lockApprovals().catch(() => undefined)}>
            Bloquear
          </button>
        )}
      </div>
      {lockError && (
        <p className="notice" data-tone="error" role="alert">
          {lockError}
        </p>
      )}
      {items.map((item) => (
        <PendingCard
          key={resolutionKey(item)}
          item={item}
          snapshot={snapshot}
          now={now}
          blocked={blockedReason(item, snapshot, connected, status)}
          resolution={resolutions[resolutionKey(item)] ?? null}
          actions={resolver(native, item)}
        />
      ))}
    </section>
  );
}

interface CardProps {
  item: HumanInputItem;
  snapshot: ProtocolSessionSnapshot | null;
  now: number;
  blocked: string | null;
  resolution: Resolution | null;
  actions: Resolver;
}

/**
 * **La** tarjeta de una solicitud. El foco nunca empieza en aprobar; denegar
 * va primero y aprobar al final; sin optimismo: tras pedirlo se ve «enviado…»
 * hasta que la foto la retira.
 */
function PendingCard({ item, snapshot, now, blocked, resolution, actions }: CardProps) {
  const busy = resolution !== null && resolution.state !== 'failed';
  const off = blocked !== null || busy;
  const danger = item.kind === 'approval' && (item.approval.forced || item.approval.confirmPhrase !== undefined);
  const expiry = expiryLabel(item, now);
  const paused = snapshot?.run?.status === 'paused';

  let body: ReactNode;
  if (item.kind === 'approval') body = <ApprovalBody approval={item.approval} off={off} actions={actions} />;
  else if (item.kind === 'question') body = <QuestionBody request={item.request} off={off} actions={actions} />;
  else body = <PlanBody request={item.request} off={off} actions={actions} />;

  return (
    <article
      className="pending-card"
      data-kind={item.kind}
      data-danger={danger || undefined}
      data-item={item.id}
      aria-label={TITLE[item.kind]}
    >
      <header className="pending-card__head">
        <strong>{TITLE[item.kind]}</strong>
        {item.kind === 'approval' && item.approval.forced && (
          <span className="pending-card__tag">Lo exige una política · de una en una</span>
        )}
        {item.kind === 'approval' && item.approval.confirmPhrase !== undefined && (
          <span className="pending-card__tag">Pide su frase de confirmación</span>
        )}
        {expiry && <span className="pending-card__muted">{expiry}</span>}
      </header>
      {body}
      {paused && <p className="pending-card__muted">El run está en pausa. Resolver esto no lo reanuda.</p>}
      {blocked && (
        <p className="pending-card__muted" data-blocked>
          {blocked}
        </p>
      )}
      {resolution && (
        <p
          className="notice"
          data-tone={resolution.state === 'failed' ? 'error' : 'info'}
          role={resolution.state === 'failed' ? 'alert' : 'status'}
        >
          {resolution.state === 'confirming'
            ? `${resolution.action}: confírmalo en la ventana de confirmación…`
            : resolution.state === 'sending'
              ? `${resolution.action}: enviando…`
              : resolution.state === 'failed'
                ? resolution.message
                : `${resolution.action}: enviado. Esperando a que la sesión lo confirme…`}
        </p>
      )}
    </article>
  );
}

function ApprovalBody({ approval, off, actions }: { approval: ProtocolApproval; off: boolean; actions: Resolver }) {
  const choices = approvalChoices(approval);
  return (
    <>
      <dl className="pending-card__facts">
        <dt>Herramienta</dt>
        <dd className="mono">{approval.tool}</dd>
        <dt>Qué hace</dt>
        <dd>
          <pre className="pending-card__action">{approval.description}</pre>
        </dd>
        {approval.target && (
          <>
            <dt>Destino</dt>
            <dd className="mono">{approval.target}</dd>
          </>
        )}
        {approval.environment && (
          <>
            <dt>Entorno</dt>
            <dd>
              {approval.environment.name} <span className="pending-card__muted">({approval.environment.tier})</span>
            </dd>
          </>
        )}
        {approval.reason && (
          <>
            <dt>Motivo</dt>
            <dd>{approval.reason}</dd>
          </>
        )}
      </dl>
      {choices.phrase !== null && (
        <p className="pending-card__muted" data-phrase>
          Para aprobar escribirás <code>{choices.phrase}</code> en la ventana de confirmación.
        </p>
      )}
      <div className="pending-card__decision" role="group" aria-label="Decisión">
        <button type="button" className="button" disabled={off} onClick={() => void actions.deny()}>
          Denegar
        </button>
        <span className="pending-card__spacer" />
        {choices.allowSession && (
          <button type="button" className="button" disabled={off} onClick={() => void actions.approve(true)}>
            Permitir en esta sesión
          </button>
        )}
        <button type="button" className="button button--primary" disabled={off} onClick={() => void actions.approve(false)}>
          Aprobar
        </button>
      </div>
      <p className="pending-card__muted">
        Aprobar abre una ventana de confirmación; denegar se envía al momento.
        {choices.allowSession &&
          ' «Permitir en esta sesión» aprueba esta y las siguientes solicitudes de esta sesión, y solo de ella; lo que exige una política sigue preguntándose.'}
      </p>
    </>
  );
}

function QuestionBody({ request, off, actions }: { request: ProtocolQuestionRequest; off: boolean; actions: Resolver }) {
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
          <fieldset key={group} className="pending-card__question" disabled={off}>
            <legend>{q.question}</legend>
            {options.map((o) => (
              <label key={o.id} className="pending-card__option">
                <input
                  type="radio"
                  name={group}
                  checked={draft !== null && 'optionId' in draft && draft.optionId === o.id}
                  onChange={() => set(i, { optionId: o.id })}
                />
                {o.label}
              </label>
            ))}
            {custom && options.length > 0 && (
              <label className="pending-card__option">
                <input type="radio" name={group} checked={typing} onChange={() => set(i, { text: '' })} />
                Otra respuesta
              </label>
            )}
            {custom && (
              <input
                type="text"
                className="pending-card__answer"
                aria-label={options.length > 0 ? `Otra respuesta a: ${q.question}` : `Respuesta a: ${q.question}`}
                autoComplete="off"
                value={typing ? (draft as { text: string }).text : ''}
                disabled={off || (options.length > 0 && !typing)}
                onChange={(e) => set(i, { text: e.target.value })}
                onKeyDown={noSubmit}
              />
            )}
          </fieldset>
        );
      })}
      <div className="pending-card__decision" role="group" aria-label="Decisión">
        <button type="button" className="button" disabled={off} onClick={() => void actions.answer(null)}>
          Omitir las preguntas
        </button>
        <span className="pending-card__spacer" />
        <button
          type="button"
          className="button button--primary"
          disabled={off || !checked.ok}
          onClick={() => {
            if (checked.ok) void actions.answer(checked.answers);
          }}
        >
          Enviar respuestas
        </button>
      </div>
      <p className="pending-card__muted">Si las omites, el asistente sigue con sus propios supuestos.</p>
    </>
  );
}

function PlanBody({ request, off, actions }: { request: ProtocolPlanRequest; off: boolean; actions: Resolver }) {
  const { plan } = request;
  return (
    <>
      <p className="pending-card__summary">{plan.summary}</p>
      <ol className="pending-card__steps">
        {plan.steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            {step.title}
            {step.detail && <span className="pending-card__muted"> — {step.detail}</span>}
          </li>
        ))}
      </ol>
      <div className="pending-card__decision" role="group" aria-label="Decisión">
        <button type="button" className="button" disabled={off} onClick={() => void actions.decide('reject')}>
          Rechazar el plan
        </button>
        <span className="pending-card__spacer" />
        <button
          type="button"
          className="button button--primary"
          disabled={off}
          onClick={() => void actions.decide('approve')}
        >
          Aprobar el plan
        </button>
      </div>
    </>
  );
}

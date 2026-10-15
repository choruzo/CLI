/**
 * Lo que las sesiones esperan de una persona —aprobaciones, preguntas, planes—,
 * leído de sus fotos. Funciones puras: no guardan una lista propia de lo
 * pendiente (la verdad es la foto de cada sesión) y no deciden qué respuesta
 * vale (eso lo dicen las reglas del contrato, `protocol/resolve.ts`).
 */
import {
  checkApprovalResolution,
  checkQuestionAnswers,
  type ProtocolApproval,
  type ProtocolPlanRequest,
  type ProtocolQuestionAnswer,
  type ProtocolQuestionRequest,
  type ProtocolResolver,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
} from './index';
import { formatDuration, isDetached } from './view';

export type InteractionKind = 'approval' | 'question' | 'plan';

export type HumanInputItem =
  | { kind: 'approval'; id: string; sessionId: string; requestedAt: number; approval: ProtocolApproval }
  | { kind: 'question'; id: string; sessionId: string; requestedAt: number; request: ProtocolQuestionRequest }
  | { kind: 'plan'; id: string; sessionId: string; requestedAt: number; request: ProtocolPlanRequest };

const KIND_ORDER: Record<InteractionKind, number> = { approval: 0, question: 1, plan: 2 };

/**
 * Lo pendiente de todas las sesiones vivas. Orden determinista: lo más antiguo
 * primero (lleva más esperando), y a igualdad, por tipo y por id.
 */
export function collectPending(
  order: readonly string[],
  snapshots: Readonly<Record<string, ProtocolSessionSnapshot | null | undefined>>,
): HumanInputItem[] {
  const items: HumanInputItem[] = [];
  for (const sessionId of order) {
    const snapshot = snapshots[sessionId];
    if (!snapshot) continue;
    // Solo lo de esa sesión: un DTO con otra sesión no se le atribuye.
    for (const approval of snapshot.approvals) {
      if (approval.sessionId !== sessionId) continue;
      items.push({ kind: 'approval', id: approval.id, sessionId, requestedAt: approval.requestedAt, approval });
    }
    for (const request of snapshot.questions) {
      if (request.sessionId !== sessionId) continue;
      items.push({ kind: 'question', id: request.id, sessionId, requestedAt: request.requestedAt, request });
    }
    for (const request of snapshot.plans) {
      if (request.sessionId !== sessionId) continue;
      items.push({ kind: 'plan', id: request.id, sessionId, requestedAt: request.requestedAt, request });
    }
  }
  return items.sort(
    (a, b) =>
      a.requestedAt - b.requestedAt ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Qué se puede hacer con una aprobación, según las reglas del contrato. */
export interface ApprovalChoices {
  /** `allow-all`: no vale si es forzada ni si pide frase. */
  allowSession: boolean;
  /** Para aprobar hay que teclear esta frase (no es la clave de aprobador). */
  phrase: string | null;
}

export function approvalChoices(approval: ProtocolApproval): ApprovalChoices {
  return {
    allowSession: checkApprovalResolution(approval, 'allow-all', undefined) === null,
    phrase: approval.confirmPhrase ?? null,
  };
}

/** ¿Vale aprobar con lo tecleado? La frase, exacta: sin recortar ni aproximar. */
export function canApproveWith(approval: ProtocolApproval, phrase: string): boolean {
  return checkApprovalResolution(approval, 'approve', approval.confirmPhrase === undefined ? undefined : phrase) === null;
}

/**
 * Lo que la persona eligió para cada pregunta: una opción, o un texto propio.
 * Se canoniza con la regla del contrato antes de enviarlo.
 */
export type DraftAnswer = { optionId: string } | { text: string } | null;

export function draftToAnswers(
  request: ProtocolQuestionRequest,
  drafts: readonly DraftAnswer[],
): { ok: true; answers: ProtocolQuestionAnswer[] } | { ok: false; message: string } {
  const raw: ProtocolQuestionAnswer[] = request.questions.map((q, i) => {
    const draft = drafts[i] ?? null;
    if (draft && 'optionId' in draft) {
      const label = q.options?.find((o) => o.id === draft.optionId)?.label ?? '';
      return { question: q.question, answer: label, optionId: draft.optionId };
    }
    return { question: q.question, answer: draft && 'text' in draft ? draft.text : '' };
  });
  const checked = checkQuestionAnswers(request.questions, raw);
  if (!checked.ok) return { ok: false, message: checked.issue.message };
  return { ok: true, answers: checked.answers ?? [] };
}

/**
 * «Expires in 4m 12s (then denied)». `expiresAt` lo pone el anfitrión: aquí
 * solo se enseña; ninguna decisión depende del reloj local.
 */
export function expiryLabel(item: HumanInputItem, now: number): string | null {
  const expiresAt = item.kind === 'approval' ? item.approval.expiresAt : item.request.expiresAt;
  if (expiresAt === null) return null;
  const then = item.kind === 'approval' ? 'denied' : item.kind === 'question' ? 'skipped' : 'rejected';
  const left = expiresAt - now;
  if (left <= 0) return `Expiring (then ${then})`;
  return `Expires in ${formatDuration(left)} (then ${then})`;
}

/** Por qué no se puede resolver desde aquí ahora, o `null`. */
export function unresolvableReason(item: HumanInputItem, snapshot: ProtocolSessionSnapshot | null): string | null {
  if (!snapshot) return 'The session is not available.';
  if (isDetached(snapshot) || (item.kind === 'approval' && item.approval.resolvable === 'origin')) {
    return "The session's host is not connected: this can only be resolved in its terminal.";
  }
  return null;
}

/** Cómo acabó algo que estuvo pendiente. Sale de su evento `*.resolved`. */
export interface Outcome {
  kind: InteractionKind;
  id: string;
  sessionId: string;
  /** El run de la solicitud (del evento), o `null` si no se sabe. */
  runId: string | null;
  /** `approved` · `denied` · `expired` · `cancelled` · `answered` · `skipped` · `plan-approved` · `plan-rejected`. */
  status: string;
  resolvedBy: ProtocolResolver | null;
  at: number;
  /** Qué era (de la foto de antes del evento), para poder decirlo cuando ya no está. */
  label: string;
}

export const OUTCOMES_LIMIT = 20;

function labelOf(item: HumanInputItem | undefined): string {
  if (!item) return '';
  if (item.kind === 'approval') return `${item.approval.tool}: ${item.approval.description}`;
  if (item.kind === 'question') return item.request.questions[0]?.question ?? 'Questions';
  return item.request.plan.summary;
}

/**
 * Los desenlaces de un lote de eventos ya aplicado. `before` es la foto de
 * antes del lote: de ahí sale qué era cada solicitud.
 */
export function outcomesOf(before: ProtocolSessionSnapshot, applied: readonly ProtocolStateEvent[]): Outcome[] {
  const known = new Map<string, HumanInputItem>();
  for (const item of collectPending([before.session.id], { [before.session.id]: before })) known.set(item.id, item);
  const out: Outcome[] = [];
  for (const event of applied) {
    const base = { sessionId: event.sessionId, at: event.at, runId: event.runId ?? null };
    switch (event.type) {
      case 'approval.requested':
        known.set(event.data.approval.id, {
          kind: 'approval',
          id: event.data.approval.id,
          sessionId: event.sessionId,
          requestedAt: event.data.approval.requestedAt,
          approval: event.data.approval,
        });
        break;
      case 'question.requested':
        known.set(event.data.request.id, {
          kind: 'question',
          id: event.data.request.id,
          sessionId: event.sessionId,
          requestedAt: event.data.request.requestedAt,
          request: event.data.request,
        });
        break;
      case 'plan.proposed':
        known.set(event.data.request.id, {
          kind: 'plan',
          id: event.data.request.id,
          sessionId: event.sessionId,
          requestedAt: event.data.request.requestedAt,
          request: event.data.request,
        });
        break;
      case 'approval.resolved':
        out.push({
          ...base,
          kind: 'approval',
          id: event.data.approvalId,
          status: event.data.status,
          resolvedBy: event.data.resolvedBy ?? null,
          label: labelOf(known.get(event.data.approvalId)),
        });
        break;
      case 'question.resolved': {
        const status = event.data.status ?? 'resolved';
        out.push({
          ...base,
          kind: 'question',
          id: event.data.requestId,
          status: status === 'resolved' ? (event.data.answers ? 'answered' : 'skipped') : status,
          resolvedBy: event.data.resolvedBy ?? null,
          label: labelOf(known.get(event.data.requestId)),
        });
        break;
      }
      case 'plan.resolved': {
        const status = event.data.status ?? 'resolved';
        out.push({
          ...base,
          kind: 'plan',
          id: event.data.requestId,
          status: status === 'resolved' ? (event.data.decision === 'approve' ? 'plan-approved' : 'plan-rejected') : status,
          resolvedBy: event.data.resolvedBy ?? null,
          label: labelOf(known.get(event.data.requestId)),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export const OUTCOME_LABEL: Record<string, string> = {
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
  answered: 'Answered',
  skipped: 'Skipped',
  'plan-approved': 'Plan approved',
  'plan-rejected': 'Plan rejected',
  resolved: 'Resolved',
};

/** Quién lo resolvió, como lo cuenta el anfitrión. `client` es lo que el cliente declaró. */
export function resolverLabel(resolvedBy: ProtocolResolver | null, status: string): string {
  if (status === 'cancelled') return 'the run was cancelled or the session closed';
  if (!resolvedBy) return status === 'expired' ? 'nobody answered in time' : 'elsewhere';
  switch (resolvedBy.kind) {
    case 'local':
      return 'in its terminal';
    case 'remote':
      return resolvedBy.client === 'dot' ? 'from Stratum Dot' : `remotely (${resolvedBy.client ?? 'client'})`;
    case 'timeout':
      return 'nobody answered in time';
    case 'policy':
      return 'by policy, without asking';
  }
}

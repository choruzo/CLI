/**
 * Lo que una sesión espera de una persona —aprobaciones, preguntas, planes—,
 * leído de su foto. Funciones puras: no guardan una lista propia de lo
 * pendiente (la verdad es la foto) y no deciden qué respuesta vale (eso lo
 * dicen las reglas del contrato, `checkApprovalResolution` y
 * `checkQuestionAnswers`). Es lo mismo que `stratum-dot/src/protocol/interactions.ts`,
 * con los textos de Desktop.
 */
import type { ApproverStatus, CommandError } from '../ipc/native';
import {
  checkApprovalResolution,
  checkQuestionAnswers,
  type ProtocolApproval,
  type ProtocolPlanRequest,
  type ProtocolQuestionAnswer,
  type ProtocolQuestionRequest,
  type ProtocolSessionSnapshot,
} from '../protocol';

export type InteractionKind = 'approval' | 'question' | 'plan';

export type HumanInputItem =
  | { kind: 'approval'; id: string; sessionId: string; requestedAt: number; approval: ProtocolApproval }
  | { kind: 'question'; id: string; sessionId: string; requestedAt: number; request: ProtocolQuestionRequest }
  | { kind: 'plan'; id: string; sessionId: string; requestedAt: number; request: ProtocolPlanRequest };

const KIND_ORDER: Record<InteractionKind, number> = { approval: 0, question: 1, plan: 2 };

/**
 * Lo pendiente de una sesión, de su foto. Orden determinista: lo más antiguo
 * primero, y a igualdad, por tipo y por id. Un DTO de otra sesión no se le atribuye.
 */
export function pendingOf(snapshot: ProtocolSessionSnapshot | null): HumanInputItem[] {
  if (!snapshot) return [];
  const sessionId = snapshot.session.id;
  const items: HumanInputItem[] = [];
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
  /** Para aprobar hay que teclear esta frase (en la ventana de confirmación). */
  phrase: string | null;
}

export function approvalChoices(approval: ProtocolApproval): ApprovalChoices {
  return {
    allowSession: checkApprovalResolution(approval, 'allow-all', undefined) === null,
    phrase: approval.confirmPhrase ?? null,
  };
}

/** Lo que la persona eligió para cada pregunta: una opción, o un texto propio. */
export type DraftAnswer = { optionId: string } | { text: string } | null;

/** Se canoniza con la regla del contrato antes de enviarlo. */
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

/** `42 s`, `4 min 12 s`, `1 h 03 min`. */
function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * «Caduca en 4 min 12 s (entonces se deniega)». `expiresAt` lo pone el
 * anfitrión: aquí solo se enseña; ninguna decisión depende del reloj local.
 */
export function expiryLabel(item: HumanInputItem, now: number): string | null {
  const expiresAt = item.kind === 'approval' ? item.approval.expiresAt : item.request.expiresAt;
  if (expiresAt === null) return null;
  const then = item.kind === 'approval' ? 'se deniega' : item.kind === 'question' ? 'se omiten' : 'se rechaza';
  const left = expiresAt - now;
  if (left <= 0) return `Caducando (entonces ${then})`;
  return `Caduca en ${duration(left)} (entonces ${then})`;
}

/** Por qué no se puede resolver desde Desktop ahora, o `null`. */
export function blockedReason(
  item: HumanInputItem,
  snapshot: ProtocolSessionSnapshot | null,
  connected: boolean,
  status: ApproverStatus,
): string | null {
  if (!connected) return 'Sin conexión con el daemon de Stratum.';
  if (!snapshot) return 'La sesión no está disponible.';
  const detached = snapshot.session.state === 'detached' || !snapshot.session.host.connected;
  if (detached || (item.kind === 'approval' && item.approval.resolvable === 'origin')) {
    return 'El anfitrión de la sesión no está conectado: solo se puede resolver en su terminal.';
  }
  if (status.kind !== 'ready') return 'Desbloquea las aprobaciones para resolverlo desde Desktop.';
  return null;
}

/** Texto del estado de la autoridad de aprobar. */
export function approverLabel(status: ApproverStatus, now: number): string {
  switch (status.kind) {
    case 'ready': {
      const left = Math.max(1, Math.ceil((status.expiresAt - now) / 60_000));
      return `Aprobaciones desbloqueadas · ${left} min`;
    }
    case 'unlocking':
      return 'Comprobando la clave…';
    case 'unavailable':
      return status.reason === 'no-approver-key'
        ? 'El daemon no acepta aprobadores: fija una clave con stratum approvals set-key.'
        : 'Sin conexión con el daemon de Stratum.';
    case 'error':
      return 'No se pudo desbloquear. Inténtalo otra vez.';
    case 'locked':
      switch (status.reason) {
        case 'expired':
          return 'Aprobaciones bloqueadas: venció el plazo.';
        case 'connection-lost':
          return 'Aprobaciones bloqueadas: se perdió la conexión de aprobador.';
        case 'daemon-changed':
          return 'Aprobaciones bloqueadas: el daemon cambió.';
        default:
          return 'Aprobaciones bloqueadas.';
      }
  }
}

/**
 * Los motivos de `dot_link` (en inglés, compartidos con Dot) que se conocen,
 * en palabras de Desktop. Uno nuevo se enseña tal cual.
 */
const NOT_SENT: Record<string, string> = {
  'Wait a moment before asking for another confirmation.':
    'Espera un momento antes de pedir otra confirmación. No se ha enviado nada.',
  'Another confirmation is open. Finish or cancel it first.':
    'Ya hay otra confirmación abierta: termínala o cancélala antes.',
  'Approval authority is locked. Unlock it to resolve requests from Dot.':
    'Las aprobaciones están bloqueadas. Desbloquéalas para resolver desde Desktop.',
  'Could not open the confirmation window. Nothing was sent.':
    'No se pudo abrir la ventana de confirmación. No se ha enviado nada.',
  'Could not read the request from the Stratum daemon. Nothing was sent.':
    'No se pudo leer la solicitud del daemon de Stratum. No se ha enviado nada.',
  'This request can only be resolved in its terminal.': 'Esta solicitud solo se puede resolver en su terminal.',
  'This request asks for a confirmation phrase Dot cannot send. Resolve it in its terminal.':
    'Esta solicitud pide una frase que no se puede enviar desde aquí. Resuélvela en su terminal.',
  'Not connected to the Stratum daemon.': 'Sin conexión con el daemon de Stratum.',
};

/** Por qué no salió (o no se sabe si salió) una resolución, en palabras de Desktop. */
export function describeResolutionError(error: CommandError, item: HumanInputItem): string {
  switch (error.kind) {
    case 'unknown':
      return 'Resultado desconocido: la conexión se cortó antes de que el daemon contestara. No se ha vuelto a enviar; Desktop enseñará cómo acabó cuando la sesión lo publique.';
    case 'not-confirmed':
      switch (error.reason) {
        case 'expired':
          return 'La confirmación caducó. No se ha enviado nada.';
        case 'locked':
          return 'Las aprobaciones se bloquearon antes de confirmar. No se ha enviado nada.';
        case 'daemon-changed':
          return 'El daemon cambió antes de confirmar. No se ha enviado nada.';
        case 'disconnected':
          return 'Se perdió la conexión con el daemon antes de confirmar. No se ha enviado nada.';
        case 'resolved-elsewhere':
          return 'Se resolvió en otro sitio antes de confirmar. No se ha enviado nada.';
        case 'session-gone':
          return 'La sesión terminó antes de confirmar. No se ha enviado nada.';
        case 'closing':
          return 'Desktop se está cerrando. No se ha enviado nada.';
        default:
          return 'No se confirmó. No se ha enviado nada.';
      }
    case 'not-sent':
    case 'invalid':
    case 'no-answer':
      return NOT_SENT[error.message] ?? `No se ha enviado: ${error.message}`;
    case 'rejected':
      break;
  }
  switch (error.code) {
    case 'ALREADY_RESOLVED':
      return 'Ya se resolvió en otro sitio (en su terminal, desde otro cliente o porque caducó).';
    case 'NOT_FOUND':
      return 'Esta solicitud ya no existe en esta sesión.';
    case 'INVALID_PARAMS':
      return item.kind === 'approval' && item.approval.confirmPhrase !== undefined
        ? 'La frase de confirmación no coincide. No se ha aprobado nada.'
        : `El daemon no aceptó esta respuesta. No se ha resuelto nada. (${error.message})`;
    case 'UNAVAILABLE':
      return error.reason === 'host-unavailable'
        ? 'El anfitrión de la sesión no está conectado: solo se puede resolver en su terminal.'
        : error.message;
    case 'FORBIDDEN':
      return 'Esta conexión no puede resolver solicitudes. Vuelve a desbloquear las aprobaciones.';
    default:
      return error.message;
  }
}

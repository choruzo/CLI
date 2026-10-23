/**
 * La foto de conjunto (`overview`) avanzada con los eventos de
 * `OVERVIEW_EVENT_TYPES` (M12). **Puro.** Es el **estado operativo** de todas
 * las sesiones —quién, dónde, en qué estado, qué espera a una persona— sin la
 * conversación de ninguna: con esto se pinta una lista de sesiones sin
 * descargar transcripts (`docs/STRATUM_CLIENT_ARCHITECTURE.md` §4).
 *
 * En una suscripción `overview` los saltos de `seq` son normales (solo llegan
 * algunos tipos), así que aquí no se exige continuidad: un evento de estado
 * que no aporta nada a esta vista se ignora, y la próxima foto de conjunto
 * sustituye lo que hubiera.
 */
import type { ProtocolEvent, ProtocolOverviewSnapshot } from './events.js';

export const EMPTY_OVERVIEW: ProtocolOverviewSnapshot = {
  sessions: [],
  approvals: [],
  questions: [],
  plans: [],
};

/** Aplica un evento a la foto de conjunto. La de entrada no se toca. */
export function applyOverviewEvent(
  overview: ProtocolOverviewSnapshot,
  event: ProtocolEvent,
): ProtocolOverviewSnapshot {
  const sid = event.sessionId;
  switch (event.type) {
    case 'session.opened':
    case 'session.updated': {
      const session = event.data.session;
      if (session.id !== sid) return overview;
      const known = overview.sessions.find((s) => s.id === sid);
      // Una sesión no retrocede: un evento más antiguo que lo que se tiene no gana.
      if (known && known.seq > session.seq) return overview;
      return {
        ...overview,
        sessions: known
          ? overview.sessions.map((s) => (s.id === sid ? session : s))
          : [...overview.sessions, session],
      };
    }
    case 'session.closed':
      return {
        sessions: overview.sessions.filter((s) => s.id !== sid),
        approvals: overview.approvals.filter((a) => a.sessionId !== sid),
        questions: overview.questions.filter((q) => q.sessionId !== sid),
        plans: overview.plans.filter((p) => p.sessionId !== sid),
      };
    case 'approval.requested':
      if (overview.approvals.some((a) => a.id === event.data.approval.id)) return overview;
      return { ...overview, approvals: [...overview.approvals, event.data.approval] };
    case 'approval.resolved':
      return {
        ...overview,
        approvals: overview.approvals.filter(
          (a) => !(a.id === event.data.approvalId && a.sessionId === sid),
        ),
      };
    case 'question.requested':
      if (overview.questions.some((q) => q.id === event.data.request.id)) return overview;
      return { ...overview, questions: [...overview.questions, event.data.request] };
    case 'question.resolved':
      return {
        ...overview,
        questions: overview.questions.filter(
          (q) => !(q.id === event.data.requestId && q.sessionId === sid),
        ),
      };
    case 'plan.proposed':
      if (overview.plans.some((p) => p.id === event.data.request.id)) return overview;
      return { ...overview, plans: [...overview.plans, event.data.request] };
    case 'plan.resolved':
      return {
        ...overview,
        plans: overview.plans.filter(
          (p) => !(p.id === event.data.requestId && p.sessionId === sid),
        ),
      };
    default:
      // `run.*`: el estado que se pinta en la lista viaja
      // en `session.updated` (`state`, `currentRunId`); el run, en su sesión.
      return overview;
  }
}

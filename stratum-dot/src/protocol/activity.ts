/**
 * Registro de actividad reciente: una línea por evento de estado que merece
 * verse. Es solo para leer —no es el estado de la sesión ni un visor de traza—
 * y se pierde sin consecuencias: tras una foto nueva se sigue desde ahí.
 */
import type { ProtocolStateEvent } from './index';
import { preview, type Tone } from './view';

export interface ActivityEntry {
  /** `seq` del evento; negativo en las marcas que pone Dot (no son eventos). */
  seq: number;
  at: number;
  type: string;
  label: string;
  detail?: string;
  tone: Tone;
}

export const ACTIVITY_LIMIT = 80;
const DETAIL_CHARS = 140;

function entry(
  event: ProtocolStateEvent,
  label: string,
  tone: Tone,
  detail?: string,
): ActivityEntry {
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    label,
    tone,
    ...(detail ? { detail: preview(detail, DETAIL_CHARS) } : {}),
  };
}

/** La línea de un evento, o `null` si no se enseña. */
export function describeEvent(event: ProtocolStateEvent): ActivityEntry | null {
  const sub = event.subagentId ? ' (subagent)' : '';
  switch (event.type) {
    case 'run.started':
      return entry(event, 'Run started', 'active', event.data.run.input);
    case 'run.updated':
      // `run.updated` cuenta un cambio de estado dentro del run.
      switch (event.data.run.status) {
        case 'paused':
          return entry(event, 'Run paused', 'paused');
        case 'running':
          return entry(event, 'Run running', 'active');
        case 'waiting_approval':
          return entry(event, 'Run waiting for approval', 'waiting');
        case 'waiting_input':
          return entry(event, 'Run waiting for input', 'waiting');
        default:
          return null;
      }
    case 'run.completed':
      return entry(event, 'Run completed', 'ok', event.data.run.stopReason);
    case 'run.failed':
      return entry(event, 'Run failed', 'bad', event.data.run.error);
    case 'run.cancelled':
      return entry(event, 'Run cancelled', 'muted');
    case 'message.completed':
      return entry(event, `Message${sub}`, 'idle', event.data.text);
    // Neutro a propósito: `tool.started` se publica al conocerse la llamada, y
    // puede estar esperando una aprobación o una pausa. No se dice «ejecutando».
    case 'tool.started':
      return entry(event, `Tool call · ${event.data.call.name}${sub}`, 'active', event.data.call.description);
    case 'tool.completed':
      return entry(event, `Tool done · ${event.data.call.name}${sub}`, 'ok', event.data.call.description);
    case 'tool.failed':
      return entry(event, `Tool failed · ${event.data.call.name}${sub}`, 'bad', event.data.call.error);
    case 'tool.blocked':
      return entry(event, `Tool blocked · ${event.data.call.name}${sub}`, 'muted', event.data.source);
    case 'subagent.started':
      return entry(event, `Subagent started · ${event.data.subagent.profile}`, 'active', event.data.subagent.task);
    case 'subagent.completed':
      return entry(
        event,
        `Subagent ${event.data.subagent.status} · ${event.data.subagent.profile}`,
        event.data.subagent.status === 'completed' ? 'ok' : 'bad',
      );
    case 'approval.requested':
      return entry(event, 'Approval requested', 'waiting', event.data.approval.description);
    case 'approval.resolved':
      return entry(event, `Approval ${event.data.status}`, event.data.status === 'approved' ? 'ok' : 'muted');
    case 'question.requested':
      return entry(event, 'Question for the user', 'waiting', event.data.request.questions[0]?.question);
    case 'question.resolved':
      return entry(event, event.data.answers ? 'Question answered' : 'Question skipped', 'muted');
    case 'plan.proposed':
      return entry(event, 'Plan proposed', 'waiting', event.data.request.plan.summary);
    case 'plan.resolved':
      return entry(event, event.data.decision === 'approve' ? 'Plan approved' : 'Plan rejected', 'muted');
    case 'job.started':
      return entry(event, 'Background job started', 'active', event.data.job.command);
    case 'job.ended':
      return entry(event, `Background job ${event.data.job.status}`, event.data.job.status === 'completed' ? 'ok' : 'muted');
    // Sin el texto: el protocolo no lo lleva.
    case 'steering.queued':
      return entry(event, 'Steering queued', 'waiting', `${event.data.chars} chars`);
    case 'steering.delivered':
      return entry(event, 'Steering delivered to the agent', 'ok');
    case 'context.compressed':
      return entry(event, 'Context compressed', 'muted');
    case 'warning':
      return entry(event, 'Warning', 'waiting', event.data.message);
    case 'error':
      return entry(event, event.data.fatal ? 'Fatal error' : 'Error', 'bad', event.data.message);
    case 'session.closed':
      return entry(event, 'Session closed', 'muted', event.data.reason);
    default:
      return null;
  }
}

/** Añade al registro, con tope: lo más antiguo se va. */
export function appendActivity(log: ActivityEntry[], entries: ActivityEntry[]): ActivityEntry[] {
  if (entries.length === 0) return log;
  return [...log, ...entries].slice(-ACTIVITY_LIMIT);
}

/** Marca de que el estado se sustituyó por una foto (reconexión, hueco). */
export function resyncMark(at: number): ActivityEntry {
  return { seq: -1, at, type: 'dot.resync', label: 'State refreshed from a snapshot', tone: 'muted' };
}

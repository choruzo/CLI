import type { ProtocolEvent, ProtocolSessionSnapshot } from './events.js';
import { isStateEvent } from './events.js';
import type { ProtocolJob, ProtocolSubagent, ProtocolToolCall } from './model.js';
import { applyTranscriptEvent, clipText as clip } from './transcript.js';

/**
 * De una foto y un evento, la foto siguiente. Es el lado **consumidor** del
 * contrato de las fotos («el estado tras aplicar todos los eventos de estado
 * hasta `seq`»): quien tiene una foto y recibe los eventos que la siguen llega
 * a la misma foto que daría el anfitrión en ese `seq`.
 *
 * Lo usa cualquiera que siga una sesión sin ser su anfitrión: el daemon para
 * la proyección de una sesión par, un cliente para pintarla. **No decide ni
 * numera nada**: el `seq` es el del evento, y un evento que no sigue a la foto
 * (repetido, o con un hueco) no se aplica — eso lo resuelve una foto nueva del
 * anfitrión, no esta función.
 *
 * Dos límites, a sabiendas:
 *
 *  - `session.context`, `session.tokens` y `session.activeTarget` solo cambian
 *    con un `session.updated`: entre dos de ellos, la foto del anfitrión puede
 *    ir por delante.
 *  - `partial` se rehace con los fragmentos volátiles, que se pueden perder: es
 *    aproximado mientras un bloque de texto está abierto y exacto en cuanto se
 *    cierra.
 */

/** Lo que una foto conserva del run: lo fija el anfitrión y lo respeta quien reduce. */
export const SNAPSHOT_LIMITS = {
  toolCalls: 100,
  subagents: 50,
  /** Salida, error o resumen de un elemento dentro de una foto. */
  textChars: 1_000,
  /** Texto del bloque abierto. */
  partialChars: 100_000,
} as const;

/** Una tool call tal como va dentro de una foto: con sus textos recortados. */
export function snapshotToolCall(call: ProtocolToolCall): ProtocolToolCall {
  return {
    ...call,
    ...(call.output !== undefined ? { output: clip(call.output, SNAPSHOT_LIMITS.textChars) } : {}),
    ...(call.error !== undefined ? { error: clip(call.error, SNAPSHOT_LIMITS.textChars) } : {}),
  };
}

export function snapshotSubagent(subagent: ProtocolSubagent): ProtocolSubagent {
  return {
    ...subagent,
    ...(subagent.summary !== undefined
      ? { summary: clip(subagent.summary, SNAPSHOT_LIMITS.textChars) }
      : {}),
  };
}

function isOpen(call: ProtocolToolCall): boolean {
  return call.state === 'pending' || call.state === 'running';
}

function withToolCall(calls: ProtocolToolCall[], call: ProtocolToolCall): ProtocolToolCall[] {
  const next = snapshotToolCall(call);
  // Un id ya cerrado que vuelve a aparecer es otra llamada: los ids del modelo se repiten.
  for (let i = calls.length - 1; i >= 0; i--) {
    const known = calls[i]!;
    if (known.id !== call.id || known.subagentId !== call.subagentId) continue;
    if (!isOpen(known)) break;
    const out = calls.slice();
    out[i] = next;
    return out;
  }
  return [...calls, next].slice(-SNAPSHOT_LIMITS.toolCalls);
}

function withSubagent(list: ProtocolSubagent[], subagent: ProtocolSubagent): ProtocolSubagent[] {
  return [...list.filter((s) => s.id !== subagent.id), snapshotSubagent(subagent)].slice(
    -SNAPSHOT_LIMITS.subagents,
  );
}

function withJob(jobs: ProtocolJob[], job: ProtocolJob): ProtocolJob[] {
  const at = jobs.findIndex((j) => j.id === job.id);
  if (at < 0) return [...jobs, job];
  const out = jobs.slice();
  out[at] = job;
  return out;
}

const NO_PARTIAL = { text: '', reasoning: '' } as const;

/**
 * Aplica un evento a una foto y devuelve la nueva (la de entrada no se toca).
 * Un evento de otra sesión, uno de estado que no sea el siguiente (`seq + 1`) o
 * uno volátil anterior a la foto la dejan como estaba.
 */
export function applySessionEvent(
  snapshot: ProtocolSessionSnapshot,
  event: ProtocolEvent,
): ProtocolSessionSnapshot {
  if (event.sessionId !== snapshot.session.id) return snapshot;

  if (!isStateEvent(event)) {
    if (event.after !== snapshot.seq || event.subagentId) return snapshot;
    const key = event.type === 'message.delta' ? 'text' : 'reasoning';
    const current = snapshot.partial[key];
    if (current.length >= SNAPSHOT_LIMITS.partialChars) return snapshot;
    return { ...snapshot, partial: { ...snapshot.partial, [key]: current + event.data.text } };
  }

  if (event.seq !== snapshot.seq + 1) return snapshot;
  const main = !event.subagentId;
  let next: ProtocolSessionSnapshot = { ...snapshot, seq: event.seq };

  switch (event.type) {
    case 'session.opened':
    case 'session.updated':
      next.session = event.data.session;
      break;
    case 'session.closed':
      next.session = { ...next.session, state: 'closed', currentRunId: null };
      break;
    case 'run.started':
      // Un run nuevo empieza con lo suyo vacío; las tareas y los jobs son de la sesión.
      next = { ...next, run: event.data.run, toolCalls: [], subagents: [], partial: NO_PARTIAL };
      break;
    case 'run.updated':
      next.run = event.data.run;
      break;
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      next.run = event.data.run;
      next.partial = NO_PARTIAL;
      break;
    case 'message.completed':
      if (main) next.partial = NO_PARTIAL;
      break;
    case 'tool.started':
      // Una tool cierra el bloque de texto (y de razonamiento) que hubiera abierto.
      if (main) next.partial = NO_PARTIAL;
      next.toolCalls = withToolCall(next.toolCalls, event.data.call);
      break;
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.blocked':
      next.toolCalls = withToolCall(next.toolCalls, event.data.call);
      break;
    case 'subagent.started':
    case 'subagent.completed':
      next.subagents = withSubagent(next.subagents, event.data.subagent);
      break;
    case 'todo.updated':
      next.todos = event.data.items.map((t) => ({ ...t }));
      break;
    case 'job.started':
    case 'job.ended':
      next.jobs = withJob(next.jobs, event.data.job);
      break;
    case 'approval.requested':
      next.approvals = [...next.approvals, event.data.approval];
      break;
    case 'approval.resolved':
      next.approvals = next.approvals.filter((a) => a.id !== event.data.approvalId);
      break;
    case 'question.requested':
      next.questions = [...next.questions, event.data.request];
      break;
    case 'question.resolved':
      next.questions = next.questions.filter((q) => q.id !== event.data.requestId);
      break;
    case 'plan.proposed':
      next.plans = [...next.plans, event.data.request];
      break;
    case 'plan.resolved':
      next.plans = next.plans.filter((p) => p.id !== event.data.requestId);
      break;
    default:
      break;
  }
  // La conversación sale de los mismos eventos, por la misma función que usa el anfitrión.
  const transcript = applyTranscriptEvent(snapshot, event);
  if (transcript !== snapshot) {
    next.messages = transcript.messages;
    next.messagesTruncated = transcript.messagesTruncated;
  }
  // El resumen de la sesión lleva siempre el `seq` y la hora del último evento.
  if (next.session.seq !== event.seq || next.session.updatedAt !== event.at) {
    next.session = { ...next.session, seq: event.seq, updatedAt: event.at };
  }
  return next;
}

/**
 * `stratum attach` sin terminal: qué hace cada línea que escribe la persona y
 * cómo se pinta lo que llega de la sesión. Puro (DTOs del protocolo dentro,
 * texto fuera), para probarlo sin un pty.
 *
 * `attach` es un **cliente**: nunca aloja la sesión. Lo que escribe se envía
 * como `runs.start` (sesión del daemon y parada), `runs.steer` (con un run en
 * curso) o una orden de control; salir no toca la sesión.
 */
import type {
  ProtocolApproval,
  ProtocolChatMessage,
  ProtocolEvent,
  ProtocolPlanRequest,
  ProtocolQuestionRequest,
  ProtocolSession,
  ProtocolSessionSnapshot,
} from '../protocol/index.js';

export type AttachAction =
  | { kind: 'none' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'pending' }
  | { kind: 'cancel' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'detach' }
  | { kind: 'start'; input: string }
  | { kind: 'steer'; text: string }
  /** No se envía nada: se le explica por qué a la persona. */
  | { kind: 'refuse'; message: string };

export const ATTACH_HELP = [
  'Type a message to talk to the agent: a new turn when the session is idle,',
  'or steering for the run in progress.',
  '',
  '  /pause     pause the run at its next safe point',
  '  /resume    resume a paused run',
  '  /cancel    cancel the run in progress',
  '  /pending   list approvals, questions and plans waiting for a person',
  '  /detach    hand a terminal-hosted session over to stratumd',
  '  /quit      leave (the session keeps running; Ctrl+C and Ctrl+D also leave)',
].join('\n');

/** Qué hacer con una línea, según la sesión que se ve ahora. */
export function attachAction(session: ProtocolSession | null, line: string): AttachAction {
  const text = line.trim();
  if (!text) return { kind: 'none' };
  if (text.startsWith('/')) {
    const command = text.split(/\s+/)[0]!;
    switch (command) {
      case '/quit':
      case '/exit':
        return { kind: 'quit' };
      case '/help':
        return { kind: 'help' };
      case '/pending':
        return { kind: 'pending' };
      case '/cancel':
        return { kind: 'cancel' };
      case '/pause':
        return { kind: 'pause' };
      case '/resume':
        return { kind: 'resume' };
      case '/detach':
        return { kind: 'detach' };
      default:
        return { kind: 'refuse', message: `Unknown command ${command}. Type /help.` };
    }
  }
  if (!session) return { kind: 'refuse', message: 'The session is not available.' };
  if (session.state === 'closed') return { kind: 'refuse', message: 'The session is closed.' };
  if (session.currentRunId !== null) return { kind: 'steer', text };
  if (session.host.kind !== 'daemon') {
    return {
      kind: 'refuse',
      message:
        'This session runs in a terminal: type there, or hand it over to stratumd first ' +
        '(/detach), and then you can talk to it from here.',
    };
  }
  return { kind: 'start', input: text };
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** Una entrada de la conversación, como texto. */
export function formatChatMessage(m: ProtocolChatMessage): string {
  switch (m.kind) {
    case 'user':
      return `› ${m.text}${m.truncated ? ' …' : ''}`;
    case 'assistant':
      return `${m.text}${m.truncated ? ' …' : ''}`;
    case 'tool':
      return `  ⏺ ${m.name}${m.description && m.description !== m.name ? ` · ${m.description}` : ''}${
        m.state === 'error' ? ' ✗' : m.state === 'blocked' ? ' (blocked)' : ''
      }`;
    case 'outcome':
      return `[run ${m.status}${m.text ? `: ${m.text}` : ''}]`;
  }
}

export function describeHost(session: ProtocolSession): string {
  if (session.host.kind === 'daemon') return 'stratumd';
  return `${session.host.client} (terminal)${session.host.connected ? '' : ', disconnected'}`;
}

/** Cabecera al adjuntarse. */
export function formatHeader(snapshot: ProtocolSessionSnapshot): string {
  const s = snapshot.session;
  return [
    `Attached to ${s.id} · hosted by ${describeHost(s)} · ${s.state}`,
    `${s.agent} · ${s.provider}/${s.model}${s.readOnly ? ' · read-only' : ''} · ${s.cwd}`,
    'Type /help for commands. Leaving never stops the session.',
  ].join('\n');
}

type Pending = ProtocolApproval | ProtocolQuestionRequest | ProtocolPlanRequest;

function describePending(p: Pending): string {
  if ('tool' in p) {
    return `approval ${p.id}: ${p.tool} · ${p.description}${p.confirmPhrase ? ` (type "${p.confirmPhrase}" to approve)` : ''}`;
  }
  if ('questions' in p) {
    return `question ${p.id}: ${p.questions.map((q) => q.question).join(' / ')}`;
  }
  return `plan ${p.id}: ${p.plan.summary}`;
}

/** Lo que espera a una persona. Se resuelve con `stratum approvals` (exige la clave de aprobador). */
export function formatPending(pending: {
  approvals: ProtocolApproval[];
  questions: ProtocolQuestionRequest[];
  plans: ProtocolPlanRequest[];
}): string {
  const all: Pending[] = [...pending.approvals, ...pending.questions, ...pending.plans];
  if (all.length === 0) return 'Nothing is waiting for a person.';
  return [
    ...all.map((p) => `  ${describePending(p)}`),
    'Resolve them with `stratum approvals` (needs the approver key).',
  ].join('\n');
}

/**
 * Lo que se pinta de un evento de estado, o `null` si no se pinta. El texto del
 * asistente llega aparte (fragmentos y `message.completed`): aquí no.
 */
export function formatEvent(event: ProtocolEvent): string | null {
  if (event.subagentId) return null;
  switch (event.type) {
    case 'run.started':
      return `› ${event.data.run.input}`;
    case 'run.completed':
      return null;
    case 'run.failed':
      return `[run failed${event.data.run.error ? `: ${event.data.run.error}` : ''}]`;
    case 'run.cancelled':
      return '[run cancelled]';
    case 'run.updated':
      return event.data.run.status === 'paused'
        ? '[paused · /resume continues]'
        : event.data.run.status === 'running'
          ? null
          : `[${event.data.run.status.replace('_', ' ')}]`;
    case 'tool.started':
      return formatChatMessage({
        kind: 'tool',
        id: '',
        runId: event.data.call.runId,
        at: 0,
        callId: event.data.call.id,
        name: event.data.call.name,
        description: event.data.call.description,
        state: 'running',
      });
    case 'tool.failed':
      return `  ✗ ${event.data.call.name}${event.data.call.error ? `: ${event.data.call.error}` : ''}`;
    case 'tool.blocked':
      return `  ⊘ ${event.data.call.name} (blocked: ${event.data.source})`;
    case 'approval.requested':
      return `[waiting for a person] ${describePending(event.data.approval)}\n${indent('resolve with `stratum approvals`')}`;
    case 'question.requested':
      return `[waiting for a person] ${describePending(event.data.request)}\n${indent('answer with `stratum approvals`')}`;
    case 'plan.proposed':
      return `[waiting for a person] ${describePending(event.data.request)}\n${indent('decide with `stratum approvals`')}`;
    case 'approval.resolved':
      return `[approval ${event.data.status}]`;
    case 'steering.queued':
      return '[queued as steering]';
    case 'session.closed':
      return `[session closed: ${event.data.reason}]`;
    case 'warning':
      return `[warning] ${event.data.message}`;
    case 'error':
      return `[error] ${event.data.message}`;
    default:
      return null;
  }
}

/** ¿Cambió quién aloja la sesión? Lo que se dice, o `null`. */
export function hostChange(before: ProtocolSession | null, after: ProtocolSession): string | null {
  if (!before) return null;
  if (before.host.kind !== after.host.kind) {
    return after.host.kind === 'daemon'
      ? '[the session is now hosted by stratumd: it survives its terminal]'
      : `[the session is now hosted by ${describeHost(after)}]`;
  }
  if (before.host.connected !== after.host.connected) {
    return after.host.connected
      ? '[the terminal hosting the session is back]'
      : '[the terminal hosting the session is unreachable; the run may still be going]';
  }
  return null;
}

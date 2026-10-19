/**
 * De la foto de una sesión (y el historial anterior, si se pidió) a lo que
 * pintan los componentes de chat. **Puro y sin estado**: la conversación es
 * `ProtocolChatMessage[]` (la misma que ve Dot y que guarda el daemon, M11);
 * aquí solo se agrupa por run para pintarla como turnos. El texto que se está
 * generando sale de `partial`; las salidas de las tools del último run, de
 * `toolCalls`. Nada de esto se inventa: lo que la foto no trae, no se pinta.
 */
import type { ConnectionState } from '../ipc/native';
import type {
  ProtocolChatMessage,
  ProtocolSessionSnapshot,
  ProtocolToolCall,
} from '../protocol';
import type { AgentTurn, ChatMessage, ToolCallState } from './model';

const toolState = (state: ProtocolToolCall['state']): ToolCallState =>
  state === 'blocked' ? 'error' : state;

/** Junta el historial anterior y la foto, sin repetir ids y en orden. */
export function conversationOf(
  older: readonly ProtocolChatMessage[],
  snapshot: ProtocolSessionSnapshot,
): ProtocolChatMessage[] {
  if (older.length === 0) return snapshot.messages;
  const inSnapshot = new Set(snapshot.messages.map((m) => m.id));
  return [...older.filter((m) => !inSnapshot.has(m.id)), ...snapshot.messages];
}

export function chatMessages(
  older: readonly ProtocolChatMessage[],
  snapshot: ProtocolSessionSnapshot,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let turn: AgentTurn | null = null;
  const turnFor = (runId: string, fallback: string): AgentTurn => {
    const id = runId || fallback;
    if (turn && turn.turnId === id) return turn;
    turn = { role: 'agent', turnId: id, parts: [], toolCalls: {}, status: 'done' };
    out.push(turn);
    return turn;
  };

  for (const m of conversationOf(older, snapshot)) {
    switch (m.kind) {
      case 'user':
        out.push({ role: 'user', turnId: m.runId || m.id, text: m.text });
        turn = null;
        break;
      case 'assistant':
        turnFor(m.runId, m.id).parts.push({ kind: 'text', text: m.text });
        break;
      case 'tool': {
        const t = turnFor(m.runId, m.id);
        if (!t.toolCalls[m.callId]) t.parts.push({ kind: 'tool', id: m.callId });
        t.toolCalls[m.callId] = {
          id: m.callId,
          name: m.name,
          state: toolState(m.state),
          input: m.description,
        };
        break;
      }
      case 'outcome': {
        const t = turnFor(m.runId, m.id);
        t.status = m.status === 'cancelled' ? 'cancelled' : 'error';
        if (m.status === 'failed' && m.text) t.parts.push({ kind: 'notice', tone: 'error', text: m.text });
        break;
      }
    }
  }

  // El último run de la foto: salidas de sus tools y, si sigue en marcha, lo
  // que se está generando.
  const run = snapshot.run;
  if (run) {
    const t = out.find((m): m is AgentTurn => m.role === 'agent' && m.turnId === run.id) ?? null;
    const active = snapshot.session.currentRunId === run.id;
    const target = t ?? (active ? turnFor(run.id, run.id) : null);
    if (target) {
      for (const call of snapshot.toolCalls) {
        if (call.runId !== run.id || call.subagentId) continue;
        const known = target.toolCalls[call.id];
        if (!known) continue;
        target.toolCalls[call.id] = {
          ...known,
          state: toolState(call.state),
          ...(call.output !== undefined ? { output: call.output } : {}),
          ...(call.error !== undefined ? { error: call.error } : {}),
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        };
      }
      if (active) {
        target.status = 'streaming';
        if (snapshot.partial.reasoning) {
          target.parts.push({ kind: 'reasoning', text: snapshot.partial.reasoning });
        }
        if (snapshot.partial.text) target.parts.push({ kind: 'text', text: snapshot.partial.text });
      } else if (run.status === 'interrupted') {
        target.status = 'interrupted';
      }
    }
  }
  return out;
}

/** Hay mensajes más antiguos que los que se tienen. */
export function hasOlder(snapshot: ProtocolSessionSnapshot, historyHasMore: boolean | null): boolean {
  return historyHasMore ?? snapshot.messagesTruncated;
}

export type ComposerMode =
  /** Un mensaje es un run nuevo de la sesión (`runs.start`). */
  | { kind: 'ask' }
  /** Hay un run: lo que se escribe lo redirige (`runs.steer`). */
  | { kind: 'steer'; paused: boolean }
  /** No se puede escribir, y por qué. */
  | { kind: 'none'; reason: string };

/** El campo de una conversación que aún no existe: el primer mensaje la abre. */
export function draftComposer(connection: ConnectionState): ComposerMode {
  if (connection.kind !== 'connected') return { kind: 'none', reason: 'Sin conexión con Stratum.' };
  if (!connection.capabilities.includes('control')) {
    return { kind: 'none', reason: 'El daemon no permite a Desktop abrir sesiones.' };
  }
  return { kind: 'ask' };
}

/**
 * Qué hace el campo de escritura. Una sesión de otra terminal (par) solo se
 * puede redirigir mientras trabaja: iniciar turnos es de quien la aloja.
 */
export function composerMode(
  connection: ConnectionState,
  snapshot: ProtocolSessionSnapshot | null,
): ComposerMode {
  if (connection.kind !== 'connected') return { kind: 'none', reason: 'Sin conexión con Stratum.' };
  if (!connection.capabilities.includes('control')) {
    return { kind: 'none', reason: 'El daemon no permite a Desktop conducir sesiones.' };
  }
  if (!snapshot) return { kind: 'none', reason: 'Cargando la sesión…' };
  const session = snapshot.session;
  if (session.state === 'closed') return { kind: 'none', reason: 'Esta sesión está cerrada.' };
  if (session.currentRunId) {
    if (session.host.kind === 'peer' && !session.host.connected) {
      return { kind: 'none', reason: 'El proceso que aloja la sesión no responde.' };
    }
    return { kind: 'steer', paused: session.state === 'paused' };
  }
  if (session.host.kind === 'peer') {
    return {
      kind: 'none',
      reason: 'Esta sesión la aloja una terminal: escribe allí, o pásala al daemon con /detach.',
    };
  }
  return { kind: 'ask' };
}

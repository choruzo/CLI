import type {
  AgentEvent,
  QuestionItem,
  TodoItem,
} from '../../../stratum-cli/src/agent/events';

/**
 * Estado de una conversación en el webview (D1). Reducer puro: los tests lo
 * ejercitan sin Tauri ni sidecar.
 *
 * Regla de §D1: `tool_call_start` llega varias veces por tool call (una por
 * fragmento SSE de los argumentos) y siempre **actualiza** el tool call de ese
 * `id`; nunca crea una entrada nueva.
 */

export type ToolCallState = 'pending' | 'running' | 'completed' | 'error';

export interface ToolCallView {
  id: string;
  name: string;
  state: ToolCallState;
  /** Argumentos: el JSON parcial mientras llega, el objeto al estar listos. */
  input: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

/** Trozos de una respuesta, en el orden en que llegaron. */
export type AgentPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'notice'; tone: 'warning' | 'error'; text: string };

export type TurnStatus = 'streaming' | 'done' | 'cancelled' | 'error' | 'interrupted';

export interface UserMessage {
  role: 'user';
  turnId: string;
  text: string;
}

export interface AgentTurn {
  role: 'agent';
  turnId: string;
  parts: AgentPart[];
  toolCalls: Record<string, ToolCallView>;
  status: TurnStatus;
  stopReason?: string;
}

export type ChatMessage = UserMessage | AgentTurn;

export interface PendingQuestions {
  requestId: string;
  questions: QuestionItem[];
}

export interface PendingConfirm {
  callId: string;
  tool: string;
  description: string;
}

export interface ConversationState {
  messages: ChatMessage[];
  /** Turno en curso, si lo hay. */
  activeTurnId: string | null;
  pendingQuestions: PendingQuestions | null;
  pendingConfirm: PendingConfirm | null;
  todos: TodoItem[];
  /** El sidecar confirmó la conversación (`conversation_opened`). */
  opened: boolean;
  /** Último problema de la conversación que no pertenece a un turno (historial ilegible…). */
  notice: string | null;
}

export const initialConversationState: ConversationState = {
  messages: [],
  activeTurnId: null,
  pendingQuestions: null,
  pendingConfirm: null,
  todos: [],
  opened: false,
  notice: null,
};

export type ConversationAction =
  | { type: 'opened' }
  | { type: 'conversation_error'; message: string }
  | { type: 'dismiss_notice' }
  | { type: 'user_sent'; turnId: string; text: string }
  | { type: 'agent_event'; turnId: string; event: AgentEvent }
  | { type: 'turn_ended'; turnId: string; stopReason: string }
  | { type: 'chat_rejected'; turnId: string; message: string }
  | { type: 'questions_request'; requestId: string; questions: QuestionItem[] }
  | { type: 'questions_resolved'; requestId: string }
  | { type: 'confirm_request'; callId: string; tool: string; description: string }
  | { type: 'confirm_resolved'; callId: string }
  /** El sidecar se cayó: lo que estaba en vuelo no va a terminar. */
  | { type: 'connection_lost' };

function updateTurn(
  state: ConversationState,
  turnId: string,
  fn: (turn: AgentTurn) => AgentTurn,
): ConversationState {
  const idx = state.messages.findIndex((m) => m.role === 'agent' && m.turnId === turnId);
  if (idx === -1) return state;
  const messages = state.messages.slice();
  messages[idx] = fn(messages[idx] as AgentTurn);
  return { ...state, messages };
}

function appendText(parts: AgentPart[], delta: string): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === 'text') {
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + delta }];
  }
  return [...parts, { kind: 'text', text: delta }];
}

function upsertTool(
  turn: AgentTurn,
  id: string,
  name: string,
  patch: Partial<ToolCallView>,
): AgentTurn {
  const existing = turn.toolCalls[id];
  const parts = existing ? turn.parts : [...turn.parts, { kind: 'tool' as const, id }];
  const base: ToolCallView = existing ?? { id, name, state: 'pending', input: '' };
  return {
    ...turn,
    parts,
    toolCalls: { ...turn.toolCalls, [id]: { ...base, name: name || base.name, ...patch } },
  };
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function applyEvent(turn: AgentTurn, event: AgentEvent): AgentTurn {
  switch (event.type) {
    case 'text_delta':
      return { ...turn, parts: appendText(turn.parts, event.delta) };
    case 'tool_call_start':
      return upsertTool(turn, event.id, event.name, { input: event.input_so_far });
    case 'tool_call_ready':
      return upsertTool(turn, event.id, event.name, {
        state: 'running',
        input: stringifyInput(event.input),
      });
    case 'tool_result':
      return upsertTool(turn, event.id, event.name, {
        state: 'completed',
        output: event.result,
        durationMs: event.durationMs,
      });
    case 'tool_error':
      return upsertTool(turn, event.id, event.name, { state: 'error', error: event.error });
    case 'questions_answered': {
      // `question` es una tool de control: el loop no emite `tool_result`, solo
      // `questions_answered`. Sin esto el bloque quedaría «ejecutando» y al
      // cerrar el turno pasaría a error aunque la respuesta llegara bien.
      const output = event.answers?.length
        ? event.answers.map((a) => `${a.question} → ${a.answer}`).join('\n')
        : 'Sin respuesta: el asistente sigue con supuestos.';
      let next = turn;
      for (const call of Object.values(turn.toolCalls)) {
        if (call.name === 'question' && (call.state === 'pending' || call.state === 'running')) {
          next = upsertTool(next, call.id, call.name, { state: 'completed', output });
        }
      }
      return next;
    }
    case 'warning':
      return { ...turn, parts: [...turn.parts, { kind: 'notice', tone: 'warning', text: event.message }] };
    case 'error':
      return { ...turn, parts: [...turn.parts, { kind: 'notice', tone: 'error', text: event.message }] };
    case 'done':
      return { ...turn, status: statusFor(event.stopReason), stopReason: event.stopReason };
    default:
      return turn;
  }
}

/** Estado final de un turno según su `stopReason`: solo los motivos no fallidos son `done`. */
function statusFor(stopReason: string): TurnStatus {
  if (stopReason === 'cancelled') return 'cancelled';
  if (stopReason === 'error') return 'error';
  return 'done';
}

/** Un tool call que no llegó a terminar no puede quedarse girando para siempre. */
function settleTools(turn: AgentTurn): AgentTurn {
  let changed = false;
  const toolCalls: Record<string, ToolCallView> = {};
  for (const [id, call] of Object.entries(turn.toolCalls)) {
    if (call.state === 'pending' || call.state === 'running') {
      changed = true;
      toolCalls[id] = { ...call, state: 'error', error: call.error ?? 'No llegó a terminar.' };
    } else {
      toolCalls[id] = call;
    }
  }
  return changed ? { ...turn, toolCalls } : turn;
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case 'opened':
      return { ...state, opened: true };

    case 'conversation_error':
      return { ...state, notice: action.message };

    case 'dismiss_notice':
      return { ...state, notice: null };

    case 'user_sent': {
      const agent: AgentTurn = {
        role: 'agent',
        turnId: action.turnId,
        parts: [],
        toolCalls: {},
        status: 'streaming',
      };
      return {
        ...state,
        activeTurnId: action.turnId,
        messages: [...state.messages, { role: 'user', turnId: action.turnId, text: action.text }, agent],
      };
    }

    case 'agent_event': {
      const { event } = action;
      let next = updateTurn(state, action.turnId, (t) => applyEvent(t, event));
      if (event.type === 'todo_updated') next = { ...next, todos: event.items };
      // `questions_answered` cierra la tanda aunque la respuesta llegase por
      // otro camino (timeout, cancel): la UI no puede seguir preguntando.
      if (event.type === 'questions_answered') next = { ...next, pendingQuestions: null };
      return next;
    }

    case 'turn_ended': {
      const next = updateTurn(state, action.turnId, (t) =>
        settleTools(
          t.status === 'streaming'
            ? { ...t, status: statusFor(action.stopReason), stopReason: action.stopReason }
            : t,
        ),
      );
      return {
        ...next,
        activeTurnId: state.activeTurnId === action.turnId ? null : state.activeTurnId,
        pendingQuestions: null,
        pendingConfirm: null,
      };
    }

    case 'chat_rejected': {
      const next = updateTurn(state, action.turnId, (t) => ({
        ...t,
        status: 'error',
        parts: [...t.parts, { kind: 'notice', tone: 'error', text: action.message }],
      }));
      return {
        ...next,
        activeTurnId: state.activeTurnId === action.turnId ? null : state.activeTurnId,
      };
    }

    case 'questions_request':
      return { ...state, pendingQuestions: { requestId: action.requestId, questions: action.questions } };

    case 'questions_resolved':
      return state.pendingQuestions?.requestId === action.requestId
        ? { ...state, pendingQuestions: null }
        : state;

    case 'confirm_request':
      return {
        ...state,
        pendingConfirm: { callId: action.callId, tool: action.tool, description: action.description },
      };

    case 'confirm_resolved':
      return state.pendingConfirm?.callId === action.callId ? { ...state, pendingConfirm: null } : state;

    case 'connection_lost': {
      const turnId = state.activeTurnId;
      const next = turnId
        ? updateTurn(state, turnId, (t) => settleTools({ ...t, status: 'interrupted' }))
        : state;
      return {
        ...next,
        activeTurnId: null,
        pendingQuestions: null,
        pendingConfirm: null,
        opened: false,
      };
    }
  }
}

/** Texto del mensaje de usuario de un turno, para «Reintentar» tras una caída. */
export function userTextOf(state: ConversationState, turnId: string): string | null {
  const m = state.messages.find((x) => x.role === 'user' && x.turnId === turnId);
  return m && m.role === 'user' ? m.text : null;
}

import type {
  AgentEvent,
  QuestionItem,
  TodoItem,
} from '../../../stratum-cli/src/agent/events';
import type {
  ConversationStats,
  TranscriptTurn,
  WorkspaceFileInfo,
  WorkspaceStatus,
} from '../../../stratum-cli/src/desktop/protocol';

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
  /**
   * Razonamiento del modelo (D7). `startedAt`/`endedAt` (ms, reloj del webview)
   * solo existen si se vio llegar: un turno reabierto no los trae.
   */
  | { kind: 'reasoning'; text: string; startedAt?: number; endedAt?: number }
  | { kind: 'tool'; id: string }
  | { kind: 'notice'; tone: 'warning' | 'error'; text: string };

/** `queued`: espera a que otra conversación termine (`desktop.maxConcurrentTurns`, D4). */
export type TurnStatus = 'queued' | 'streaming' | 'done' | 'cancelled' | 'error' | 'interrupted';

/** Un adjunto enviado con un mensaje (D2): solo su ruta en el workspace. */
export interface SentAttachment {
  path: string;
  name: string;
  size: number;
}

export interface UserMessage {
  role: 'user';
  turnId: string;
  text: string;
  attachments?: SentAttachment[];
}

export interface AgentTurn {
  role: 'agent';
  turnId: string;
  parts: AgentPart[];
  toolCalls: Record<string, ToolCallView>;
  status: TurnStatus;
  stopReason?: string;
  /** Ficheros que el turno dejó en `outputs/` (D2, `workspace_files`). */
  files?: WorkspaceFileInfo[];
  /** Posición en la cola de generación mientras `status === 'queued'` (D4). */
  queuePosition?: number;
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
  /** Retención del workspace (D3); `null` si la conversación no tiene ficheros. */
  workspace: WorkspaceStatus | null;
  /** Título que le da el sidecar (derivado del primer mensaje o puesto a mano) (D4). */
  title: string | null;
  /** Provider, modelo y contexto para la StatusBar (D4). */
  stats: ConversationStats | null;
  /** Aviso informativo (resultado de `/compact`, `/model`…). */
  info: string | null;
}

export const initialConversationState: ConversationState = {
  messages: [],
  activeTurnId: null,
  pendingQuestions: null,
  pendingConfirm: null,
  todos: [],
  opened: false,
  notice: null,
  workspace: null,
  title: null,
  stats: null,
  info: null,
};

/** Lo que trae `conversation_opened` para pintar la conversación (D4). */
export interface OpenedSnapshot {
  transcript: TranscriptTurn[];
  activeTurnId: string | null;
  todos: TodoItem[];
  stats: ConversationStats | null;
  title: string | null;
}

export type ConversationAction =
  | { type: 'opened'; workspace?: WorkspaceStatus | null; snapshot?: OpenedSnapshot }
  | { type: 'cleared' }
  | { type: 'turn_queued'; turnId: string; position: number }
  | { type: 'turn_started'; turnId: string }
  | { type: 'stats'; stats: ConversationStats }
  | { type: 'info'; message: string }
  | { type: 'dismiss_info' }
  | { type: 'workspace_status'; status: WorkspaceStatus }
  | { type: 'conversation_error'; message: string }
  | { type: 'dismiss_notice' }
  | { type: 'user_sent'; turnId: string; text: string; attachments?: SentAttachment[] }
  | { type: 'workspace_files'; turnId: string; files: WorkspaceFileInfo[] }
  /** `now`: reloj para medir el razonamiento; por defecto `Date.now()`. */
  | { type: 'agent_event'; turnId: string; event: AgentEvent; now?: number }
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

/** Fragmentos consecutivos de razonamiento forman un bloque. */
function appendReasoning(parts: AgentPart[], delta: string, now: number): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === 'reasoning' && last.endedAt === undefined) {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...parts, { kind: 'reasoning', text: delta, startedAt: now }];
}

/** Cualquier otra cosa que llegue cierra el bloque de razonamiento abierto. */
function closeReasoning(parts: AgentPart[], now: number): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind !== 'reasoning' || last.endedAt !== undefined || last.startedAt === undefined) {
    return parts;
  }
  return [...parts.slice(0, -1), { ...last, endedAt: now }];
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

function applyEvent(turn: AgentTurn, event: AgentEvent, now: number): AgentTurn {
  if (event.type === 'thinking') {
    return {
      ...turn,
      status: turn.status === 'queued' ? 'streaming' : turn.status,
      parts: appendReasoning(turn.parts, event.text, now),
    };
  }
  const closed = closeReasoning(turn.parts, now);
  if (closed !== turn.parts) turn = { ...turn, parts: closed };
  switch (event.type) {
    case 'text_delta':
      return {
        ...turn,
        status: turn.status === 'queued' ? 'streaming' : turn.status,
        parts: appendText(turn.parts, event.delta),
      };
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

/** Mensajes de la UI a partir del transcript que guarda el sidecar. */
export function messagesFromTranscript(transcript: TranscriptTurn[]): ChatMessage[] {
  return transcript.flatMap((t): ChatMessage[] => [
    {
      role: 'user',
      turnId: t.turnId,
      text: t.user.text,
      ...(t.user.attachments?.length ? { attachments: t.user.attachments } : {}),
    },
    {
      role: 'agent',
      turnId: t.turnId,
      parts: t.parts,
      toolCalls: t.toolCalls,
      status: t.status,
      ...(t.stopReason ? { stopReason: t.stopReason } : {}),
      ...(t.files?.length ? { files: t.files } : {}),
    },
  ]);
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case 'opened': {
      const next = { ...state, opened: true, workspace: action.workspace ?? null };
      const snap = action.snapshot;
      if (!snap) return next;
      // El sidecar es la fuente de verdad: su transcript incluye el turno en
      // marcha (o en cola) con lo que ya se generó.
      const active =
        snap.activeTurnId && snap.transcript.some((t) => t.turnId === snap.activeTurnId)
          ? snap.activeTurnId
          : null;
      return {
        ...next,
        messages: messagesFromTranscript(snap.transcript),
        activeTurnId: active,
        todos: snap.todos,
        stats: snap.stats ?? state.stats,
        title: snap.title ?? state.title,
      };
    }

    case 'cleared':
      return {
        ...state,
        messages: [],
        todos: [],
        activeTurnId: null,
        pendingQuestions: null,
        pendingConfirm: null,
        notice: null,
        info: null,
      };

    case 'turn_queued':
      return updateTurn(state, action.turnId, (t) => ({
        ...t,
        status: t.status === 'streaming' && t.parts.length === 0 ? 'queued' : t.status,
        queuePosition: action.position,
      }));

    case 'turn_started':
      return updateTurn(state, action.turnId, (t) => ({
        ...t,
        status: t.status === 'queued' ? 'streaming' : t.status,
        queuePosition: undefined,
      }));

    case 'stats':
      return { ...state, stats: action.stats };

    case 'info':
      return { ...state, info: action.message };

    case 'dismiss_info':
      return { ...state, info: null };

    case 'workspace_status':
      return { ...state, workspace: action.status };

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
        messages: [
          ...state.messages,
          {
            role: 'user',
            turnId: action.turnId,
            text: action.text,
            ...(action.attachments?.length ? { attachments: action.attachments } : {}),
          },
          agent,
        ],
      };
    }

    case 'workspace_files':
      return updateTurn(state, action.turnId, (t) => ({
        ...t,
        // Un fichero reescrito en el mismo turno sustituye a su tarjeta anterior.
        files: [
          ...(t.files ?? []).filter((f) => !action.files.some((n) => n.path === f.path)),
          ...action.files,
        ],
      }));

    case 'agent_event': {
      const { event } = action;
      const now = action.now ?? Date.now();
      let next = updateTurn(state, action.turnId, (t) => applyEvent(t, event, now));
      if (event.type === 'todo_updated') next = { ...next, todos: event.items };
      // `questions_answered` cierra la tanda aunque la respuesta llegase por
      // otro camino (timeout, cancel): la UI no puede seguir preguntando.
      if (event.type === 'questions_answered') next = { ...next, pendingQuestions: null };
      return next;
    }

    case 'turn_ended': {
      const ended = Date.now();
      const next = updateTurn(state, action.turnId, (t) =>
        settleTools(
          t.status === 'streaming' || t.status === 'queued'
            ? {
                ...t,
                parts: closeReasoning(t.parts, ended),
                status: statusFor(action.stopReason),
                stopReason: action.stopReason,
                queuePosition: undefined,
              }
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
        ? updateTurn(state, turnId, (t) =>
            settleTools({ ...t, parts: closeReasoning(t.parts, Date.now()), status: 'interrupted' }),
          )
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

/** Mensaje de usuario de un turno, para «Reintentar» tras una caída. */
export function userMessageOf(state: ConversationState, turnId: string): UserMessage | null {
  const m = state.messages.find((x) => x.role === 'user' && x.turnId === turnId);
  return m && m.role === 'user' ? m : null;
}

/** Texto del mensaje de usuario de un turno. */
export function userTextOf(state: ConversationState, turnId: string): string | null {
  return userMessageOf(state, turnId)?.text ?? null;
}

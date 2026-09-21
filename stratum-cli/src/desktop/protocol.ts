/**
 * Protocolo del canal local entre Stratum Desktop (Rust) y el sidecar
 * `stratum-core` (D0). Ver `STRATUM_DESKTOP_PROJECT_DEFINITION.md` §3.
 *
 * Transporte: named pipe (Windows) o unix socket (Linux), nunca TCP (15.1, 15.10).
 * El webview no puede abrir un socket local, así que el proceso Rust hace de
 * relay: webview ⇄ Tauri Channel ⇄ Rust ⇄ pipe ⇄ sidecar. Por el pipe viaja
 * NDJSON: un objeto JSON por línea, UTF-8.
 *
 * Este fichero es la única definición del protocolo: el frontend de Desktop
 * importa sus tipos (`import type`), así que no puede depender de tipos de Node.
 *
 * La primera trama de cada conexión tiene que ser `handshake` con el token del
 * arranque; cualquier otra cosa, o el silencio durante `HANDSHAKE_TIMEOUT_MS`,
 * cierra la conexión sin haber procesado nada.
 *
 * D1 añade el chat: todas las tramas de conversación llevan `conversationId`
 * (UUID que genera el frontend) y viajan por el mismo canal ordenado que el
 * stream, `cancel` incluido (15.9). Rust filtra por tipo y tamaño lo que manda
 * el webview; el sidecar valida cada trama con un schema estricto (`codec.ts`).
 */

import type {
  AgentEvent,
  DestructiveDecision,
  QuestionAnswer,
  QuestionItem,
} from '../agent/events.js';

export type { AgentEvent, DestructiveDecision, QuestionAnswer, QuestionItem };

/** Versión del protocolo del canal. Rust la comprueba en `handshake_ok`. */
export const DESKTOP_PROTOCOL_VERSION = 2;

/** Tiempo máximo para recibir el handshake tras aceptar una conexión. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Tope de una trama antes de autenticar: un handshake cabe de sobra en 4 KiB. */
export const MAX_UNAUTHENTICATED_FRAME_BYTES = 4 * 1024;

/**
 * Tope de una trama autenticada. La más grande que manda el frontend es un
 * `chat` (`MAX_CHAT_CHARS` caracteres, hasta 4 bytes cada uno en UTF-8); el
 * historial para rehidratar lo lee el sidecar de disco, no viaja por el canal.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Límites de los campos de las tramas de entrada (los aplica `codec.ts`). */
export const LIMITS = {
  /** Mensaje del usuario. */
  chatChars: 200_000,
  /** `turnId`, `requestId`, `callId`, id de opción: identificadores opacos. */
  idChars: 128,
  /** Tanda de `question`: la tool admite 4; margen para no acoplarse. */
  answers: 8,
  /** Texto de una pregunta o de una respuesta libre. */
  answerChars: 4_000,
} as const;

// ---------------------------------------------------------------------------
// Tramas de entrada (Rust → sidecar)
// ---------------------------------------------------------------------------

export interface HandshakeFrame {
  type: 'handshake';
  token: string;
}

export interface PingFrame {
  type: 'ping';
  /** Correlación opcional, se devuelve tal cual en el `pong`. */
  id?: string;
}

export interface NewConversationFrame {
  type: 'new_conversation';
  conversationId: string;
  /** Rehidratar desde la sesión en disco si existe (tras un reinicio del sidecar, 15.5). */
  resume?: boolean;
}

export interface CloseConversationFrame {
  type: 'close_conversation';
  conversationId: string;
}

export interface ChatFrame {
  type: 'chat';
  conversationId: string;
  /** Lo genera el frontend: etiqueta todos los eventos del turno. */
  turnId: string;
  text: string;
}

export interface CancelFrame {
  type: 'cancel';
  conversationId: string;
  /** Si viene, solo cancela ese turno (un `cancel` tardío no aborta el siguiente). */
  turnId?: string;
}

export interface AnswerQuestionsFrame {
  type: 'answer_questions';
  conversationId: string;
  requestId: string;
  /** `null` = el usuario omitió la tanda: el agente sigue con supuestos. */
  answers: QuestionAnswer[] | null;
}

export interface ConfirmResponseFrame {
  type: 'confirm_response';
  conversationId: string;
  callId: string;
  decision: DestructiveDecision;
}

export type ConversationFrame =
  | NewConversationFrame
  | CloseConversationFrame
  | ChatFrame
  | CancelFrame
  | AnswerQuestionsFrame
  | ConfirmResponseFrame;

export type InboundFrame = HandshakeFrame | PingFrame | ConversationFrame;

/** Tipos que el frontend puede mandar. Rust aplica la misma lista (`transport.rs`). */
export const CLIENT_FRAME_TYPES = [
  'ping',
  'new_conversation',
  'close_conversation',
  'chat',
  'cancel',
  'answer_questions',
  'confirm_response',
] as const;

// ---------------------------------------------------------------------------
// Tramas de salida (sidecar → Rust)
// ---------------------------------------------------------------------------

export type NativeModuleName = 'better-sqlite3' | 'sqlite-vec' | '@xenova/transformers';

export interface NativeProbe {
  module: NativeModuleName;
  ok: boolean;
  /** Motivo del fallo; ausente si `ok`. */
  error?: string;
}

export interface CoreInfo {
  /** Versión de stratum-cli con la que se compiló el sidecar (pineada, 15.6). */
  version: string;
  protocolVersion: number;
  configSchemaVersion: number;
  sessionSchemaVersion: number;
  /** `process.platform`. Tipado como string para que el frontend importe este fichero sin tipos de Node. */
  platform: string;
  /** Versión del runtime Node embebido (SEA) o del Node que lo ejecuta. */
  node: string;
  /** `true` si corre como Single Executable Application. */
  sea: boolean;
}

export interface HandshakeOkFrame {
  type: 'handshake_ok';
  core: CoreInfo;
  natives: NativeProbe[];
}

export interface HandshakeErrorFrame {
  type: 'handshake_error';
  reason: 'bad_token' | 'expected_handshake' | 'malformed' | 'timeout' | 'frame_too_large';
}

export interface PongFrame {
  type: 'pong';
  id?: string;
  /** Epoch ms del sidecar al responder. */
  ts: number;
}

export type SidecarErrorCode = 'schema_incompatible' | 'config_invalid' | 'protocol';

export interface ConversationOpenedFrame {
  type: 'conversation_opened';
  conversationId: string;
  /** Se cargó el historial de una sesión en disco. */
  resumed: boolean;
  /** Mensajes del historial rehidratado (sin el system prompt). */
  messageCount: number;
}

export interface ConversationClosedFrame {
  type: 'conversation_closed';
  conversationId: string;
}

export interface AgentEventFrame {
  type: 'agent_event';
  conversationId: string;
  turnId: string;
  event: AgentEvent;
}

/** Último mensaje de un turno. Llega siempre, también si el turno acabó por excepción. */
export interface TurnEndedFrame {
  type: 'turn_ended';
  conversationId: string;
  turnId: string;
  stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' | 'budget_tokens';
}

export type ChatRejectReason = 'busy' | 'unknown_conversation' | 'sidecar_unavailable';

export interface ChatRejectedFrame {
  type: 'chat_rejected';
  conversationId: string;
  turnId: string;
  reason: ChatRejectReason;
  message: string;
}

/**
 * Confirmación de una tool destructiva (15.4). `description` es la que genera
 * el dispatcher (`describeCall`), ya redactada: los parámetros crudos nunca
 * llegan al webview.
 */
export interface ConfirmRequestFrame {
  type: 'confirm_request';
  conversationId: string;
  callId: string;
  tool: string;
  description: string;
}

export interface QuestionsRequestFrame {
  type: 'questions_request';
  conversationId: string;
  requestId: string;
  questions: QuestionItem[];
}

/** El sidecar dio por resuelta una espera (timeout, cancel): la UI la retira. */
export interface PromptResolvedFrame {
  type: 'prompt_resolved';
  conversationId: string;
  kind: 'confirm' | 'questions';
  id: string;
}

/** Error de una trama de conversación que no se puede atribuir a un turno. */
export interface ConversationErrorFrame {
  type: 'conversation_error';
  conversationId: string;
  message: string;
}

export type ConversationOutboundFrame =
  | ConversationOpenedFrame
  | ConversationClosedFrame
  | AgentEventFrame
  | TurnEndedFrame
  | ChatRejectedFrame
  | ConfirmRequestFrame
  | QuestionsRequestFrame
  | PromptResolvedFrame
  | ConversationErrorFrame;

export interface SidecarErrorFrame {
  type: 'sidecar_error';
  fatal: boolean;
  code: SidecarErrorCode;
  message: string;
}

export type OutboundFrame =
  | HandshakeOkFrame
  | HandshakeErrorFrame
  | PongFrame
  | SidecarErrorFrame
  | ConversationOutboundFrame;

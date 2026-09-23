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
 *
 * D2 (v3) añade el workspace de cada conversación: el `chat` puede llevar
 * adjuntos (rutas `inputs/…` del workspace, nunca rutas del disco del usuario),
 * el sidecar anuncia con `workspace_files` lo que el agente dejó en `outputs/`,
 * y `handshake_ok` le dice a Rust dónde viven los workspaces y sus límites.
 * `workspace_touch` solo lo manda Rust (tras copiar una subida): no está en
 * `CLIENT_FRAME_TYPES`, así que el webview no puede emitirlo.
 *
 * D3 (v4) añade la retención: `conversation_opened.workspace` y
 * `workspace_status` llevan el estado del workspace (`active`, `restoring`
 * mientras se descomprime, `archived`, `purged`) con la fecha prevista de
 * purga, y el webview puede fijar la conversación con `workspace_pin`.
 *
 * D4 (v5) añade varias conversaciones vivas a la vez: el listado para el
 * sidebar (`list_conversations` → `conversations`), renombrar y eliminar (que
 * borra también el workspace), `/clear`, `/compact` y `/model` por conversación,
 * la cola de turnos cuando hay más generaciones que `desktop.maxConcurrentTurns`
 * (`turn_queued` / `turn_started`), las estadísticas de la StatusBar
 * (`conversation_stats`), el transcript visible al abrir (sobrevive a la
 * compresión de contexto) y la memoria global (`memory_*`).
 */

import type {
  AgentEvent,
  DestructiveDecision,
  QuestionAnswer,
  QuestionItem,
  TodoItem,
} from '../agent/events.js';

export type { AgentEvent, DestructiveDecision, QuestionAnswer, QuestionItem, TodoItem };

/** Versión del protocolo del canal. Rust la comprueba en `handshake_ok`. */
export const DESKTOP_PROTOCOL_VERSION = 5;

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
  /** Adjuntos de un mismo mensaje. */
  attachments: 20,
  /** Ruta de un adjunto dentro del workspace (`inputs/…`). */
  attachmentPathChars: 512,
  /** Título de una conversación. */
  titleChars: 200,
  /** Nombre de un modelo (`/model`). */
  modelChars: 256,
  /** Contenido del `STRATUM.md` global editado desde el sidebar. */
  memoryChars: 256 * 1024,
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
  /** Puede ir vacío solo si hay adjuntos. */
  text: string;
  /** Rutas del workspace (`inputs/informe.pdf`) de los ficheros que acompañan al mensaje (D2). */
  attachments?: string[];
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

/**
 * Rust copió una subida en `inputs/` (D2): el sidecar marca uso y recalcula el
 * tamaño. Solo lo emite Rust; el webview no puede (no está en la lista blanca).
 */
export interface WorkspaceTouchFrame {
  type: 'workspace_touch';
  conversationId: string;
}

/** Fija la conversación (la excluye de la retención) o la desfija (D3, 16.7). */
export interface WorkspacePinFrame {
  type: 'workspace_pin';
  conversationId: string;
  pinned: boolean;
}

/** Pide el listado de conversaciones para el sidebar (D4). */
export interface ListConversationsFrame {
  type: 'list_conversations';
}

export interface RenameConversationFrame {
  type: 'rename_conversation';
  conversationId: string;
  title: string;
}

/** Elimina la conversación: historial, transcript y workspace (o su archivo). */
export interface DeleteConversationFrame {
  type: 'delete_conversation';
  conversationId: string;
}

/** `/clear`: vacía el historial (del agente y el visible). El workspace se queda. */
export interface ClearConversationFrame {
  type: 'clear_conversation';
  conversationId: string;
}

/** `/compact`: comprime el contexto ahora, sin esperar al umbral. */
export interface CompactConversationFrame {
  type: 'compact_conversation';
  conversationId: string;
}

/** `/model` sin argumento: modelos que ofrece el provider de la conversación. */
export interface ListModelsFrame {
  type: 'list_models';
  conversationId: string;
}

/** `/model <nombre>`: cambia el modelo solo en esta conversación. */
export interface SetModelFrame {
  type: 'set_model';
  conversationId: string;
  model: string;
}

/** Memoria global para el sidebar: `STRATUM.md` y decisiones del asistente. */
export interface MemoryGetFrame {
  type: 'memory_get';
}

/**
 * Guarda el `STRATUM.md` global. `baseMtimeMs` es la versión sobre la que se
 * editó (`null` si no existía): si el fichero cambió en disco entretanto (la
 * CLI, otro editor), no se pisa y se responde `memory_conflict`.
 */
export interface MemorySaveFrame {
  type: 'memory_save';
  content: string;
  baseMtimeMs: number | null;
}

/** Borra una decisión de la memoria del asistente. */
export interface MemoryForgetFrame {
  type: 'memory_forget';
  id: string;
}

export type ConversationFrame =
  | ListConversationsFrame
  | RenameConversationFrame
  | DeleteConversationFrame
  | ClearConversationFrame
  | CompactConversationFrame
  | ListModelsFrame
  | SetModelFrame
  | MemoryGetFrame
  | MemorySaveFrame
  | MemoryForgetFrame
  | WorkspaceTouchFrame
  | WorkspacePinFrame
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
  'workspace_pin',
  'list_conversations',
  'rename_conversation',
  'delete_conversation',
  'clear_conversation',
  'compact_conversation',
  'list_models',
  'set_model',
  'memory_get',
  'memory_save',
  'memory_forget',
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

/**
 * Dónde viven los workspaces y sus límites (D2). Lo consume Rust, que es quien
 * copia las subidas y sirve las descargas; no se reenvía al webview.
 */
export interface WorkspacesInfo {
  root: string;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
}

export interface HandshakeOkFrame {
  type: 'handshake_ok';
  core: CoreInfo;
  natives: NativeProbe[];
  workspaces?: WorkspacesInfo;
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

/**
 * Días antes de la purga en los que la UI avisa en la conversación (16.7).
 * Constante del protocolo para que sidecar y webview cuenten igual.
 */
export const PURGE_WARNING_DAYS = 3;

/** Retención del workspace de una conversación (D3). */
export interface WorkspaceStatus {
  /** `restoring`: se está descomprimiendo antes de abrir la conversación. */
  state: 'active' | 'restoring' | 'archived' | 'purged';
  /** Fijada: excluida de la retención. */
  pinned: boolean;
  /** Último uso (turno o subida), ISO 8601. */
  lastUsedAt: string;
  /** Cuándo se borrarán los ficheros si no se usa antes; `null` si fijada o sin purga. */
  purgeAt: string | null;
  /** Los ficheros anteriores a esta fecha ya no existen (se purgaron); `null` si nunca. */
  filesExpiredAt: string | null;
  /** Tamaño de los ficheros (el de la carpeta antes de comprimirla, si está archivada) (D4). */
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Transcript visible (D4)
// ---------------------------------------------------------------------------

/**
 * Lo que la UI pinta de una conversación, guardado por el sidecar junto a la
 * sesión. No es el historial del agente: ese se comprime y pierde lo antiguo;
 * este conserva los turnos tal como se vieron (texto, tool calls con la salida
 * recortada, avisos y tarjetas de fichero).
 */
export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'notice'; tone: 'warning' | 'error'; text: string };

export interface TranscriptToolCall {
  id: string;
  name: string;
  state: 'pending' | 'running' | 'completed' | 'error';
  input: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface TranscriptAttachment {
  path: string;
  name: string;
  size: number;
}

/**
 * `queued`: espera turno de generación (15.15). `interrupted`: el sidecar murió
 * con el turno en marcha (la UI ofrece reintentarlo).
 */
export type TranscriptTurnStatus =
  | 'queued'
  | 'streaming'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'interrupted';

export interface TranscriptTurn {
  turnId: string;
  user: { text: string; attachments?: TranscriptAttachment[] };
  parts: TranscriptPart[];
  toolCalls: Record<string, TranscriptToolCall>;
  status: TranscriptTurnStatus;
  stopReason?: string;
  files?: WorkspaceFileInfo[];
  /** ISO 8601. */
  startedAt: string;
}

/** Una conversación en el listado del sidebar. */
export interface ConversationSummary {
  conversationId: string;
  title: string;
  /** El usuario le puso el título a mano (ya no se deriva del primer mensaje). */
  titleEdited: boolean;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  /** Turnos visibles. */
  turnCount: number;
  workspace: WorkspaceStatus | null;
}

/** Uso de contexto y modelo de una conversación (StatusBar). */
export interface ConversationStats {
  provider: string;
  model: string;
  context: { used: number; max: number; pct: number; estimated: boolean };
}

export interface ConversationOpenedFrame {
  type: 'conversation_opened';
  conversationId: string;
  /** Se cargó el historial de una sesión en disco. */
  resumed: boolean;
  /** Mensajes del historial rehidratado (sin el system prompt). */
  messageCount: number;
  /** Ausente si la conversación no tiene workspace (sin ficheros, como en D1). */
  workspace?: WorkspaceStatus;
  /** Lo que la UI tiene que pintar, incluido un turno aún en marcha o en cola (D4). */
  transcript?: TranscriptTurn[];
  /** Turno en marcha (o en cola) en el sidecar, si lo hay. */
  activeTurnId?: string | null;
  title?: string;
  todos?: TodoItem[];
  stats?: ConversationStats;
}

/** Cambió la retención del workspace (restaurando, uso, fijado) (D3). */
export interface WorkspaceStatusFrame {
  type: 'workspace_status';
  conversationId: string;
  status: WorkspaceStatus;
}

/** Listado completo de conversaciones, de la más reciente a la más antigua (D4). */
export interface ConversationsFrame {
  type: 'conversations';
  items: ConversationSummary[];
}

/** Cambió una conversación del listado (turno, título, fijado…). */
export interface ConversationUpdatedFrame {
  type: 'conversation_updated';
  summary: ConversationSummary;
}

export interface ConversationDeletedFrame {
  type: 'conversation_deleted';
  conversationId: string;
}

/** `/clear` aplicado: la conversación queda vacía. */
export interface ConversationClearedFrame {
  type: 'conversation_cleared';
  conversationId: string;
}

export interface ConversationStatsFrame {
  type: 'conversation_stats';
  conversationId: string;
  stats: ConversationStats;
}

/** Aviso informativo de una conversación (resultado de `/compact`, `/model`…). */
export interface ConversationNoticeFrame {
  type: 'conversation_notice';
  conversationId: string;
  tone: 'info' | 'warning';
  message: string;
}

export interface ModelsFrame {
  type: 'models';
  conversationId: string;
  current: string;
  models: string[];
  /** El provider no lista modelos: se puede escribir el nombre a mano. */
  error?: string;
}

/** El turno espera a que otra conversación termine (`desktop.maxConcurrentTurns`, 15.15). */
export interface TurnQueuedFrame {
  type: 'turn_queued';
  conversationId: string;
  turnId: string;
  /** 1 = el siguiente en arrancar. */
  position: number;
}

export interface TurnStartedFrame {
  type: 'turn_started';
  conversationId: string;
  turnId: string;
}

export interface DecisionSummary {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  importance: string;
  timestamp: string;
}

export interface MemoryStateFrame {
  type: 'memory_state';
  global: {
    path: string;
    exists: boolean;
    content: string;
    /** Versión leída; `null` si no existe. Se devuelve en `memory_save`. */
    mtimeMs: number | null;
  };
  decisions: DecisionSummary[];
}

export interface MemorySavedFrame {
  type: 'memory_saved';
  mtimeMs: number;
}

/** El `STRATUM.md` cambió en disco mientras se editaba: no se guardó. */
export interface MemoryConflictFrame {
  type: 'memory_conflict';
  content: string;
  mtimeMs: number | null;
}

export interface MemoryErrorFrame {
  type: 'memory_error';
  message: string;
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

export type ChatRejectReason =
  | 'busy'
  | 'unknown_conversation'
  | 'sidecar_unavailable'
  | 'bad_attachment';

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

/** Un fichero de `outputs/` del workspace (D2). `path` es relativo al workspace. */
export interface WorkspaceFileInfo {
  path: string;
  name: string;
  size: number;
  mime: string;
  /** ISO 8601. */
  modifiedAt: string;
}

/**
 * Ficheros que el agente creó o modificó en `outputs/` durante un turno. Llega
 * antes que el `turn_ended` de ese turno; sin cambios, no se envía.
 */
export interface WorkspaceFilesFrame {
  type: 'workspace_files';
  conversationId: string;
  turnId: string;
  files: WorkspaceFileInfo[];
}

/** Error de una trama de conversación que no se puede atribuir a un turno. */
export interface ConversationErrorFrame {
  type: 'conversation_error';
  conversationId: string;
  message: string;
}

export type ConversationOutboundFrame =
  | ConversationsFrame
  | ConversationUpdatedFrame
  | ConversationDeletedFrame
  | ConversationClearedFrame
  | ConversationStatsFrame
  | ConversationNoticeFrame
  | ModelsFrame
  | TurnQueuedFrame
  | TurnStartedFrame
  | MemoryStateFrame
  | MemorySavedFrame
  | MemoryConflictFrame
  | MemoryErrorFrame
  | ConversationOpenedFrame
  | ConversationClosedFrame
  | AgentEventFrame
  | TurnEndedFrame
  | ChatRejectedFrame
  | ConfirmRequestFrame
  | QuestionsRequestFrame
  | PromptResolvedFrame
  | WorkspaceFilesFrame
  | WorkspaceStatusFrame
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

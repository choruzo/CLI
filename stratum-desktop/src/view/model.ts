/**
 * Lo que pintan los componentes de chat (D1–D7). Desde M12 **no es estado**:
 * es una vista que se deriva, pura, de la foto de la sesión y del historial
 * (`view/chat.ts`). Si cambia la foto, se vuelve a derivar; nada se guarda.
 */

export type ToolCallState = 'pending' | 'running' | 'completed' | 'error';

export interface ToolCallView {
  id: string;
  name: string;
  state: ToolCallState;
  /** Lo que hace la llamada (la descripción que publica el anfitrión, ya redactada). */
  input: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

/** Trozos de una respuesta, en el orden en que llegaron. */
export type AgentPart =
  | { kind: 'text'; text: string }
  /** Razonamiento del modelo (D7): solo el del bloque abierto viaja en la foto. */
  | { kind: 'reasoning'; text: string; startedAt?: number; endedAt?: number }
  | { kind: 'tool'; id: string }
  | { kind: 'notice'; tone: 'warning' | 'error'; text: string };

export type TurnStatus = 'queued' | 'streaming' | 'done' | 'cancelled' | 'error' | 'interrupted';

/** Un adjunto enviado con un mensaje (D2): su ruta en la carpeta de la conversación. */
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

/** Un fichero que el agente dejó en `outputs/` (lo lista Rust, `workspace_files`). */
export interface WorkspaceFileInfo {
  path: string;
  name: string;
  size: number;
  mime: string;
  /** ISO 8601. */
  modifiedAt: string;
}

export interface AgentTurn {
  role: 'agent';
  turnId: string;
  parts: AgentPart[];
  toolCalls: Record<string, ToolCallView>;
  status: TurnStatus;
  stopReason?: string;
  /** Ficheros del turno (D2). Desde M12 se ven en el panel de ficheros. */
  files?: WorkspaceFileInfo[];
  queuePosition?: number;
}

export type ChatMessage = UserMessage | AgentTurn;

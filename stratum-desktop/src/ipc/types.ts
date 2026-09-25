/**
 * Tipos del canal con el sidecar. El protocolo tiene una única definición, en
 * stratum-cli (`src/desktop/protocol.ts`); aquí solo se reexporta y se añade lo
 * que es propio del shell Tauri (el estado de la conexión que publica Rust).
 */
export type {
  AgentEvent,
  ConversationFrame,
  ConversationOutboundFrame,
  CoreInfo,
  DestructiveDecision,
  NativeProbe,
  NativeModuleName,
  OutboundFrame as SidecarFrame,
  PingFrame,
  PongFrame,
  QuestionAnswer,
  QuestionItem,
  SidecarErrorFrame,
  SidecarErrorCode,
  WorkspaceFileInfo,
  WorkspaceStatus,
  ConversationSummary,
  ConversationStats,
  DecisionSummary,
  TranscriptTurn,
  TranscriptPart,
  TranscriptToolCall,
  TodoItem,
  ConfigApplied,
  ConfigIssue,
  ConfigSnapshot,
  DesktopOsPrefs,
} from '../../../stratum-cli/src/desktop/protocol';

export { SECRET_PLACEHOLDER } from '../../../stratum-cli/src/desktop/protocol';

import type {
  ConversationFrame,
  CoreInfo,
  NativeProbe,
  PingFrame,
  WorkspaceTouchFrame,
} from '../../../stratum-cli/src/desktop/protocol';

/** Espejo de `SidecarStatus` en `src-tauri/src/ipc.rs` (serde `tag = "state"`). */
export type SidecarStatus =
  | { state: 'starting' }
  | { state: 'connected'; core: CoreInfo; natives: NativeProbe[] }
  | { state: 'disconnected'; reason: string; exitCode: number | null }
  | {
      state: 'reconnecting';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { state: 'failed'; message: string };

/**
 * Lo que llega de Rust: el estado con su número de orden (`seq`, creciente).
 * Ausente en los tests que construyen estados a mano.
 */
export type StampedSidecarStatus = SidecarStatus & { seq?: number };

/**
 * Tramas que el frontend puede mandar al sidecar. Rust las filtra por tipo y
 * tamaño; `workspace_touch` solo lo emite Rust.
 */
export type ClientFrame = PingFrame | Exclude<ConversationFrame, WorkspaceTouchFrame>;

export const EVENT_STATUS = 'sidecar://status';
export const EVENT_READY = 'sidecar://ready';

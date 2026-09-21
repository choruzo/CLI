/**
 * Tipos del canal con el sidecar. El protocolo tiene una única definición, en
 * stratum-cli (`src/desktop/protocol.ts`); aquí solo se reexporta y se añade lo
 * que es propio del shell Tauri (el estado de la conexión que publica Rust).
 */
export type {
  CoreInfo,
  NativeProbe,
  NativeModuleName,
  OutboundFrame as SidecarFrame,
  PongFrame,
  SidecarErrorFrame,
  SidecarErrorCode,
} from '../../../stratum-cli/src/desktop/protocol';

import type { CoreInfo, NativeProbe } from '../../../stratum-cli/src/desktop/protocol';

/** Espejo de `SidecarStatus` en `src-tauri/src/ipc.rs` (serde `tag = "state"`). */
export type SidecarStatus =
  | { state: 'starting' }
  | { state: 'connected'; core: CoreInfo; natives: NativeProbe[] }
  | { state: 'disconnected'; reason: string; exitCode: number | null }
  | { state: 'failed'; message: string };

/** Tramas que el frontend puede mandar al sidecar en D0. */
export type ClientFrame = { type: 'ping'; id?: string };

export const EVENT_STATUS = 'sidecar://status';
export const EVENT_READY = 'sidecar://ready';

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
 */

/** Versión del protocolo del canal. Rust la comprueba en `handshake_ok`. */
export const DESKTOP_PROTOCOL_VERSION = 1;

/** Tiempo máximo para recibir el handshake tras aceptar una conexión. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Tope de una trama antes de autenticar: un handshake cabe de sobra en 4 KiB. */
export const MAX_UNAUTHENTICATED_FRAME_BYTES = 4 * 1024;

/** Tope de una trama autenticada (D1 enviará historiales completos en `rehydrate`). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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

export type InboundFrame = HandshakeFrame | PingFrame;

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

export interface SidecarErrorFrame {
  type: 'sidecar_error';
  fatal: boolean;
  code: SidecarErrorCode;
  message: string;
}

export type OutboundFrame = HandshakeOkFrame | HandshakeErrorFrame | PongFrame | SidecarErrorFrame;

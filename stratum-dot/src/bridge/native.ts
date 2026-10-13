/**
 * La frontera con el lado nativo (Rust). Es **todo** lo que el webview puede
 * pedir: una lista corta de funciones tipadas, cada una con su comando de
 * Tauri. No hay una función genérica para enviar un método cualquiera del
 * protocolo, y el webview nunca ve el token del canal, la ruta del pipe ni el
 * `endpoint.json`: conectar, autenticar y suscribirse es cosa de Rust
 * (`crates/dot-link`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Estado de la conexión con el daemon (`ConnectionState` en `dot-link/src/state.rs`). */
export type ConnectionState =
  | { kind: 'starting' }
  | { kind: 'daemon-starting' }
  | { kind: 'connecting' }
  | {
      kind: 'connected';
      serverVersion: string;
      serverPlatform: string;
      protocol: number;
      capabilities: string[];
      features: string[];
    }
  | { kind: 'reconnecting'; attempt: number }
  | {
      kind: 'incompatible';
      clientProtocol: number;
      daemonProtocol: number | null;
      daemonVersion: string | null;
    }
  | { kind: 'error'; message: string };

/**
 * Lo que llega del lado nativo. `snapshot` y `events` traen DTOs del protocolo
 * sin validar (`unknown`): quien los recibe los pasa por `protocol/apply.ts`.
 */
export type DotEvent =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'sessions'; sessionIds: string[] }
  | { type: 'snapshot'; sessionId: string; snapshot: unknown }
  | { type: 'events'; sessionId: string; events: unknown[] };

export interface AppInfo {
  dotVersion: string;
  /** Versión del protocolo que habla este Dot. */
  protocol: number;
  /** Si hay bandeja, cerrar la ventana la oculta; si no, sale de Dot. */
  trayAvailable: boolean;
}

export type CommandErrorKind = 'invalid' | 'not-sent' | 'unknown' | 'rejected';

/** Por qué no se pudo dar una orden (`CommandError` en `state.rs`). */
export interface CommandError {
  kind: CommandErrorKind;
  code: string | null;
  reason: string | null;
  message: string;
}

export function toCommandError(err: unknown): CommandError {
  if (typeof err === 'object' && err !== null && 'kind' in err && 'message' in err) {
    const e = err as Record<string, unknown>;
    return {
      kind: (['invalid', 'not-sent', 'unknown', 'rejected'] as const).includes(e.kind as CommandErrorKind)
        ? (e.kind as CommandErrorKind)
        : 'unknown',
      code: typeof e.code === 'string' ? e.code : null,
      reason: typeof e.reason === 'string' ? e.reason : null,
      message: String(e.message),
    };
  }
  return { kind: 'unknown', code: null, reason: null, message: typeof err === 'string' ? err : 'Unexpected error.' };
}

export interface NativeBridge {
  /**
   * La interfaz está lista. El estado de la conexión y una foto de cada sesión
   * llegan a continuación por `onEvent` (no en la respuesta: así no hay dos
   * fuentes que puedan llegar desordenadas).
   */
  attach(): Promise<AppInfo>;
  /** Volver a empezar: descubrir, arrancar el daemon si hace falta, conectar. */
  retry(): Promise<void>;
  /** Qué sesión se mira (la única que recibe el texto según se genera). */
  focusSession(sessionId: string | null): Promise<void>;
  /** Pedir una foto nueva de una sesión. */
  resyncSession(sessionId: string): Promise<void>;
  pauseRun(sessionId: string, runId?: string): Promise<string>;
  resumeRun(sessionId: string, runId?: string): Promise<string>;
  cancelRun(sessionId: string, runId?: string): Promise<string>;
  steerRun(sessionId: string, text: string): Promise<string>;
  hideWindow(): Promise<void>;
  /** Cierra Dot. El daemon y las sesiones siguen. */
  quit(): Promise<void>;
  onEvent(handler: (event: DotEvent) => void): Promise<() => void>;
}

/** Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado. */
export const DOT_EVENT = 'dot://event';

export const tauriBridge: NativeBridge = {
  attach: () => invoke<AppInfo>('dot_attach'),
  retry: () => invoke('dot_retry'),
  focusSession: (sessionId) => invoke('dot_focus_session', { sessionId }),
  resyncSession: (sessionId) => invoke('dot_resync_session', { sessionId }),
  pauseRun: (sessionId, runId) => invoke<string>('dot_pause_run', { sessionId, runId: runId ?? null }),
  resumeRun: (sessionId, runId) => invoke<string>('dot_resume_run', { sessionId, runId: runId ?? null }),
  cancelRun: (sessionId, runId) => invoke<string>('dot_cancel_run', { sessionId, runId: runId ?? null }),
  steerRun: (sessionId, text) => invoke<string>('dot_steer_run', { sessionId, text }),
  hideWindow: () => invoke('dot_hide'),
  quit: () => invoke('dot_quit'),
  onEvent: (handler) => listen<DotEvent>(DOT_EVENT, (e) => handler(e.payload)),
};

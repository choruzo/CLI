import { useCallback, useEffect, useReducer } from 'react';
import {
  getSidecarStatus,
  onSidecarStatus,
  sendSidecarFrame,
  subscribeSidecarFrames,
} from '../ipc/bridge';
import type { SidecarErrorFrame, SidecarFrame, SidecarStatus } from '../ipc/types';

export interface SidecarState {
  status: SidecarStatus;
  /** Errores que el sidecar reportó (config incompatible, protocolo…). */
  errors: SidecarErrorFrame[];
  /** Ida y vuelta del último ping contestado. */
  latencyMs: number | null;
  pendingPing: { id: string; sentAt: number } | null;
}

export type SidecarAction =
  | { type: 'status'; status: SidecarStatus }
  | { type: 'frame'; frame: SidecarFrame; now: number }
  | { type: 'ping_sent'; id: string; now: number };

export const initialSidecarState: SidecarState = {
  status: { state: 'starting' },
  errors: [],
  latencyMs: null,
  pendingPing: null,
};

export function sidecarReducer(state: SidecarState, action: SidecarAction): SidecarState {
  switch (action.type) {
    case 'status':
      return {
        ...state,
        status: action.status,
        // Un ping en vuelo no se va a contestar por una conexión que ya no existe.
        pendingPing: action.status.state === 'connected' ? state.pendingPing : null,
      };
    case 'ping_sent':
      return { ...state, pendingPing: { id: action.id, sentAt: action.now } };
    case 'frame': {
      const { frame } = action;
      if (frame.type === 'pong') {
        if (!state.pendingPing || frame.id !== state.pendingPing.id) return state;
        return { ...state, latencyMs: action.now - state.pendingPing.sentAt, pendingPing: null };
      }
      if (frame.type === 'sidecar_error') {
        // El sidecar reenvía su error de arranque a cada conexión: sin duplicados.
        if (state.errors.some((e) => e.code === frame.code && e.message === frame.message)) {
          return state;
        }
        return { ...state, errors: [...state.errors, frame] };
      }
      return state;
    }
  }
}

/** ¿Puede el agente trabajar? Conectado y sin errores fatales. */
export function isOperational(state: SidecarState): boolean {
  return state.status.state === 'connected' && !state.errors.some((e) => e.fatal);
}

let pingSeq = 0;

export function useSidecar(): SidecarState & { ping: () => void } {
  const [state, dispatch] = useReducer(sidecarReducer, initialSidecarState);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const setStatus = (status: SidecarStatus) => {
      if (!disposed) dispatch({ type: 'status', status });
    };

    void (async () => {
      // Primero escuchar y luego leer: un cambio entre ambos pasos no se pierde.
      unlisten = await onSidecarStatus(setStatus);
      await subscribeSidecarFrames((frame) => {
        if (!disposed) dispatch({ type: 'frame', frame, now: performance.now() });
      });
      setStatus(await getSidecarStatus());
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const ping = useCallback(() => {
    const id = `ping-${++pingSeq}`;
    dispatch({ type: 'ping_sent', id, now: performance.now() });
    void sendSidecarFrame({ type: 'ping', id });
  }, []);

  // Un ping automático al conectar: demuestra el camino completo de ida y vuelta.
  const connected = state.status.state === 'connected';
  useEffect(() => {
    if (connected) ping();
  }, [connected, ping]);

  return { ...state, ping };
}

import { useCallback, useEffect, useReducer } from 'react';
import {
  getSidecarStatus,
  onSidecarStatus,
  restartSidecar,
  sendSidecarFrame,
  subscribeSidecarFrames,
} from '../ipc/bridge';
import type {
  SidecarErrorFrame,
  SidecarFrame,
  SidecarStatus,
  StampedSidecarStatus,
} from '../ipc/types';

export interface SidecarState {
  status: SidecarStatus;
  /** `seq` del último estado aplicado: uno más viejo que llegue tarde se descarta. */
  statusSeq: number;
  /** Errores que el sidecar reportó (config incompatible, protocolo…). */
  errors: SidecarErrorFrame[];
  /** Ida y vuelta del último ping contestado. */
  latencyMs: number | null;
  pendingPing: { id: string; sentAt: number } | null;
}

export type SidecarAction =
  | { type: 'status'; status: StampedSidecarStatus }
  | { type: 'frame'; frame: SidecarFrame; now: number }
  | { type: 'ping_sent'; id: string; now: number };

export const initialSidecarState: SidecarState = {
  status: { state: 'starting' },
  statusSeq: -1,
  errors: [],
  latencyMs: null,
  pendingPing: null,
};

export function sidecarReducer(state: SidecarState, action: SidecarAction): SidecarState {
  switch (action.type) {
    case 'status': {
      // La respuesta de `sidecar_status` puede llegar después de un evento
      // más nuevo: sin esto, un «starting» viejo dejaba la UI esperando.
      const { seq, ...status } = action.status;
      if (seq !== undefined && seq <= state.statusSeq) return state;
      return {
        ...state,
        status: status as SidecarStatus,
        statusSeq: seq ?? state.statusSeq,
        // Un ping en vuelo no se va a contestar por una conexión que ya no existe.
        pendingPing: status.state === 'connected' ? state.pendingPing : null,
      };
    }
    case 'ping_sent':
      return { ...state, pendingPing: { id: action.id, sentAt: action.now } };
    case 'frame': {
      const { frame } = action;
      if (frame.type === 'pong') {
        if (!state.pendingPing || frame.id !== state.pendingPing.id) return state;
        return { ...state, latencyMs: action.now - state.pendingPing.sentAt, pendingPing: null };
      }
      // D5: una config que el sidecar consiguió aplicar retira el error de
      // config del arranque (se arregló en Ajustes o desde la CLI).
      if (frame.type === 'config_state' && frame.applied?.ok) {
        const errors = state.errors.filter(
          (e) => e.code !== 'config_invalid' && e.code !== 'schema_incompatible',
        );
        return errors.length === state.errors.length ? state : { ...state, errors };
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

export function useSidecar(): SidecarState & { ping: () => void; restart: () => void } {
  const [state, dispatch] = useReducer(sidecarReducer, initialSidecarState);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const setStatus = (status: StampedSidecarStatus) => {
      if (!disposed) dispatch({ type: 'status', status });
    };

    void (async () => {
      // Primero escuchar y luego leer: un cambio entre ambos pasos no se pierde.
      // Tras cada `await` se comprueba el desmontaje (StrictMode monta dos
      // veces): lo registrado después del cleanup se suelta en el acto.
      const u1 = await onSidecarStatus(setStatus);
      if (disposed) return u1();
      unlisten = u1;
      const u2 = await subscribeSidecarFrames((frame) => {
        if (!disposed) dispatch({ type: 'frame', frame, now: performance.now() });
      });
      if (disposed) return u2();
      unsubscribe = u2;
      setStatus(await getSidecarStatus());
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe?.();
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

  const restart = useCallback(() => {
    void restartSidecar().catch((err) => console.warn('[stratum] reintento fallido', err));
  }, []);

  return { ...state, ping, restart };
}

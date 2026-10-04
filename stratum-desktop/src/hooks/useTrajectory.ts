import { useEffect, useState } from 'react';
import { subscribeSidecarFrames } from '../ipc/bridge';
import type { SidecarFrame } from '../ipc/types';
import { isRecord, traceRecords } from '../ipc/validate';
import { applyRecords, emptyTrace, type TraceModel } from '../../../stratum-cli/src/trace/model';
import { post } from './useAgentStream';

const STORAGE_KEY = 'stratum.trajectory';

/** El panel se recuerda abierto o cerrado entre arranques (comodidad). */
export function loadTrajectoryOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveTrajectoryOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* no crítico */
  }
}

export interface Trajectory {
  model: TraceModel;
  /** Llegó la primera tanda: una traza vacía es «sin pasos», no «cargando». */
  loaded: boolean;
}

/**
 * Trayectoria de una conversación (protocolo v9). El sidecar la lee de la
 * traza que graba su runtime —el modelo no interviene— y la retransmite desde
 * el principio y según crece mientras el panel está abierto.
 */
export function useTrajectory(enabled: boolean, conversationId: string): Trajectory {
  const [state, setState] = useState<Trajectory>({ model: emptyTrace(), loaded: false });

  useEffect(() => {
    setState({ model: emptyTrace(), loaded: false });
    if (!enabled) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const onFrame = (frame: SidecarFrame) => {
      const f = frame as unknown;
      if (disposed || !isRecord(f) || f.type !== 'trace_records') return;
      if (f.conversationId !== conversationId) return;
      const records = traceRecords(f.records);
      if (!records) return;
      setState((prev) => ({
        model: applyRecords(f.reset === true ? emptyTrace() : prev.model, records),
        loaded: true,
      }));
    };
    void subscribeSidecarFrames(onFrame).then((u) => {
      if (disposed) {
        u();
        return;
      }
      unsubscribe = u;
      post({ type: 'trace_subscribe', conversationId });
    });
    return () => {
      disposed = true;
      unsubscribe?.();
      post({ type: 'trace_unsubscribe' });
    };
  }, [enabled, conversationId]);

  return state;
}

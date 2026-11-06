/**
 * La trayectoria de la sesión que se mira (panel de trayectoria): **proyección
 * para pintar**, como el resto de stores de Desktop. La verdad es la traza que
 * escribe el runtime de la sesión (`~/.stratum/traces/<id>.jsonl`) y que el
 * daemon retransmite (`trace.subscribe`); aquí solo se guarda lo último que
 * contó, reducido con el modelo del core (`applyRecords`). Nada se estima:
 * una cifra que la traza no trae sigue siendo «n/d» en el panel.
 *
 *   trace.records → enlace nativo (sobre) → este store (valida y reduce) → panel
 *
 * Reglas:
 *  - `reset: true` **sustituye** todo lo que se tuviera (es la autoridad: el
 *    enlace pide otra traza al reconectar y el daemon empieza por un reset);
 *    sin `reset`, solo se añade.
 *  - Solo se acepta lo de la sesión que se sigue: un lote de otra (llegado tras
 *    cambiar de sesión) se ignora.
 *  - Tope de registros ({@link MAX_TRACE_RECORDS}): una traza enorme no hace
 *    crecer la memoria del webview; al pasarlo se dice que está recortada.
 *  - No se guarda en disco.
 */
import { applyRecords, emptyTrace, TRACE_FORMAT_VERSION, type TraceModel } from '../trace';
import { parseTraceRecords } from '../trace/parse';
import { createStore } from './store';

/** Registros que se guardan como mucho de una traza. */
export const MAX_TRACE_RECORDS = 50_000;

export interface TraceState {
  /** La sesión cuya traza se sigue; `null` = ninguna. */
  sessionId: string | null;
  model: TraceModel;
  /** Llegó la primera tanda: una traza vacía es «sin pasos», no «cargando». */
  loaded: boolean;
  /** Registros guardados (para el tope). */
  count: number;
  /** Se dejaron registros fuera por el tope. */
  truncated: boolean;
  /** Registros que no cumplían la forma esperada y se descartaron. */
  rejected: number;
  /** Por qué no se puede seguir (`code`/`reason` del daemon o del enlace). */
  unavailable: { code: string; reason: string | null } | null;
}

function empty(sessionId: string | null): TraceState {
  return {
    sessionId,
    model: emptyTrace(),
    loaded: false,
    count: 0,
    truncated: false,
    rejected: 0,
    unavailable: null,
  };
}

export const traceStore = createStore<TraceState>(empty(null));

export interface TraceBatch {
  sessionId: string;
  reset: boolean;
  format: number;
  records: unknown;
}

export const traceActions = {
  /** Se sigue la traza de otra sesión (o de ninguna): lo anterior se olvida. */
  follow(sessionId: string | null): void {
    traceStore.set((s) => (s.sessionId === sessionId ? s : empty(sessionId)));
  },

  /** Un `trace.records` de la sesión que se sigue. */
  apply(batch: TraceBatch): void {
    traceStore.set((s) => {
      if (s.sessionId !== batch.sessionId) return s;
      // Un formato más nuevo: no se adivina lo que significa.
      if (batch.format > TRACE_FORMAT_VERSION) {
        return { ...empty(s.sessionId), unavailable: { code: 'FORMAT', reason: null } };
      }
      const parsed = parseTraceRecords(batch.records);
      if (!parsed) return { ...empty(s.sessionId), unavailable: { code: 'INVALID_TRACE', reason: null } };
      const base = batch.reset ? empty(s.sessionId) : s;
      const room = Math.max(0, MAX_TRACE_RECORDS - base.count);
      const kept = parsed.records.length > room ? parsed.records.slice(0, room) : parsed.records;
      return {
        ...base,
        model: applyRecords(base.model, kept),
        loaded: true,
        count: base.count + kept.length,
        truncated: base.truncated || kept.length < parsed.records.length,
        rejected: base.rejected + parsed.rejected,
        unavailable: null,
      };
    });
  },

  /** El daemon no puede (o dejó de poder) servir la traza de esa sesión. */
  unavailable(sessionId: string, code: string, reason: string | null): void {
    traceStore.set((s) =>
      s.sessionId === sessionId ? { ...empty(sessionId), unavailable: { code, reason } } : s,
    );
  },
};

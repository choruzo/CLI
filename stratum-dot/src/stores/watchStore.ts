import { create } from 'zustand';
import type { ProtocolWatch } from '../protocol';

/**
 * M22 — los vigilantes del asistente, tal como los contestó el daemon la última
 * vez (`watches.list`). Es una proyección para pintar: no se guarda en disco,
 * no se completa a mano y un fallo al refrescar deja la última lista conocida
 * (con su error al lado), nunca una inventada. Sin estado optimista: pausar,
 * reanudar o quitar se vuelve a pedir al daemon.
 */
interface WatchStore {
  /** `null` hasta que el daemon contesta la primera vez. */
  watches: ProtocolWatch[] | null;
  /** El almacén del daemon está en solo lectura: se ven, no se cambian. */
  readOnly: boolean;
  /** El daemon no tiene planificador de vigilantes (`watches-disabled`). */
  disabled: boolean;
  loading: boolean;
  /** Por qué falló el último refresco, o `null`. */
  error: string | null;
  setList(watches: ProtocolWatch[], readOnly: boolean): void;
  setFailure(error: string, disabled: boolean): void;
  setLoading(loading: boolean): void;
  reset(): void;
}

export const useWatches = create<WatchStore>((set) => ({
  watches: null,
  readOnly: false,
  disabled: false,
  loading: false,
  error: null,
  setList: (watches, readOnly) => set({ watches, readOnly, disabled: false, error: null }),
  setFailure: (error, disabled) => set({ error, disabled }),
  setLoading: (loading) => set({ loading }),
  reset: () => set({ watches: null, readOnly: false, disabled: false, loading: false, error: null }),
}));

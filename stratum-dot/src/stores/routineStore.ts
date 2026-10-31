import { create } from 'zustand';
import type { ProtocolRoutine } from '../protocol';

/**
 * M16 — las rutinas del asistente, tal como las contestó el daemon la última
 * vez (`routines.list`, o la respuesta de una mutación). Es una proyección para
 * pintar: no se guarda en disco, no se completa a mano y un fallo al refrescar
 * deja la última lista conocida (con su error al lado), nunca una inventada.
 */
interface RoutineStore {
  /** `null` hasta que el daemon contesta la primera vez. */
  routines: ProtocolRoutine[] | null;
  /** El almacén del daemon está en solo lectura: se ven, no se cambian. */
  readOnly: boolean;
  /** El daemon no tiene planificador (`routines-disabled`). */
  disabled: boolean;
  loading: boolean;
  /** Por qué falló el último refresco, o `null`. */
  error: string | null;
  setList(routines: ProtocolRoutine[], readOnly: boolean): void;
  setFailure(error: string, disabled: boolean): void;
  setLoading(loading: boolean): void;
  /** La respuesta de una mutación (`add`, `update`, `run`): esa rutina, tal como la dejó el daemon. */
  upsert(routine: ProtocolRoutine): void;
  /** La respuesta de `routines.remove`. */
  drop(routineId: string): void;
  reset(): void;
}

export const useRoutines = create<RoutineStore>((set) => ({
  routines: null,
  readOnly: false,
  disabled: false,
  loading: false,
  error: null,
  setList: (routines, readOnly) => set({ routines, readOnly, disabled: false, error: null }),
  setFailure: (error, disabled) => set({ error, disabled }),
  setLoading: (loading) => set({ loading }),
  upsert: (routine) =>
    set((prev) => {
      const list = prev.routines ?? [];
      return {
        routines: list.some((r) => r.id === routine.id)
          ? list.map((r) => (r.id === routine.id ? routine : r))
          : [...list, routine],
      };
    }),
  drop: (routineId) => set((prev) => ({ routines: prev.routines?.filter((r) => r.id !== routineId) ?? null })),
  reset: () => set({ routines: null, readOnly: false, disabled: false, loading: false, error: null }),
}));

/** El nombre de la rutina de una sesión, de la última lista conocida; `null` si no se conoce. */
export function routineNameOf(routines: ProtocolRoutine[] | null, routineId: string): string | null {
  return routines?.find((r) => r.id === routineId)?.name ?? null;
}

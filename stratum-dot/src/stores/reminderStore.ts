import { create } from 'zustand';
import type { ProtocolReminder } from '../protocol';

/**
 * M21 — los recordatorios del asistente, tal como los contestó el daemon la
 * última vez (`reminders.list`, o la respuesta de una cancelación). Es una
 * proyección para pintar: no se guarda en disco, no se completa a mano y un
 * fallo al refrescar deja la última lista conocida (con su error al lado),
 * nunca una inventada.
 */
interface ReminderStore {
  /** `null` hasta que el daemon contesta la primera vez. */
  reminders: ProtocolReminder[] | null;
  /** El almacén del daemon está en solo lectura: se ven, no se cancelan. */
  readOnly: boolean;
  /** El daemon no tiene planificador de recordatorios (`reminders-disabled`). */
  disabled: boolean;
  loading: boolean;
  /** Por qué falló el último refresco, o `null`. */
  error: string | null;
  setList(reminders: ProtocolReminder[], readOnly: boolean): void;
  setFailure(error: string, disabled: boolean): void;
  setLoading(loading: boolean): void;
  /** La respuesta de `reminders.cancel`: ese recordatorio, tal como lo dejó el daemon. */
  upsert(reminder: ProtocolReminder): void;
  reset(): void;
}

export const useReminders = create<ReminderStore>((set) => ({
  reminders: null,
  readOnly: false,
  disabled: false,
  loading: false,
  error: null,
  setList: (reminders, readOnly) => set({ reminders, readOnly, disabled: false, error: null }),
  setFailure: (error, disabled) => set({ error, disabled }),
  setLoading: (loading) => set({ loading }),
  upsert: (reminder) =>
    set((prev) => {
      const list = prev.reminders ?? [];
      return {
        reminders: list.some((r) => r.id === reminder.id)
          ? list.map((r) => (r.id === reminder.id ? reminder : r))
          : [...list, reminder],
      };
    }),
  reset: () => set({ reminders: null, readOnly: false, disabled: false, loading: false, error: null }),
}));

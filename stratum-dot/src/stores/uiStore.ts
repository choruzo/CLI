import { create } from 'zustand';
import type { ProtocolRun, ProtocolRunStatus } from '../protocol';

/**
 * Estado **de la interfaz**: qué sesión se mira, qué orden se acaba de dar y
 * qué contestó el daemon. Nada de aquí es estado del runtime, y lo único que se
 * guarda entre arranques es una preferencia (la última sesión seleccionada).
 */

export type ControlKind = 'pause' | 'resume' | 'cancel';

/**
 * Una orden que el daemon aceptó y cuyo efecto aún no ha llegado por eventos.
 * Sirve para decir «Pause requested»; **no** cambia el estado que se enseña del
 * run, que sigue siendo el que publica su anfitrión.
 */
export interface PendingControl {
  kind: ControlKind;
  runId: string;
  /** Estado del run cuando se dio la orden: deja de estar pendiente en cuanto cambia. */
  fromStatus: ProtocolRunStatus;
  at: number;
}

export interface Notice {
  text: string;
  tone: 'info' | 'error';
  at: number;
}

/** Cuánto se enseña una orden pendiente sin que el estado cambie. */
export const PENDING_TTL_MS = 60_000;

const SELECTED_KEY = 'stratum-dot.selectedSession';

function readSelected(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function writeSelected(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(SELECTED_KEY, id);
    else window.localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* sin almacenamiento, la preferencia no se recuerda */
  }
}

interface UiStore {
  selectedId: string | null;
  pending: Record<string, PendingControl>;
  notices: Record<string, Notice>;
  select(id: string | null): void;
  setPending(sessionId: string, pending: PendingControl | null): void;
  setNotice(sessionId: string, notice: Omit<Notice, 'at'> | null): void;
}

export const useUi = create<UiStore>((set) => ({
  selectedId: readSelected(),
  pending: {},
  notices: {},
  select: (id) => {
    writeSelected(id);
    set({ selectedId: id });
  },
  setPending: (sessionId, pending) =>
    set((prev) => {
      const next = { ...prev.pending };
      if (pending) next[sessionId] = pending;
      else delete next[sessionId];
      return { pending: next };
    }),
  setNotice: (sessionId, notice) =>
    set((prev) => {
      const next = { ...prev.notices };
      if (notice) next[sessionId] = { ...notice, at: Date.now() };
      else delete next[sessionId];
      return { notices: next };
    }),
}));

/**
 * ¿Sigue pendiente esa orden? Se deriva del run que publica el anfitrión: en
 * cuanto el run cambia de estado (o es otro), ya no lo está. No hay que
 * «limpiar» nada a mano ni adivinar el resultado.
 */
export function activePending(
  pending: PendingControl | undefined,
  run: ProtocolRun | null,
  now: number,
): PendingControl | null {
  if (!pending || !run) return null;
  if (run.id !== pending.runId || run.status !== pending.fromStatus) return null;
  return now - pending.at < PENDING_TTL_MS ? pending : null;
}

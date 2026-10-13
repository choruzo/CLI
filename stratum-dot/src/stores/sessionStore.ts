import { create } from 'zustand';
import { appendActivity, describeEvent, resyncMark, type ActivityEntry } from '../protocol/activity';
import { applyEvents, parseSnapshot } from '../protocol/apply';
import { isStateEvent, type ProtocolSessionSnapshot } from '../protocol';

/**
 * Proyección para pintar: una foto por sesión viva, que **sustituye** cada foto
 * nueva y avanza con el reductor del protocolo. No es la fuente de verdad —lo
 * es el anfitrión de cada sesión— y no se guarda en ningún sitio: al recargar,
 * se pide todo otra vez.
 */
export interface SessionEntry {
  /** `null` hasta que llega la primera foto. */
  snapshot: ProtocolSessionSnapshot | null;
  /** Lo último que pasó, para leer. No es estado. */
  activity: ActivityEntry[];
  /** La última foto no cumplía el contrato: no se pinta nada inventado. */
  unreadable: boolean;
}

interface SessionStore {
  /** Sesiones vivas, en el orden que da el daemon. */
  order: string[];
  sessions: Record<string, SessionEntry>;
  /** El daemon ya dijo alguna vez qué sesiones hay: antes de eso, «no está» no significa nada. */
  listed: boolean;
  /** El daemon dice qué sesiones hay: las que no estén dejan de existir aquí. */
  setSessions(ids: string[]): void;
  /** Una foto sustituye lo que se tuviera de esa sesión. */
  applySnapshot(sessionId: string, raw: unknown): void;
  /** Aplica un lote. Devuelve `true` si hay que pedir una foto nueva. */
  applyEvents(sessionId: string, raws: unknown[]): boolean;
  reset(): void;
}

const EMPTY: SessionEntry = { snapshot: null, activity: [], unreadable: false };

export const useSessions = create<SessionStore>((set, get) => ({
  order: [],
  sessions: {},
  listed: false,

  setSessions: (ids) =>
    set((prev) => {
      const sessions: Record<string, SessionEntry> = {};
      for (const id of ids) sessions[id] = prev.sessions[id] ?? EMPTY;
      return { order: ids, sessions, listed: true };
    }),

  applySnapshot: (sessionId, raw) =>
    set((prev) => {
      const known = prev.sessions[sessionId];
      // Una foto de una sesión que el daemon ya no lista llega tarde.
      if (!known) return prev;
      const snapshot = parseSnapshot(raw);
      if (!snapshot || snapshot.session.id !== sessionId) {
        return { sessions: { ...prev.sessions, [sessionId]: { ...known, snapshot: null, unreadable: true } } };
      }
      // Solo se anota cuando la foto salta por encima de eventos que no se vieron
      // (reconexión, hueco). Una foto con el mismo `seq` no cambia nada.
      const jumped = known.snapshot !== null && known.snapshot.seq !== snapshot.seq;
      const activity = jumped
        ? appendActivity(known.activity, [resyncMark(snapshot.session.updatedAt)])
        : known.activity;
      return { sessions: { ...prev.sessions, [sessionId]: { snapshot, activity, unreadable: false } } };
    }),

  applyEvents: (sessionId, raws) => {
    const known = get().sessions[sessionId];
    // Sin foto no hay de dónde partir: los eventos no construyen estado.
    if (!known?.snapshot) return false;
    const result = applyEvents(known.snapshot, raws);
    const lines = result.applied
      .filter(isStateEvent)
      .map(describeEvent)
      .filter((line): line is ActivityEntry => line !== null);
    if (result.snapshot !== known.snapshot || lines.length > 0) {
      set((prev) => ({
        sessions: {
          ...prev.sessions,
          [sessionId]: {
            snapshot: result.snapshot,
            activity: appendActivity(known.activity, lines),
            unreadable: false,
          },
        },
      }));
    }
    return result.needsResync;
  },

  reset: () => set({ order: [], sessions: {}, listed: false }),
}));

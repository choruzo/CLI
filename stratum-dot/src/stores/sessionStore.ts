import { create } from 'zustand';
import { appendActivity, describeEvent, resyncMark, type ActivityEntry } from '../protocol/activity';
import { applyEvents, parseSnapshot } from '../protocol/apply';
import { OUTCOMES_LIMIT, outcomesOf, type Outcome } from '../protocol/interactions';
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
  /**
   * Cómo acabaron las solicitudes que se vieron resolverse (sus `*.resolved`).
   * Para decirlo cuando ya no están pendientes; **no** es lo pendiente —eso es
   * la foto— y se pierde sin consecuencias.
   */
  outcomes: Outcome[];
}

interface SessionStore {
  /** Sesiones vivas, en el orden que da el daemon. */
  order: string[];
  sessions: Record<string, SessionEntry>;
  /** El daemon ya dijo alguna vez qué sesiones hay: antes de eso, «no está» no significa nada. */
  listed: boolean;
  /** Sesiones vivas que Dot no sigue porque ya sigue el máximo: la lista es parcial. */
  unfollowed: number;
  /** El daemon dice qué sesiones hay: las que no estén dejan de existir aquí. */
  setSessions(ids: string[], unfollowed?: number): void;
  /** Una foto sustituye lo que se tuviera de esa sesión. */
  applySnapshot(sessionId: string, raw: unknown): void;
  /** Aplica un lote. Devuelve `true` si hay que pedir una foto nueva. */
  applyEvents(sessionId: string, raws: unknown[]): boolean;
  reset(): void;
}

const EMPTY: SessionEntry = { snapshot: null, activity: [], unreadable: false, outcomes: [] };

export const useSessions = create<SessionStore>((set, get) => ({
  order: [],
  sessions: {},
  listed: false,
  unfollowed: 0,

  setSessions: (ids, unfollowed = 0) =>
    set((prev) => {
      const sessions: Record<string, SessionEntry> = {};
      for (const id of ids) sessions[id] = prev.sessions[id] ?? EMPTY;
      return { order: ids, sessions, listed: true, unfollowed };
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
      return { sessions: { ...prev.sessions, [sessionId]: { ...known, snapshot, activity, unreadable: false } } };
    }),

  applyEvents: (sessionId, raws) => {
    const known = get().sessions[sessionId];
    // Sin foto no hay de dónde partir: los eventos no construyen estado.
    if (!known?.snapshot) return false;
    const result = applyEvents(known.snapshot, raws);
    const states = result.applied.filter(isStateEvent);
    const lines = states.map(describeEvent).filter((line): line is ActivityEntry => line !== null);
    const resolved = outcomesOf(known.snapshot, states);
    if (result.snapshot !== known.snapshot || lines.length > 0) {
      set((prev) => ({
        sessions: {
          ...prev.sessions,
          [sessionId]: {
            snapshot: result.snapshot,
            activity: appendActivity(known.activity, lines),
            unreadable: false,
            outcomes:
              resolved.length > 0 ? [...known.outcomes, ...resolved].slice(-OUTCOMES_LIMIT) : known.outcomes,
          },
        },
      }));
    }
    return result.needsResync;
  },

  reset: () => set({ order: [], sessions: {}, listed: false, unfollowed: 0 }),
}));

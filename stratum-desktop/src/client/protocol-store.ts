/**
 * Estado del protocolo en Desktop (M12): **proyección para pintar**, no fuente
 * de verdad. La verdad es el anfitrión de cada sesión y la publica `stratumd`;
 * aquí solo se guarda lo último que contó, validado con el contrato y avanzado
 * con sus reductores (`applyOverviewEvent`, `followSession`). Nada se escribe
 * a mano ni se adelanta: una foto nueva **sustituye**, y tras reconectar manda
 * la foto. No se guarda en disco: al abrir Desktop se pide todo otra vez.
 *
 *   Stratum Protocol → protocol-store (este) → vista derivada (`view/`) → UI
 *
 * Tres capas, como pide `docs/STRATUM_CLIENT_ARCHITECTURE.md` §4:
 *  - **estado operativo** de todas las sesiones: la foto de conjunto;
 *  - la **conversación** solo de la que se mira (`focused`), por su foto;
 *  - el **historial completo** bajo demanda (`history`, páginas de
 *    `sessions.history`), solo cuando se pide.
 */
import type { ConnectionState } from '../ipc/native';
import {
  EMPTY_OVERVIEW,
  applyOverviewEvent,
  followSession,
  type ProtocolChatMessage,
  type ProtocolOverviewSnapshot,
  type ProtocolSessionSnapshot,
} from '../protocol';
import { classifyEvent, parseOverviewSnapshot, parseSessionSnapshot } from '../protocol/results';
import { createStore } from './store';

export interface FocusedSession {
  sessionId: string;
  /** `null` hasta que llega su primera foto. */
  snapshot: ProtocolSessionSnapshot | null;
  /** La última foto no cumplía el contrato: no se pinta nada inventado. */
  unreadable: boolean;
}

/**
 * Lo anterior a lo que trae la foto de la sesión enfocada, de
 * `sessions.history`. `older` es **contiguo** con la foto: termina justo antes
 * de su primer mensaje (si se pierde la continuidad, se descarta entero).
 */
export interface HistoryState {
  sessionId: string;
  older: ProtocolChatMessage[];
  /** El daemon tiene más antiguo que `older`. */
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export interface ProtocolState {
  connection: ConnectionState;
  /** El daemon ya dijo alguna vez qué sesiones hay: antes, «no está» no significa nada. */
  listed: boolean;
  overview: ProtocolOverviewSnapshot;
  /** La foto de conjunto que llegó no cumplía el contrato. */
  overviewUnreadable: boolean;
  focused: FocusedSession | null;
  history: HistoryState | null;
}

export const initialProtocolState: ProtocolState = {
  connection: { kind: 'starting' },
  listed: false,
  overview: EMPTY_OVERVIEW,
  overviewUnreadable: false,
  focused: null,
  history: null,
};

export const protocolStore = createStore<ProtocolState>(initialProtocolState);

/** `m<seq>` → `seq`; los ids de la conversación crecen con la sesión. */
export function messageSeq(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Lo que la foto nueva ya no lleva por antiguo pasa a `older`, para que una
 * conversación larga que se está mirando no pierda su principio al crecer.
 * Si la foto nueva no empalma con la anterior (una resincronización que saltó
 * mensajes), `older` ya no es contiguo y se descarta: se puede volver a pedir.
 */
export function carryOver(
  history: HistoryState | null,
  prev: ProtocolSessionSnapshot | null,
  next: ProtocolSessionSnapshot,
): HistoryState | null {
  if (!history || history.sessionId !== next.session.id) return history;
  if (!prev || prev.messages.length === 0) return history;
  const firstNext = next.messages[0];
  if (!firstNext) return history;
  const nextStart = messageSeq(firstNext.id);
  const prevEnd = messageSeq(prev.messages[prev.messages.length - 1]!.id);
  // Sin solape: entre las dos fotos pudo haber mensajes que no se vieron.
  if (Number.isNaN(nextStart) || Number.isNaN(prevEnd) || nextStart > prevEnd) {
    if (prev.messages.some((m) => m.id === firstNext.id)) return history;
    return { ...history, older: [], hasMore: true, error: null };
  }
  const dropped = prev.messages.filter((m) => messageSeq(m.id) < nextStart);
  if (dropped.length === 0) return history;
  const known = new Set(history.older.map((m) => m.id));
  return { ...history, older: [...history.older, ...dropped.filter((m) => !known.has(m.id))] };
}

export const protocolActions = {
  setConnection(connection: ConnectionState): void {
    protocolStore.set((s) => ({ ...s, connection }));
  },

  /** La foto de conjunto sustituye la anterior. */
  applyOverview(raw: unknown): void {
    const overview = parseOverviewSnapshot(raw);
    protocolStore.set((s) =>
      overview
        ? { ...s, overview, listed: true, overviewUnreadable: false }
        : { ...s, overviewUnreadable: true },
    );
  },

  /** Eventos de la suscripción de conjunto: saltos de `seq` normales. */
  applyOverviewEvents(raws: unknown[]): void {
    protocolStore.set((s) => {
      let overview = s.overview;
      for (const raw of raws) {
        const parsed = classifyEvent(raw);
        if (parsed.kind === 'event') overview = applyOverviewEvent(overview, parsed.event);
      }
      return overview === s.overview ? s : { ...s, overview };
    });
  },

  /** El daemon dijo qué sesiones hay (la membresía la lleva el enlace). */
  setListed(): void {
    protocolStore.set((s) => (s.listed ? s : { ...s, listed: true }));
  },

  /** Se mira otra sesión: lo de la anterior se olvida (su historial también). */
  focus(sessionId: string | null): void {
    protocolStore.set((s) => {
      if ((s.focused?.sessionId ?? null) === sessionId) return s;
      return {
        ...s,
        focused: sessionId ? { sessionId, snapshot: null, unreadable: false } : null,
        history: null,
      };
    });
  },

  /** Una foto de la sesión enfocada. Una de otra (llega tarde) se ignora. */
  applySnapshot(sessionId: string, raw: unknown): void {
    protocolStore.set((s) => {
      if (s.focused?.sessionId !== sessionId) return s;
      const snapshot = parseSessionSnapshot(raw);
      if (!snapshot || snapshot.session.id !== sessionId) {
        return { ...s, focused: { sessionId, snapshot: null, unreadable: true } };
      }
      return {
        ...s,
        focused: { sessionId, snapshot, unreadable: false },
        history: carryOver(s.history, s.focused.snapshot, snapshot),
      };
    });
  },

  /** Aplica un lote. Devuelve `true` si hay que pedir una foto nueva (nunca se remienda). */
  applyEvents(sessionId: string, raws: unknown[]): boolean {
    const s = protocolStore.get();
    const prev = s.focused?.sessionId === sessionId ? s.focused.snapshot : null;
    if (!prev) return false;
    const result = followSession(prev, raws.map(classifyEvent));
    if (result.snapshot !== prev) {
      protocolStore.set((cur) =>
        cur.focused?.sessionId !== sessionId
          ? cur
          : {
              ...cur,
              focused: { sessionId, snapshot: result.snapshot, unreadable: false },
              history: carryOver(cur.history, prev, result.snapshot),
            },
      );
    }
    return result.needsResync;
  },

  /** Empieza (o retoma) el historial de la sesión enfocada. */
  beginHistory(sessionId: string): boolean {
    const s = protocolStore.get();
    if (s.focused?.sessionId !== sessionId) return false;
    if (s.history?.sessionId === sessionId && s.history.loading) return false;
    protocolStore.set((cur) => ({
      ...cur,
      history:
        cur.history?.sessionId === sessionId
          ? { ...cur.history, loading: true, error: null }
          : { sessionId, older: [], hasMore: true, loading: true, error: null },
    }));
    return true;
  },

  /**
   * Una página que llega. Si mientras tanto se cambió de sesión, o la página no
   * empalma con lo que hay (`before` ya no es el primero), se descarta.
   */
  addHistoryPage(sessionId: string, before: string, messages: ProtocolChatMessage[], hasMore: boolean): void {
    protocolStore.set((s) => {
      if (s.focused?.sessionId !== sessionId || s.history?.sessionId !== sessionId) return s;
      const first = s.history.older[0] ?? s.focused.snapshot?.messages[0];
      if (!first || first.id !== before) return { ...s, history: { ...s.history, loading: false } };
      return {
        ...s,
        history: { ...s.history, older: [...messages, ...s.history.older], hasMore, loading: false, error: null },
      };
    });
  },

  historyFailed(sessionId: string, error: string): void {
    protocolStore.set((s) =>
      s.history?.sessionId !== sessionId ? s : { ...s, history: { ...s.history, loading: false, error } },
    );
  },

  reset(): void {
    protocolStore.set(initialProtocolState);
  },
};

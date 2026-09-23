import type { ConversationSummary } from '../ipc/types';
import {
  conversationReducer,
  initialConversationState,
  type ConversationAction,
  type ConversationState,
} from './conversation-reducer';

/**
 * Estado de todas las conversaciones del webview (D4). Reducer puro.
 *
 * - `list`: el listado del sidebar, tal como lo manda el sidecar
 *   (`conversations`, `conversation_updated`, `conversation_deleted`).
 * - `byId`: el estado de chat de cada conversación que se ha abierto en esta
 *   sesión del webview. Una conversación que genera en segundo plano sigue
 *   recibiendo sus eventos aquí aunque no sea la activa.
 * - `open`: conversaciones abiertas en el sidecar (se mandó `new_conversation`
 *   y no se ha cerrado). Una que deja de ser la activa y no tiene turno ni
 *   pregunta pendiente se cierra, para que la retención pueda volver a tocarla.
 */
export interface ConversationsState {
  list: ConversationSummary[];
  listLoaded: boolean;
  byId: Record<string, ConversationState>;
  open: Record<string, true>;
  activeId: string;
}

export type ConversationsAction =
  | { type: 'conv'; id: string; action: ConversationAction }
  | { type: 'list'; items: ConversationSummary[] }
  | { type: 'summary'; summary: ConversationSummary }
  | { type: 'deleted'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'mark_open'; id: string; open: boolean }
  /** El sidecar se cayó: todo lo abierto se cerró con él. */
  | { type: 'connection_lost' };

export function initialConversationsState(activeId: string): ConversationsState {
  return { list: [], listLoaded: false, byId: {}, open: {}, activeId };
}

/** ¿La conversación tiene algo en marcha que impida cerrarla en el sidecar? */
export function isBusy(c: ConversationState | undefined): boolean {
  return !!c && (c.activeTurnId !== null || c.pendingQuestions !== null || c.pendingConfirm !== null);
}

/** ¿Necesita al usuario (pregunta o confirmación pendiente)? */
export function needsAttention(c: ConversationState | undefined): boolean {
  return !!c && (c.pendingQuestions !== null || c.pendingConfirm !== null);
}

function sortList(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function conversationsReducer(
  state: ConversationsState,
  action: ConversationsAction,
): ConversationsState {
  switch (action.type) {
    case 'conv': {
      const current = state.byId[action.id] ?? initialConversationState;
      const next = conversationReducer(current, action.action);
      if (next === current) return state;
      return { ...state, byId: { ...state.byId, [action.id]: next } };
    }
    case 'list':
      return { ...state, list: sortList(action.items), listLoaded: true };
    case 'summary': {
      const others = state.list.filter((c) => c.conversationId !== action.summary.conversationId);
      return { ...state, list: sortList([...others, action.summary]) };
    }
    case 'deleted': {
      const byId = { ...state.byId };
      delete byId[action.id];
      const open = { ...state.open };
      delete open[action.id];
      return {
        ...state,
        byId,
        open,
        list: state.list.filter((c) => c.conversationId !== action.id),
      };
    }
    case 'activate':
      return state.activeId === action.id ? state : { ...state, activeId: action.id };
    case 'mark_open': {
      const open = { ...state.open };
      if (action.open) open[action.id] = true;
      else delete open[action.id];
      return { ...state, open };
    }
    case 'connection_lost': {
      const byId: Record<string, ConversationState> = {};
      for (const [id, c] of Object.entries(state.byId)) {
        byId[id] = conversationReducer(c, { type: 'connection_lost' });
      }
      return { ...state, byId, open: {} };
    }
  }
}

/**
 * Conversaciones abiertas en el sidecar que ya no hacen falta: no son la
 * activa, están abiertas del todo y no tienen turno ni pregunta pendiente.
 */
export function idleBackground(state: ConversationsState): string[] {
  return Object.keys(state.open).filter((id) => {
    if (id === state.activeId) return false;
    const c = state.byId[id];
    return !c || (c.opened && !isBusy(c));
  });
}

export type DateGroup = 'Hoy' | 'Ayer' | 'Últimos 7 días' | 'Anteriores';

/** Grupo de fecha del sidebar (§7.1). Los vacíos no se pintan. */
export function dateGroup(iso: string, now: Date): DateGroup {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const t = d.getTime();
  if (t >= startOfToday) return 'Hoy';
  if (t >= startOfToday - day) return 'Ayer';
  if (t >= startOfToday - 6 * day) return 'Últimos 7 días';
  return 'Anteriores';
}

export function groupByDate(
  list: ConversationSummary[],
  now: Date,
): { group: DateGroup; items: ConversationSummary[] }[] {
  const order: DateGroup[] = ['Hoy', 'Ayer', 'Últimos 7 días', 'Anteriores'];
  const groups = new Map<DateGroup, ConversationSummary[]>();
  for (const c of list) {
    const g = dateGroup(c.updatedAt, now);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return order.flatMap((group) => {
    const items = groups.get(group);
    return items?.length ? [{ group, items }] : [];
  });
}

/** Filtro de la búsqueda del sidebar: subcadena del título, sin mayúsculas ni tildes. */
export function matchesSearch(title: string, query: string): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  return norm(title).includes(norm(query.trim()));
}

/** «hace 5 min», «hace 2 h», «12 mar», «3 feb 2025» (§7.1). */
export function relativeDate(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24 && dateGroup(iso, now) === 'Hoy') return `hace ${h} h`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('es', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

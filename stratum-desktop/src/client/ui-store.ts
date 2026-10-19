/**
 * Estado de la **interfaz** (M12): qué se mira, qué se ha pedido y aún no se
 * ve en la foto, y avisos. Nada de aquí es estado de una sesión: lo que se
 * pidió se anota como **pendiente** («Enviando…», «Pausa pedida…») y deja de
 * estarlo cuando el anfitrión publica el cambio (o el daemon lo rechaza). La
 * interfaz nunca pinta primero el resultado esperando a que el daemon lo
 * alcance.
 *
 *   petición → pendiente en la UI → respuesta/evento del daemon → foto
 *
 * Lo único que se guarda (localStorage) es la última sesión seleccionada: una
 * preferencia de la interfaz, no estado de nadie.
 */
import { createStore } from './store';

export type ControlKind = 'pause' | 'resume' | 'cancel' | 'steer';

/** Algo pedido al daemon que aún no se ve en la foto. */
export type PendingRequest =
  | { kind: 'new-chat' }
  /** `runId`: el que devolvió `runs.start`; `null` mientras no hay respuesta. */
  | { kind: 'send'; sessionId: string; runId: string | null }
  | { kind: 'control'; sessionId: string; action: ControlKind; runId: string | null }
  | { kind: 'close'; sessionId: string }
  | { kind: 'set-model'; sessionId: string };

export type NoticeTone = 'info' | 'warning' | 'error';

export interface Notice {
  id: number;
  /** De qué sesión es; `null` = de la app. */
  sessionId: string | null;
  tone: NoticeTone;
  text: string;
}

export interface UiState {
  selectedId: string | null;
  pending: PendingRequest[];
  notices: Notice[];
}

const SELECTED_KEY = 'stratum.desktop.selectedSession';

function loadSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function saveSelected(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* sin almacenamiento: solo se pierde la preferencia */
  }
}

export const uiStore = createStore<UiState>({ selectedId: loadSelected(), pending: [], notices: [] });

let noticeIds = 0;

const samePending = (a: PendingRequest, b: PendingRequest): boolean =>
  a.kind === b.kind &&
  ('sessionId' in a ? a.sessionId : null) === ('sessionId' in b ? b.sessionId : null) &&
  (a.kind !== 'control' || (b.kind === 'control' && a.action === b.action));

export const uiActions = {
  select(sessionId: string | null): void {
    saveSelected(sessionId);
    uiStore.set((s) => (s.selectedId === sessionId ? s : { ...s, selectedId: sessionId }));
  },

  /** `false` si ya había una igual en vuelo (no se pide dos veces). */
  begin(request: PendingRequest): boolean {
    if (uiStore.get().pending.some((p) => samePending(p, request))) return false;
    uiStore.set((s) => ({ ...s, pending: [...s.pending, request] }));
    return true;
  },

  update(request: PendingRequest, next: PendingRequest): void {
    uiStore.set((s) => ({ ...s, pending: s.pending.map((p) => (samePending(p, request) ? next : p)) }));
  },

  end(request: PendingRequest): void {
    uiStore.set((s) => ({ ...s, pending: s.pending.filter((p) => !samePending(p, request)) }));
  },

  /** Lo pendiente que la foto ya alcanzó (o que ya no puede alcanzar) se retira. */
  settle(keep: (request: PendingRequest) => boolean): void {
    uiStore.set((s) => {
      const pending = s.pending.filter(keep);
      return pending.length === s.pending.length ? s : { ...s, pending };
    });
  },

  notify(sessionId: string | null, tone: NoticeTone, text: string): void {
    const id = ++noticeIds;
    uiStore.set((s) => ({ ...s, notices: [...s.notices.slice(-4), { id, sessionId, tone, text }] }));
  },

  dismiss(id: number): void {
    uiStore.set((s) => ({ ...s, notices: s.notices.filter((n) => n.id !== id) }));
  },
};

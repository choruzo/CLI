import { create } from 'zustand';
import type { ProtocolRun, ProtocolRunStatus, ProtocolSessionSnapshot } from '../protocol';

/**
 * Estado **de la interfaz**: qué sesión se mira, qué pestaña, qué se está
 * escribiendo, qué orden se acaba de dar y qué contestó el daemon. Nada de aquí
 * es estado del runtime ni de la conversación —esa sale de la foto de cada
 * sesión—, y lo único que se guarda entre arranques son dos preferencias: la
 * última sesión seleccionada y el último directorio de un chat nuevo.
 */

export type ControlKind = 'pause' | 'resume' | 'cancel';

/** Qué se enseña de la sesión seleccionada. */
export type SessionTab = 'chat' | 'activity';

/** La pantalla: sesiones (lista + detalle) o el centro de aprobaciones. */
export type MainView = 'sessions' | 'human-input';

/**
 * Lo que la interfaz sabe de una resolución que **ella** envió. No es el
 * estado de la solicitud —ese es la foto y su `*.resolved`—: sirve para decir
 * «Sending…», «Sent, waiting for the session…» o por qué no se aceptó.
 */
export interface Resolution {
  /** `confirming`: esperando a que la persona confirme en la ventana nativa. */
  state: 'confirming' | 'sending' | 'sent' | 'failed';
  /** Lo que se pidió, para decirlo («Approve», «Deny»…). */
  action: string;
  message?: string;
  at: number;
}

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

/**
 * Un mensaje enviado cuyo run aún no ha aparecido en la foto. Sirve para decir
 * «Sending…»: el mensaje **no** se añade a la conversación a mano.
 */
export interface PendingSend {
  /** El run que enseñaba la foto al enviar (o `null`): en cuanto es otro, ya llegó. */
  previousRunId: string | null;
  at: number;
}

export interface Notice {
  text: string;
  tone: 'info' | 'error';
  at: number;
}

/** Cuánto se enseña una orden pendiente sin que el estado cambie. */
export const PENDING_TTL_MS = 60_000;
/** Cuánto se espera a que aparezca el run de un mensaje enviado. */
export const SEND_TTL_MS = 30_000;
/** Cuánto se espera a que el daemon publique una sesión recién abierta. */
export const OPENING_TTL_MS = 20_000;
/** Cuánto se espera a que llegue el `*.resolved` de algo que se resolvió desde aquí. */
export const RESOLUTION_TTL_MS = 30_000;

const SELECTED_KEY = 'stratum-dot.selectedSession';
const LAST_CWD_KEY = 'stratum-dot.lastCwd';

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* sin almacenamiento, la preferencia no se recuerda */
  }
}

interface UiStore {
  selectedId: string | null;
  tab: SessionTab;
  /** El formulario de chat nuevo está abierto (en lugar del detalle). */
  composingNew: boolean;
  /** Directorio del último chat abierto desde Dot. */
  lastCwd: string;
  /** Lo que se está escribiendo en cada sesión. Solo vive en memoria. */
  drafts: Record<string, string>;
  pending: Record<string, PendingControl>;
  sends: Record<string, PendingSend>;
  /** Sesiones que Dot acaba de pedir abrir y el daemon aún no ha publicado. */
  opening: Record<string, number>;
  notices: Record<string, Notice>;
  view: MainView;
  /** La solicitud que hay que poner delante al abrir el centro (desde el chat). */
  focusItem: string | null;
  /** Por `sesión:id` de solicitud. Solo vive en memoria, y nunca guarda lo tecleado. */
  resolutions: Record<string, Resolution>;
  select(id: string | null): void;
  /** Abre el centro de aprobaciones, opcionalmente en esa solicitud. */
  openHumanInput(itemId?: string | null): void;
  setView(view: MainView): void;
  setResolution(id: string, resolution: Omit<Resolution, 'at'> | null): void;
  setTab(tab: SessionTab): void;
  setComposingNew(open: boolean): void;
  setLastCwd(cwd: string): void;
  setDraft(sessionId: string, text: string): void;
  setPending(sessionId: string, pending: PendingControl | null): void;
  setSend(sessionId: string, send: PendingSend | null): void;
  setOpening(sessionId: string, at: number | null): void;
  setNotice(sessionId: string, notice: Omit<Notice, 'at'> | null): void;
}

function withEntry<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

export const useUi = create<UiStore>((set) => ({
  selectedId: readPreference(SELECTED_KEY),
  tab: 'chat',
  composingNew: false,
  lastCwd: readPreference(LAST_CWD_KEY) ?? '',
  drafts: {},
  pending: {},
  sends: {},
  opening: {},
  notices: {},
  view: 'sessions',
  focusItem: null,
  resolutions: {},
  openHumanInput: (itemId = null) => set({ view: 'human-input', focusItem: itemId }),
  setView: (view) => set({ view, focusItem: null }),
  setResolution: (id, resolution) =>
    set((prev) => ({
      resolutions: withEntry(prev.resolutions, id, resolution ? { ...resolution, at: Date.now() } : null),
    })),
  select: (id) => {
    writePreference(SELECTED_KEY, id);
    // Elegir una sesión (o ninguna) cierra el formulario —nunca los dos a la
    // vez— y vuelve a la pantalla de sesiones.
    set({ selectedId: id, composingNew: false, view: 'sessions' });
  },
  setTab: (tab) => set({ tab }),
  setComposingNew: (open) => set({ composingNew: open }),
  setLastCwd: (cwd) => {
    writePreference(LAST_CWD_KEY, cwd || null);
    set({ lastCwd: cwd });
  },
  setDraft: (sessionId, text) =>
    set((prev) => ({ drafts: withEntry(prev.drafts, sessionId, text === '' ? null : text) })),
  setPending: (sessionId, pending) => set((prev) => ({ pending: withEntry(prev.pending, sessionId, pending) })),
  setSend: (sessionId, send) => set((prev) => ({ sends: withEntry(prev.sends, sessionId, send) })),
  setOpening: (sessionId, at) => set((prev) => ({ opening: withEntry(prev.opening, sessionId, at) })),
  setNotice: (sessionId, notice) =>
    set((prev) => ({
      notices: withEntry(prev.notices, sessionId, notice ? { ...notice, at: Date.now() } : null),
    })),
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

/**
 * ¿Sigue «enviándose» ese mensaje? También se deriva de la foto: en cuanto
 * enseña un run que no es el de antes, el mensaje ya está en la conversación.
 */
export function activeSend(
  send: PendingSend | undefined,
  snapshot: ProtocolSessionSnapshot | null,
  now: number,
): PendingSend | null {
  if (!send) return null;
  if (snapshot && (snapshot.run?.id ?? null) !== send.previousRunId) return null;
  return now - send.at < SEND_TTL_MS ? send : null;
}

/**
 * ¿Sigue en curso esa resolución? Una enviada deja de estarlo cuando la
 * solicitud ya no está pendiente (lo dice la foto) o pasado un rato.
 */
export function activeResolution(
  resolution: Resolution | undefined,
  stillPending: boolean,
  now: number,
): Resolution | null {
  if (!resolution || !stillPending) return null;
  // Lo fallido se queda hasta otro intento; la confirmación, hasta que la persona decida.
  if (resolution.state === 'failed' || resolution.state === 'confirming') return resolution;
  return now - resolution.at < RESOLUTION_TTL_MS ? resolution : null;
}

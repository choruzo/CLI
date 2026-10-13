/**
 * Cómo se **lee** una foto para pintarla. Funciones puras sobre los DTOs del
 * contrato: no añaden estados ni deciden nada.
 */
import type { ProtocolRun, ProtocolRunStatus, ProtocolSessionSnapshot } from './index';

/**
 * Lo que se enseña de una sesión. Son los estados del contrato y ninguno más:
 * el del run en curso, `idle` si no hay turno, y `detached` si su anfitrión
 * perdió la conexión. `pause-requested` es interno del runtime y no existe aquí.
 */
export type DisplayStatus = ProtocolRunStatus | 'idle' | 'detached' | 'closed';

export type Tone = 'active' | 'waiting' | 'paused' | 'idle' | 'ok' | 'bad' | 'muted';

const ACTIVE_RUN: ReadonlySet<ProtocolRunStatus> = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
]);

/** El run en curso de la sesión, o `null` si está parada (aunque la foto traiga el último). */
export function activeRun(snapshot: ProtocolSessionSnapshot): ProtocolRun | null {
  const { run, session } = snapshot;
  if (!run || !ACTIVE_RUN.has(run.status)) return null;
  // Con el anfitrión desconectado `currentRunId` se conserva: el run sigue contando.
  return session.currentRunId === null || session.currentRunId === run.id ? run : null;
}

/** El último run terminado, si la sesión está parada. */
export function lastRun(snapshot: ProtocolSessionSnapshot): ProtocolRun | null {
  const { run } = snapshot;
  return run && !ACTIVE_RUN.has(run.status) ? run : null;
}

/** ¿Está la sesión sin anfitrión? No es un fallo: puede volver. */
export function isDetached(snapshot: ProtocolSessionSnapshot): boolean {
  return snapshot.session.state === 'detached' || !snapshot.session.host.connected;
}

export function displayStatus(snapshot: ProtocolSessionSnapshot): DisplayStatus {
  if (snapshot.session.state === 'closed') return 'closed';
  // Antes que nada: un anfitrión desconectado no es un run fallido.
  if (isDetached(snapshot)) return 'detached';
  return activeRun(snapshot)?.status ?? 'idle';
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  waiting_input: 'Waiting for input',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  idle: 'Idle',
  detached: 'Detached',
  closed: 'Closed',
};

export const STATUS_TONE: Record<DisplayStatus, Tone> = {
  queued: 'waiting',
  running: 'active',
  waiting_approval: 'waiting',
  waiting_input: 'waiting',
  paused: 'paused',
  completed: 'ok',
  failed: 'bad',
  cancelled: 'muted',
  interrupted: 'bad',
  idle: 'idle',
  detached: 'muted',
  closed: 'muted',
};

/**
 * Qué hace el campo de escritura de una sesión. Son tres cosas distintas y no
 * se mezclan: **preguntar** abre un run nuevo (`runs.start`), **redirigir**
 * modifica el que hay (`runs.steer`), y a veces no se puede ninguna de las dos.
 */
export type ComposerMode =
  | { kind: 'ask' }
  | { kind: 'steer'; paused: boolean }
  | { kind: 'off'; reason: string };

export function composerMode(
  snapshot: ProtocolSessionSnapshot,
  link: { connected: boolean; canControl: boolean },
): ComposerMode {
  if (!link.connected) return { kind: 'off', reason: 'Not connected to the Stratum daemon' };
  if (snapshot.session.state === 'closed') return { kind: 'off', reason: 'This session has ended' };
  if (isDetached(snapshot)) return { kind: 'off', reason: "The session's host is not connected" };
  if (!link.canControl) return { kind: 'off', reason: 'This client cannot control runs' };
  const run = activeRun(snapshot);
  // Con un run en curso —también en pausa o esperando— nunca se abre otro.
  if (run) return { kind: 'steer', paused: run.status === 'paused' };
  if (snapshot.session.host.kind === 'peer') {
    return { kind: 'off', reason: 'This session lives in a terminal: new messages are typed there' };
  }
  return { kind: 'ask' };
}

/** Cuántas decisiones esperan a una persona en esta sesión. */
export function pendingCount(snapshot: ProtocolSessionSnapshot): number {
  return snapshot.approvals.length + snapshot.questions.length + snapshot.plans.length;
}

/** Dónde corre: `cli` (en una terminal) o `daemon`. */
export function hostLabel(snapshot: ProtocolSessionSnapshot): string {
  const { host } = snapshot.session;
  return host.kind === 'daemon' ? 'daemon' : `${host.client} (peer)`;
}

/** Texto de una duración: `42s`, `4m 12s`, `1h 03m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `4.2k`, `1.3M`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Tokens de la sesión. Nunca se estiman: sin dato, `n/a`. */
export function tokensLabel(snapshot: ProtocolSessionSnapshot): string {
  const { tokens } = snapshot.session;
  return tokens.status === 'reported' && tokens.total !== null ? formatCount(tokens.total) : 'n/a';
}

/** Recorta un texto que viene del anfitrión (ya redactado) para una vista previa. */
export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

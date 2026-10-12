/**
 * Qué sesiones hay vivas y qué runs han tenido, como **proyección** de los
 * eventos que publican sus anfitriones:
 *
 *   SessionHost → eventos → RunRegistry
 *
 * No es una fuente de verdad ni decide nada: el runtime de cada sesión es la
 * autoridad, y esto solo recuerda lo último que contó. Por eso no se guarda en
 * disco y se puede rehacer en cualquier momento a partir de los snapshots de las
 * sesiones (`replace`) y de sus eventos (`apply`).
 */
import type {
  ProtocolEvent,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionSnapshot,
} from '../protocol/index.js';

/** Runs terminados que se recuerdan, entre todas las sesiones. */
const DEFAULT_RUN_HISTORY = 500;

const ACTIVE_RUN: ReadonlySet<ProtocolRun['status']> = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
]);

export function isActiveRun(run: ProtocolRun): boolean {
  return ACTIVE_RUN.has(run.status);
}

export class RunRegistry {
  private readonly sessions = new Map<string, ProtocolSession>();
  /** En orden de aparición: el `Map` conserva el de inserción. */
  private readonly runs = new Map<string, ProtocolRun>();

  constructor(private readonly runHistory = DEFAULT_RUN_HISTORY) {}

  /** Aplica un evento publicado por un anfitrión. Los volátiles no cambian nada. */
  apply(event: ProtocolEvent): void {
    switch (event.type) {
      case 'session.opened':
      case 'session.updated':
        this.sessions.set(event.sessionId, event.data.session);
        return;
      case 'session.closed':
        this.sessions.delete(event.sessionId);
        this.settle(event.sessionId);
        return;
      case 'run.started':
      case 'run.updated':
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
        this.setRun(event.data.run);
        return;
      default:
        return;
    }
  }

  /** Rehace lo que se sabe de una sesión a partir de su snapshot. */
  replace(snapshot: ProtocolSessionSnapshot): void {
    this.sessions.set(snapshot.session.id, snapshot.session);
    if (snapshot.run) this.setRun(snapshot.run);
  }

  private setRun(run: ProtocolRun): void {
    this.runs.delete(run.id);
    this.runs.set(run.id, run);
    if (this.runs.size <= this.runHistory) return;
    // Se olvidan primero los terminados más antiguos; uno en curso, nunca.
    for (const [id, old] of this.runs) {
      if (this.runs.size <= this.runHistory) break;
      if (!isActiveRun(old)) this.runs.delete(id);
    }
  }

  /** La sesión se fue: lo que tuviera en curso ya no lo está. */
  private settle(sessionId: string): void {
    for (const [id, run] of this.runs) {
      if (run.sessionId === sessionId && isActiveRun(run)) {
        this.runs.set(id, { ...run, status: 'interrupted' });
      }
    }
  }

  session(sessionId: string): ProtocolSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): ProtocolSession[] {
    return [...this.sessions.values()];
  }

  run(runId: string): ProtocolRun | undefined {
    return this.runs.get(runId);
  }

  /** Los más recientes primero. */
  listRuns(filter: { sessionId?: string; active?: boolean; limit?: number } = {}): ProtocolRun[] {
    const out: ProtocolRun[] = [];
    for (const run of [...this.runs.values()].reverse()) {
      if (filter.sessionId && run.sessionId !== filter.sessionId) continue;
      if (filter.active !== undefined && isActiveRun(run) !== filter.active) continue;
      out.push(run);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  get liveSessions(): number {
    return this.sessions.size;
  }

  get activeRuns(): number {
    let n = 0;
    for (const run of this.runs.values()) if (isActiveRun(run)) n++;
    return n;
  }
}

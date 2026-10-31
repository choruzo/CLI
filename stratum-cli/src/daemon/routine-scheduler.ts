/**
 * M16 — planificador de rutinas del daemon (`docs/PRD_STRATUM_DOT.md` §23.5, A4).
 *
 * Una rutina tiene **su propia sesión** del `companion`, de larga vida: cada
 * vencimiento es un run en ella. Este módulo solo decide *cuándo* y *si* se
 * lanza; la sesión (abrirla, despertarla, cerrarla) la pone el daemon por
 * constructor, así que no importa nada de `daemon.ts`.
 *
 * Reglas que no se negocian:
 *  - nunca dos runs a la vez de una rutina: con run en curso el vencimiento se
 *    salta (`skipped-busy`), y un flag por rutina impide dos disparos solapados;
 *  - un vencimiento perdido (daemon parado, máquina dormida) no se recupera: si
 *    el timer despierta con más de `MISSED_GRACE_MS` de retraso es `missed`;
 *  - lo que pida aprobación no tiene nada especial: la sesión del daemon ya
 *    caduca a `deny`; programado no rebaja ninguna política;
 *  - todo punto que empiece trabajo nuevo del agente pasa por `waitAtSafePoint`;
 *  - un fallo de una rutina (abrir, arrancar) nunca afecta a las demás ni
 *    lanza fuera de aquí, y el siguiente vencimiento se arma pase lo que pase.
 */
import type { ProtocolRun, ProtocolSessionSnapshot } from '../protocol/index.js';
import { getLogger } from '../logging/index.js';
import { nextFire, parseSchedule } from '../routines/schedule.js';
import {
  RoutineStoreError,
  type NewRoutine,
  type Routine,
  type RoutinePatch,
  type RoutineStore,
} from '../routines/store.js';

const log = getLogger('daemon').child('routines');

/** Retraso con el que un timer despierta y el vencimiento ya se da por perdido. */
export const MISSED_GRACE_MS = 60_000;
/** `setTimeout` no admite más de 2^31−1 ms: un horario más lejano se arma por tramos. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Tope del resumen que acompaña a un run terminado. */
export const SUMMARY_MAX_CHARS = 500;

export type RoutineFireOutcome = 'started' | 'skipped-busy' | 'missed' | 'failed-to-start';

export interface RoutineFire {
  routineId: string;
  at: number;
  outcome: RoutineFireOutcome;
  manual: boolean;
  sessionId?: string;
  runId?: string;
  error?: string;
}

export interface RoutineFinished {
  routineId: string;
  sessionId: string;
  run: ProtocolRun;
  /** Texto final del asistente en ese run (ya redactado por el publicador), o `null`. */
  summary: string | null;
}

export interface RoutineStatus {
  routine: Routine;
  nextFireAt: number | null;
  scheduleError: string | null;
  lastFire: RoutineFire | null;
  sessionId: string | null;
  running: boolean;
}

/** Lo que el planificador necesita de la sesión de una rutina. */
export interface RoutineSession {
  readonly sessionId: string;
  readonly running: boolean;
  startRun(input: string, mode: 'normal', turn: { maxIterations?: number }): ProtocolRun;
  cancel(runId?: string): unknown;
  idle(): Promise<void>;
  snapshot(): ProtocolSessionSnapshot;
  waitAtSafePoint(): Promise<void>;
  setModel?(model: string): unknown;
  readonly model?: string;
}

export interface RoutineSchedulerOptions {
  store: RoutineStore;
  /** La sesión de la rutina: la que ya tenga (montada o guardada) o una nueva. */
  sessionFor(routine: Routine): Promise<RoutineSession>;
  /** La sesión que ya tenga, sin abrir ni montar nada (para `running` y `sessionId` de `list`). */
  existingSession(routineId: string): { sessionId: string; running: boolean } | null;
  /** Cierra y borra la sesión de una rutina que se elimina. */
  closeSession(routineId: string): Promise<void>;
  onFire?(fire: RoutineFire): void;
  onFinished?(done: RoutineFinished): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Armed {
  handle: unknown;
  due: number;
}

function messageOf(err: unknown): string {
  // Solo el mensaje: nada de pila.
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export class RoutineScheduler {
  private readonly store: RoutineStore;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly armed = new Map<string, Armed>();
  private readonly scheduleErrors = new Map<string, string>();
  private readonly lastFires = new Map<string, RoutineFire>();
  /** Rutinas con un disparo en marcha: nunca se solapan dos. */
  private readonly firing = new Set<string>();
  private started = false;
  private stopped = false;

  constructor(private readonly opts: RoutineSchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Lee el almacén y arma los timers de las rutinas habilitadas. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.store.load();
    for (const routine of this.store.list()) this.arm(routine);
    log.info('routines loaded', {
      routines: this.store.list().length,
      armed: this.armed.size,
      readOnly: this.store.readOnly,
    });
  }

  /** Quita los timers. No cancela runs: las sesiones las cierra el daemon. */
  stop(): void {
    this.stopped = true;
    for (const id of [...this.armed.keys()]) this.disarm(id);
  }

  /** Hay alguna habilitada con horario válido (el daemon no se apaga solo mientras tanto). */
  get hasEnabled(): boolean {
    return this.armed.size > 0;
  }

  list(): RoutineStatus[] {
    return this.store.list().map((r) => this.statusOf(r));
  }

  add(input: NewRoutine): RoutineStatus {
    const routine = this.store.add(input);
    this.arm(routine);
    return this.statusOf(routine);
  }

  update(id: string, patch: RoutinePatch): RoutineStatus {
    const routine = this.store.update(id, patch);
    this.arm(routine);
    return this.statusOf(routine);
  }

  async remove(id: string): Promise<Routine> {
    const routine = this.store.remove(id);
    this.disarm(id);
    this.scheduleErrors.delete(id);
    this.lastFires.delete(id);
    try {
      await this.opts.closeSession(id);
    } catch (err) {
      // La rutina ya no existe; su sesión huérfana se ve en el log.
      log.error('routine session not closed', { routineId: id, err });
    }
    return routine;
  }

  /** Disparo manual: también con la rutina deshabilitada. */
  async runNow(id: string): Promise<RoutineFire> {
    const routine = this.store.get(id);
    if (!routine) throw new RoutineStoreError('not-found', `Routine "${id}" not found.`);
    return this.fire(routine, true);
  }

  // ─── horario ───────────────────────────────────────────────────────────────

  private statusOf(routine: Routine): RoutineStatus {
    const existing = this.opts.existingSession(routine.id);
    return {
      routine,
      nextFireAt: this.armed.get(routine.id)?.due ?? null,
      scheduleError: this.scheduleErrors.get(routine.id) ?? null,
      lastFire: this.lastFires.get(routine.id) ?? null,
      sessionId: existing?.sessionId ?? null,
      running: existing?.running ?? false,
    };
  }

  private disarm(id: string): void {
    const armed = this.armed.get(id);
    if (!armed) return;
    this.armed.delete(id);
    this.clearTimer(armed.handle);
  }

  /** Arma el siguiente vencimiento de la rutina (o ninguno). Nunca lanza. */
  private arm(routine: Routine): void {
    this.disarm(routine.id);
    this.scheduleErrors.delete(routine.id);
    if (this.stopped || !routine.enabled) return;

    const parsed = parseSchedule(routine.schedule);
    const anchor = new Date(routine.createdAt);
    if (!parsed.ok || Number.isNaN(anchor.getTime())) {
      const reason = !parsed.ok ? parsed.error : 'invalid createdAt';
      this.scheduleErrors.set(routine.id, reason);
      log.warn('routine schedule unusable, not armed', { routineId: routine.id, reason });
      return;
    }
    const next = nextFire(parsed.schedule, new Date(this.now()), anchor);
    if (!next) {
      this.scheduleErrors.set(routine.id, 'the schedule has no upcoming occurrence');
      return;
    }
    const due = next.getTime();
    const delay = Math.min(Math.max(0, due - this.now()), MAX_TIMER_MS);
    const handle = this.setTimer(() => this.onTimer(routine.id, due), delay);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.armed.set(routine.id, { handle, due });
  }

  private onTimer(id: string, due: number): void {
    const armed = this.armed.get(id);
    // Un timer que ya no es el vigente (re-armado o quitado) no hace nada.
    if (!armed || armed.due !== due) return;
    this.armed.delete(id);
    const routine = this.store.get(id);
    if (this.stopped || !routine || !routine.enabled) return;

    const now = this.now();
    // Tramo intermedio de un horario lejano (o timer adelantado): se recalcula.
    if (now < due) {
      this.arm(routine);
      return;
    }
    if (now - due > MISSED_GRACE_MS) {
      this.record({ routineId: id, at: now, outcome: 'missed', manual: false });
      this.arm(routine);
      return;
    }
    // El siguiente se arma ya, antes de esperar a nada: tardar en abrir la
    // sesión no retrasa el horario.
    this.arm(routine);
    void this.fire(routine, false);
  }

  // ─── disparo ───────────────────────────────────────────────────────────────

  private record(fire: RoutineFire): RoutineFire {
    this.lastFires.set(fire.routineId, fire);
    try {
      this.opts.onFire?.(fire);
    } catch (err) {
      log.warn('onFire handler failed', { routineId: fire.routineId, err });
    }
    return fire;
  }

  /** Nunca lanza: todo resultado, también un fallo, es un `RoutineFire`. */
  private async fire(routine: Routine, manual: boolean): Promise<RoutineFire> {
    const base = { routineId: routine.id, at: this.now(), manual };
    if (this.firing.has(routine.id)) {
      return this.record({ ...base, outcome: 'skipped-busy' });
    }
    this.firing.add(routine.id);
    try {
      return await this.launch(routine, base);
    } catch (err) {
      log.warn('routine failed to start', { routineId: routine.id, err });
      return this.record({ ...base, outcome: 'failed-to-start', error: messageOf(err) });
    } finally {
      this.firing.delete(routine.id);
    }
  }

  private async launch(
    routine: Routine,
    base: { routineId: string; at: number; manual: boolean },
  ): Promise<RoutineFire> {
    const session = await this.opts.sessionFor(routine);
    const sessionId = session.sessionId;
    if (session.running) return this.record({ ...base, outcome: 'skipped-busy', sessionId });

    // Todo punto que empieza trabajo nuevo del agente pasa por el punto seguro.
    await session.waitAtSafePoint();
    if (!this.store.get(routine.id)) {
      return this.record({
        ...base,
        outcome: 'failed-to-start',
        sessionId,
        error: 'the routine was removed',
      });
    }
    // Mientras esperaba, alguien pudo lanzar un run en esa sesión.
    if (session.running) return this.record({ ...base, outcome: 'skipped-busy', sessionId });

    if (routine.model && session.setModel && routine.model !== session.model) {
      session.setModel(routine.model);
    }
    const run = session.startRun(routine.prompt, 'normal', {
      ...(routine.limits?.maxIterations ? { maxIterations: routine.limits.maxIterations } : {}),
    });
    const fire = this.record({ ...base, outcome: 'started', sessionId, runId: run.id });
    this.watchRun(routine, session, run).catch((err: unknown) => {
      log.warn('routine run watcher failed', { routineId: routine.id, err });
    });
    return fire;
  }

  /** Espera al final del run (con su plazo) y avisa. Nunca lanza. */
  private async watchRun(
    routine: Routine,
    session: RoutineSession,
    run: ProtocolRun,
  ): Promise<void> {
    let timeout: unknown = null;
    const minutes = routine.limits?.timeoutMinutes;
    if (minutes) {
      timeout = this.setTimer(
        () => {
          try {
            session.cancel(run.id);
          } catch (err) {
            // El run ya terminó (`STALE_STATE`) o la sesión se cerró: nada que cancelar.
            log.debug('routine timeout cancel ignored', { routineId: routine.id, err });
          }
        },
        Math.min(minutes * 60_000, MAX_TIMER_MS),
      );
      (timeout as { unref?: () => void } | null)?.unref?.();
    }
    try {
      await session.idle();
    } finally {
      if (timeout !== null) this.clearTimer(timeout);
    }
    if (this.stopped) return;
    try {
      const snapshot = session.snapshot();
      const finished = snapshot.run?.id === run.id ? snapshot.run : run;
      this.opts.onFinished?.({
        routineId: routine.id,
        sessionId: session.sessionId,
        run: finished,
        summary: summaryOf(snapshot, run.id),
      });
    } catch (err) {
      log.warn('routine finish handler failed', { routineId: routine.id, err });
    }
  }
}

/** El último mensaje del asistente de ese run, recortado, o `null`. */
function summaryOf(snapshot: ProtocolSessionSnapshot, runId: string): string | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const m = snapshot.messages[i]!;
    if (m.kind === 'assistant' && m.runId === runId) {
      const text = m.text.trim();
      if (!text) continue;
      return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text;
    }
  }
  return null;
}

/**
 * M16 — el `RoutineScheduler` con reloj, timers y sesiones falsos: cuándo
 * dispara, cuándo no (perdido, ocupado, solapado) y que un fallo de una rutina
 * no toca a las demás. El daemon real, en `daemon-routines.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  ProtocolChatMessage,
  ProtocolRun,
  ProtocolSessionSnapshot,
} from '../protocol/index.js';
import { RoutineStore, RoutineStoreError, ROUTINES_SCHEMA_VERSION } from '../routines/store.js';
import {
  MAX_TIMER_MS,
  MISSED_GRACE_MS,
  RoutineScheduler,
  SUMMARY_MAX_CHARS,
  type RoutineFinished,
  type RoutineFire,
  type RoutineSession,
} from './routine-scheduler.js';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;

interface FakeTimer {
  id: number;
  at: number;
  ms: number;
  fn: () => void;
  cleared: boolean;
  fired: boolean;
}

/** Reloj y timers a mano: `runTimers(to)` es «duerme hasta `to`» y dispara lo vencido. */
function fakeClock() {
  let now = T0;
  let seq = 0;
  const timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const t: FakeTimer = { id: ++seq, at: now + ms, ms, fn, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown): void => {
      (h as FakeTimer).cleared = true;
    },
    pending: (): FakeTimer[] => timers.filter((t) => !t.cleared && !t.fired),
    set(to: number): void {
      now = to;
    },
    runTimers(to: number): void {
      now = to;
      for (const t of timers.filter((x) => !x.cleared && !x.fired && x.at <= to)) {
        t.fired = true;
        t.fn();
      }
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

class FakeSession implements RoutineSession {
  running = false;
  model = 'm1';
  readonly calls: string[] = [];
  readonly starts: Array<{ input: string; turn: { maxIterations?: number } }> = [];
  readonly cancelled: Array<string | undefined> = [];
  readonly models: string[] = [];
  messages: ProtocolChatMessage[] = [];
  private release: () => void = () => undefined;
  private runs = 0;
  lastRun: ProtocolRun | null = null;
  /** Orden de llamadas compartido con otras sesiones (para comprobar `waitAtSafePoint`). */
  constructor(
    readonly sessionId: string,
    private readonly order: string[] = [],
  ) {}

  startRun(input: string, _mode: 'normal', turn: { maxIterations?: number }): ProtocolRun {
    this.order.push(`start:${this.sessionId}`);
    this.starts.push({ input, turn });
    this.running = true;
    this.lastRun = {
      id: `run_${this.sessionId}_${++this.runs}`,
      sessionId: this.sessionId,
      kind: 'run',
      input,
      mode: 'normal',
      status: 'running',
      startedAt: T0,
      counters: { toolCalls: 0 },
    } as unknown as ProtocolRun;
    return this.lastRun;
  }
  cancel(runId?: string): void {
    this.cancelled.push(runId);
  }
  idle(): Promise<void> {
    return this.running
      ? new Promise<void>((r) => {
          this.release = r;
        })
      : Promise.resolve();
  }
  /** Termina el run en curso. */
  finish(status: 'completed' | 'cancelled' = 'completed'): void {
    this.running = false;
    if (this.lastRun) this.lastRun = { ...this.lastRun, status };
    this.release();
  }
  snapshot(): ProtocolSessionSnapshot {
    return { run: this.lastRun, messages: this.messages } as unknown as ProtocolSessionSnapshot;
  }
  async waitAtSafePoint(): Promise<void> {
    this.order.push(`safe:${this.sessionId}`);
  }
  setModel(model: string): void {
    this.models.push(model);
    this.model = model;
  }
}

function assistant(runId: string, text: string, n: number): ProtocolChatMessage {
  return { id: `m${n}`, runId, at: T0, kind: 'assistant', text };
}

describe('RoutineScheduler', () => {
  let dir: string;
  let clock: ReturnType<typeof fakeClock>;
  let sessions: Map<string, FakeSession>;
  let order: string[];
  let fires: RoutineFire[];
  let finished: RoutineFinished[];
  let closed: string[];
  let sessionForCalls: string[];
  let failFor: Set<string>;
  let sessionGate: Promise<void> | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routine-sched-'));
    clock = fakeClock();
    sessions = new Map();
    order = [];
    fires = [];
    finished = [];
    closed = [];
    sessionForCalls = [];
    failFor = new Set();
    sessionGate = null;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(opts: { file?: string } = {}) {
    const store = new RoutineStore(opts.file ?? join(dir, 'routines.json'), {
      now: () => new Date(T0),
    });
    const scheduler = new RoutineScheduler({
      store,
      sessionFor: async (routine) => {
        sessionForCalls.push(routine.id);
        if (sessionGate) await sessionGate;
        if (failFor.has(routine.id)) throw new Error('UNAVAILABLE: Too many live sessions.');
        let s = sessions.get(routine.id);
        if (!s) {
          s = new FakeSession(`s_${routine.id}`, order);
          sessions.set(routine.id, s);
        }
        return s;
      },
      existingSession: (id) => {
        const s = sessions.get(id);
        return s ? { sessionId: s.sessionId, running: s.running } : null;
      },
      closeSession: async (id) => {
        closed.push(id);
        sessions.delete(id);
      },
      onFire: (f) => fires.push(f),
      onFinished: (d) => finished.push(d),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { store, scheduler };
  }

  it('dispara a su hora, arranca el run y arma el siguiente', async () => {
    const { scheduler } = make();
    scheduler.start();
    const added = scheduler.add({ name: 'a', schedule: '30m', prompt: 'haz A' });
    expect(added.nextFireAt).toBe(T0 + 30 * MIN);
    expect(scheduler.hasEnabled).toBe(true);

    clock.runTimers(T0 + 29 * MIN);
    await settle();
    expect(fires).toHaveLength(0);

    clock.runTimers(T0 + 30 * MIN);
    await settle();
    const s = sessions.get(added.routine.id)!;
    expect(s.starts).toEqual([{ input: 'haz A', turn: {} }]);
    expect(fires).toMatchObject([
      { outcome: 'started', manual: false, sessionId: s.sessionId, runId: s.lastRun!.id },
    ]);
    expect(scheduler.list()[0]).toMatchObject({
      nextFireAt: T0 + 60 * MIN,
      running: true,
      sessionId: s.sessionId,
      lastFire: { outcome: 'started' },
    });
  });

  it('el intervalo se alinea al createdAt, no a cuando arranca el daemon', () => {
    const { store, scheduler } = make();
    store.load();
    store.add({ name: 'a', schedule: '30m', prompt: 'p' });
    clock.set(T0 + 45 * MIN);
    scheduler.start();
    expect(scheduler.list()[0]!.nextFireAt).toBe(T0 + 60 * MIN);
  });

  it('un salto de reloj de más de 60 s es missed: no dispara y arma el siguiente', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });

    // La máquina durmió: el timer despierta tarde.
    clock.runTimers(T0 + 30 * MIN + MISSED_GRACE_MS + 1);
    await settle();
    expect(fires).toMatchObject([{ routineId: routine.id, outcome: 'missed', manual: false }]);
    expect(sessionForCalls).toEqual([]);
    expect(scheduler.list()[0]!.nextFireAt).toBe(T0 + 60 * MIN);

    // Justo en el límite todavía se dispara.
    clock.runTimers(T0 + 60 * MIN + MISSED_GRACE_MS);
    await settle();
    expect(fires.at(-1)).toMatchObject({ outcome: 'started' });
  });

  it('con un run en curso el vencimiento se salta y el siguiente sigue armado', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    clock.runTimers(T0 + 30 * MIN);
    await settle();
    const s = sessions.get(routine.id)!;
    expect(s.running).toBe(true);

    clock.runTimers(T0 + 60 * MIN);
    await settle();
    expect(fires.map((f) => f.outcome)).toEqual(['started', 'skipped-busy']);
    expect(s.starts).toHaveLength(1);
    expect(scheduler.list()[0]!.nextFireAt).toBe(T0 + 90 * MIN);

    // Termina el run: el siguiente vencimiento ya arranca otro.
    s.finish();
    await settle();
    clock.runTimers(T0 + 90 * MIN);
    await settle();
    expect(fires.map((f) => f.outcome)).toEqual(['started', 'skipped-busy', 'started']);
  });

  it('nunca dos disparos solapados de la misma rutina', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    let open!: () => void;
    sessionGate = new Promise<void>((r) => (open = r));

    const first = scheduler.runNow(routine.id);
    const second = scheduler.runNow(routine.id);
    // Y un vencimiento del timer mientras el primero aún abre la sesión.
    clock.runTimers(T0 + 30 * MIN);
    await settle();
    open();
    const [a, b] = await Promise.all([first, second]);
    await settle();

    expect(a.outcome).toBe('started');
    expect(b.outcome).toBe('skipped-busy');
    expect(sessionForCalls).toHaveLength(1);
    expect(sessions.get(routine.id)!.starts).toHaveLength(1);
    expect(fires.filter((f) => f.outcome === 'started')).toHaveLength(1);
  });

  it('failed-to-start no rompe a las demás ni deja de armar la suya', async () => {
    const { scheduler } = make();
    scheduler.start();
    const a = scheduler.add({ name: 'a', schedule: '30m', prompt: 'pa' }).routine;
    const b = scheduler.add({ name: 'b', schedule: '30m', prompt: 'pb' }).routine;
    failFor.add(a.id);

    clock.runTimers(T0 + 30 * MIN);
    await settle();
    const byId = (id: string) => fires.find((f) => f.routineId === id)!;
    expect(byId(a.id)).toMatchObject({
      outcome: 'failed-to-start',
      error: 'UNAVAILABLE: Too many live sessions.',
    });
    expect(byId(a.id).error).not.toContain('\n    at ');
    expect(byId(b.id).outcome).toBe('started');
    for (const st of scheduler.list()) expect(st.nextFireAt).toBe(T0 + 60 * MIN);
  });

  it('un horario guardado que ya no valida da scheduleError sin lanzar ni armar', () => {
    const file = join(dir, 'routines.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: ROUTINES_SCHEMA_VERSION,
        routines: [
          {
            id: 'rt_bad',
            name: 'mala',
            schedule: 'cuando quieras',
            prompt: 'p',
            enabled: true,
            createdAt: new Date(T0).toISOString(),
          },
          {
            id: 'rt_date',
            name: 'sin fecha',
            schedule: '30m',
            prompt: 'p',
            enabled: true,
            createdAt: 'ayer',
          },
        ],
      }),
    );
    const { scheduler } = make({ file });
    expect(() => scheduler.start()).not.toThrow();
    const list = scheduler.list();
    expect(list.map((s) => s.nextFireAt)).toEqual([null, null]);
    expect(list[0]!.scheduleError).toMatch(/schedule/i);
    expect(list[1]!.scheduleError).toBe('invalid createdAt');
    expect(scheduler.hasEnabled).toBe(false);
  });

  it('un horario más largo que el tope de setTimeout se arma por tramos', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30d', prompt: 'p' });
    const due = T0 + 30 * 86_400_000;
    expect(due - T0).toBeGreaterThan(MAX_TIMER_MS);
    expect(clock.pending().map((t) => t.ms)).toEqual([MAX_TIMER_MS]);

    // Despierta en el primer tramo: recalcula, sin disparar.
    clock.runTimers(T0 + MAX_TIMER_MS);
    await settle();
    expect(fires).toHaveLength(0);
    expect(clock.pending().map((t) => t.ms)).toEqual([due - (T0 + MAX_TIMER_MS)]);
    expect(scheduler.list()[0]!.nextFireAt).toBe(due);

    clock.runTimers(due);
    await settle();
    expect(fires).toMatchObject([{ routineId: routine.id, outcome: 'started' }]);
  });

  it('una deshabilitada no se arma, pero runNow la corre', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine, nextFireAt } = scheduler.add({
      name: 'a',
      schedule: '30m',
      prompt: 'p',
      enabled: false,
    });
    expect(nextFireAt).toBeNull();
    expect(clock.pending()).toHaveLength(0);
    expect(scheduler.hasEnabled).toBe(false);

    const fire = await scheduler.runNow(routine.id);
    expect(fire).toMatchObject({ outcome: 'started', manual: true });
    expect(sessions.get(routine.id)!.starts).toHaveLength(1);

    // Y con el run en curso, el manual también se salta.
    expect((await scheduler.runNow(routine.id)).outcome).toBe('skipped-busy');
    await expect(scheduler.runNow('rt_nope')).rejects.toBeInstanceOf(RoutineStoreError);
  });

  it('update re-arma; deshabilitar quita el timer', () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    const before = clock.pending()[0]!;

    const updated = scheduler.update(routine.id, { schedule: '1h' });
    expect(before.cleared).toBe(true);
    expect(updated.nextFireAt).toBe(T0 + 60 * MIN);
    expect(clock.pending()).toHaveLength(1);

    const off = scheduler.update(routine.id, { enabled: false });
    expect(off.nextFireAt).toBeNull();
    expect(clock.pending()).toHaveLength(0);
    expect(() => scheduler.update(routine.id, { schedule: 'mal' })).toThrow(RoutineStoreError);
  });

  it('remove quita el timer, borra la rutina y cierra su sesión', async () => {
    const { store, scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    await scheduler.remove(routine.id);
    expect(closed).toEqual([routine.id]);
    expect(store.get(routine.id)).toBeUndefined();
    expect(clock.pending()).toHaveLength(0);
    expect(scheduler.hasEnabled).toBe(false);
    await expect(scheduler.remove(routine.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('stop quita los timers sin cancelar runs', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    await scheduler.runNow(routine.id);
    scheduler.stop();
    expect(clock.pending()).toHaveLength(0);
    expect(sessions.get(routine.id)!.cancelled).toEqual([]);
    expect(scheduler.hasEnabled).toBe(false);
  });

  it('timeoutMinutes cancela el run si sigue, y el timer se limpia al terminar', async () => {
    const { scheduler } = make();
    scheduler.start();
    const a = scheduler.add({
      name: 'a',
      schedule: '30m',
      prompt: 'p',
      limits: { timeoutMinutes: 5 },
    }).routine;
    await scheduler.runNow(a.id);
    const s = sessions.get(a.id)!;
    const timeout = clock.pending().find((t) => t.ms === 5 * MIN)!;
    expect(timeout).toBeDefined();
    clock.runTimers(T0 + 5 * MIN);
    expect(s.cancelled).toEqual([s.lastRun!.id]);

    // Otra rutina que termina antes de su plazo: el timer se quita.
    const b = scheduler.add({
      name: 'b',
      schedule: '30m',
      prompt: 'p',
      limits: { timeoutMinutes: 10 },
    }).routine;
    await scheduler.runNow(b.id);
    const bTimer = clock.pending().find((t) => t.ms === 10 * MIN)!;
    sessions.get(b.id)!.finish();
    await settle();
    expect(bTimer.cleared).toBe(true);
  });

  it('onFinished lleva el último mensaje del asistente de ese run, recortado', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    await scheduler.runNow(routine.id);
    const s = sessions.get(routine.id)!;
    const runId = s.lastRun!.id;
    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 100);
    s.messages = [
      assistant('run_anterior', 'resultado de ayer', 1),
      assistant(runId, 'primer bloque', 2),
      assistant(runId, long, 3),
      {
        id: 'm4',
        runId,
        at: T0,
        kind: 'tool',
        callId: 'c',
        name: 'exec',
        description: 'ls',
        state: 'completed',
      },
    ];
    s.finish();
    await settle();

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      routineId: routine.id,
      sessionId: s.sessionId,
      run: { id: runId, status: 'completed' },
    });
    expect(finished[0]!.summary).toBe('x'.repeat(SUMMARY_MAX_CHARS));

    // Sin texto del asistente en ese run: null.
    await scheduler.runNow(routine.id);
    s.messages = [assistant('run_anterior', 'otro', 9)];
    s.finish('cancelled');
    await settle();
    expect(finished[1]).toMatchObject({ summary: null, run: { status: 'cancelled' } });
  });

  it('lastResult guarda el último run terminado y remove lo borra', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    expect(scheduler.list()[0]!.lastResult).toBeNull();
    await scheduler.runNow(routine.id);
    const s = sessions.get(routine.id)!;
    const runId = s.lastRun!.id;
    s.messages = [assistant(runId, 'todo bien', 2)];
    s.finish();
    await settle();

    expect(scheduler.list()[0]!.lastResult).toMatchObject({
      runId,
      sessionId: s.sessionId,
      status: 'completed',
      summary: 'todo bien',
    });
    await scheduler.remove(routine.id);
    expect(scheduler.list()).toEqual([]);
    const again = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    expect(again.lastResult).toBeNull();
  });

  it('maxIterations y model llegan a la sesión; el mismo modelo no se cambia', async () => {
    const { scheduler } = make();
    scheduler.start();
    const a = scheduler.add({
      name: 'a',
      schedule: '30m',
      prompt: 'p',
      model: 'm2',
      limits: { maxIterations: 9 },
    }).routine;
    await scheduler.runNow(a.id);
    const s = sessions.get(a.id)!;
    expect(s.models).toEqual(['m2']);
    expect(s.starts[0]!.turn).toEqual({ maxIterations: 9 });

    s.finish();
    await settle();
    await scheduler.runNow(a.id);
    expect(s.models).toEqual(['m2']);

    const b = scheduler.add({ name: 'b', schedule: '30m', prompt: 'p', model: 'm1' }).routine;
    await scheduler.runNow(b.id);
    expect(sessions.get(b.id)!.models).toEqual([]);
  });

  it('waitAtSafePoint se llama antes de startRun', async () => {
    const { scheduler } = make();
    scheduler.start();
    const { routine } = scheduler.add({ name: 'a', schedule: '30m', prompt: 'p' });
    await scheduler.runNow(routine.id);
    const id = sessions.get(routine.id)!.sessionId;
    expect(order).toEqual([`safe:${id}`, `start:${id}`]);
  });
});

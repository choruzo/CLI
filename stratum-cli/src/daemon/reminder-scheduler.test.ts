/**
 * M21 — el `ReminderScheduler` con reloj y timers falsos: entrega en su hora,
 * lo perdido se entrega al arrancar marcado `late`, se marca antes de entregar
 * (nunca dos veces) y un fallo al avisar no se reintenta.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProtocolReminder } from '../protocol/index.js';
import { ReminderStore, REMINDERS_SCHEMA_VERSION } from '../reminders/store.js';
import { MAX_TIMER_MS } from './routine-scheduler.js';
import { RETRY_AFTER_MS, RETRY_FIRST_MS, ReminderScheduler } from './reminder-scheduler.js';

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeTimer {
  at: number;
  ms: number;
  fn: () => void;
  cleared: boolean;
  fired: boolean;
}

/** Reloj y timers a mano: `runTimers(to)` es «duerme hasta `to`» y dispara lo vencido. */
function fakeClock() {
  let now = T0;
  const timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const t: FakeTimer = { at: now + ms, ms, fn, cleared: false, fired: false };
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

function harness(opts: { content?: unknown; fail?: boolean } = {}) {
  const state = { fail: opts.fail === true };
  const dir = mkdtempSync(join(tmpdir(), 'stratum-reminder-sched-'));
  dirs.push(dir);
  const file = join(dir, 'reminders.json');
  if (opts.content !== undefined) writeFileSync(file, JSON.stringify(opts.content), 'utf-8');
  const store = new ReminderStore(file);
  const clock = fakeClock();
  const delivered: ProtocolReminder[] = [];
  const hook: ProtocolReminder[] = [];
  const scheduler = new ReminderScheduler({
    store,
    deliver: (reminder) => {
      if (state.fail) throw new Error('nadie escucha');
      delivered.push(reminder);
    },
    onDelivered: (reminder) => hook.push(reminder),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    file,
    store,
    clock,
    scheduler,
    delivered,
    hook,
    get fail(): boolean {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
  };
}

/** Un pendiente ya escrito en disco (lo que deja un daemon que estuvo apagado). */
function stored(dueAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REMINDERS_SCHEMA_VERSION,
    reminders: [
      {
        id: 'rem_viejo',
        text: 'llama al médico',
        dueAt,
        createdAt: dueAt - DAY,
        origin: 'person',
        status: 'pending',
        ...extra,
      },
    ],
  };
}

describe('M21 — ReminderScheduler', () => {
  it('start entrega lo ya vencido, marcado late, y no deja nada pendiente', async () => {
    const h = harness({ content: stored(T0 - 30 * MIN) });
    h.scheduler.start();
    await settle();
    expect(h.delivered.map((r) => r.id)).toEqual(['rem_viejo']);
    // Ya marcado entregado cuando se entrega: no puede entregarse dos veces.
    expect(h.delivered[0]).toMatchObject({ status: 'delivered', late: true, endedAt: T0 });
    expect(h.hook.map((r) => r.id)).toEqual(['rem_viejo']);
    expect(h.scheduler.hasPending).toBe(false);
    expect(h.clock.pending()).toEqual([]);
    // Y en el disco.
    expect(h.store.list(T0)[0]).toMatchObject({ status: 'delivered', late: true });
  });

  it('un vencimiento dentro del minuto de gracia no es late', async () => {
    const h = harness({ content: stored(T0 - 20_000) });
    h.scheduler.start();
    await settle();
    expect(h.delivered[0]?.late).toBeUndefined();
  });

  it('arma el timer del siguiente y entrega a su hora, una sola vez', async () => {
    const h = harness();
    h.store.load();
    const { id } = h.scheduler.add(
      { text: 'saca la basura', dueAt: T0 + 10 * MIN, origin: 'agent' },
      T0,
    );
    expect(h.scheduler.hasPending).toBe(true);
    expect(h.delivered).toEqual([]);
    h.scheduler.start();
    await settle();
    // Un solo timer, el del siguiente vencimiento.
    expect(h.clock.pending()).toHaveLength(1);
    expect(h.clock.pending()[0]?.at).toBe(T0 + 10 * MIN);

    h.clock.runTimers(T0 + 10 * MIN);
    await settle();
    expect(h.delivered.map((r) => r.id)).toEqual([id]);
    expect(h.scheduler.hasPending).toBe(false);

    // Volver a mover el reloj no entrega nada más.
    h.clock.runTimers(T0 + 20 * MIN);
    await settle();
    expect(h.delivered).toHaveLength(1);
  });

  it('un vencimiento lejano se arma por tramos de MAX_TIMER_MS', async () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.add({ text: 'renovar el pasaporte', dueAt: T0 + 300 * DAY, origin: 'agent' }, T0);
    const [first] = h.clock.pending();
    expect(first?.ms).toBe(MAX_TIMER_MS);
    expect(h.delivered).toEqual([]);
    h.clock.runTimers(T0 + MAX_TIMER_MS);
    // Aún no vence: se rearma otro tramo y nada se entrega.
    expect(h.delivered).toEqual([]);
    expect(h.clock.pending()).toHaveLength(1);
  });

  it('refresh tras cancelar quita el timer y no entrega; sin pendientes, ninguno', async () => {
    const h = harness();
    h.scheduler.start();
    const { id } = h.scheduler.add({ text: 'a', dueAt: T0 + 5 * MIN, origin: 'agent' }, T0);
    expect(h.clock.pending()).toHaveLength(1);
    h.scheduler.cancel(id, T0);
    expect(h.clock.pending()).toEqual([]);
    h.clock.runTimers(T0 + 60 * MIN);
    await settle();
    expect(h.delivered).toEqual([]);
    expect(h.scheduler.list(T0)[0]?.status).toBe('cancelled');
  });

  it('stop no entrega nada más', async () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.add({ text: 'a', dueAt: T0 + 5 * MIN, origin: 'agent' }, T0);
    h.scheduler.stop();
    expect(h.clock.pending()).toEqual([]);
    h.clock.runTimers(T0 + 60 * MIN);
    await settle();
    expect(h.delivered).toEqual([]);
    expect(h.scheduler.list(T0)[0]?.status).toBe('pending');
  });

  it('si deliver lanza, el aviso sigue pendiente y se reintenta espaciado', async () => {
    const h = harness({ content: stored(T0 - 30 * MIN), fail: true });
    h.scheduler.start();
    await settle();
    // No se dio por entregado: sigue pendiente, y hay un reintento armado a 1 min.
    expect(h.store.list(T0)[0]?.status).toBe('pending');
    expect(h.delivered).toEqual([]);
    expect(h.clock.pending().map((t) => t.ms)).toEqual([RETRY_FIRST_MS]);

    // El segundo intento ya espera 5 min.
    h.clock.runTimers(T0 + RETRY_FIRST_MS);
    await settle();
    expect(h.store.list(T0)[0]?.status).toBe('pending');
    expect(h.clock.pending().map((t) => t.ms)).toEqual([RETRY_AFTER_MS]);

    // Y cuando por fin sale, se entrega y se marca.
    h.fail = false;
    h.clock.runTimers(T0 + RETRY_FIRST_MS + RETRY_AFTER_MS);
    await settle();
    expect(h.delivered.map((r) => r.id)).toEqual(['rem_viejo']);
    expect(h.delivered[0]).toMatchObject({ status: 'delivered', late: true });
    expect(h.store.list(T0 + RETRY_FIRST_MS + RETRY_AFTER_MS)[0]?.status).toBe('delivered');
  });

  it('si publica pero no se puede marcar, no se repite en este proceso', async () => {
    const reminder: ProtocolReminder = {
      id: 'rem_1',
      text: 'x',
      dueAt: T0 - MIN,
      createdAt: T0 - DAY,
      origin: 'person',
      status: 'pending',
    };
    let marks = 0;
    const store = {
      load: () => undefined,
      pending: () => [{ ...reminder }],
      markDelivered: () => {
        marks++;
        throw new Error('el disco no escribe');
      },
      list: () => [],
      readOnly: false,
    } as unknown as ReminderStore;
    const clock = fakeClock();
    const delivered: string[] = [];
    const scheduler = new ReminderScheduler({
      store,
      deliver: (r) => {
        delivered.push(r.id);
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();
    await settle();
    expect(delivered).toEqual(['rem_1']);
    expect(marks).toBe(1);
    expect(scheduler.hasPending).toBe(false);
    // Pase el tiempo que pase, aquí ya no se repite.
    clock.runTimers(T0 + 60 * MIN);
    await settle();
    expect(delivered).toEqual(['rem_1']);
  });

  it('con el almacén en solo lectura no entrega nada (no podría marcarlo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-reminder-ro-'));
    dirs.push(dir);
    const file = join(dir, 'reminders.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, reminders: [] }), 'utf-8');
    const delivered: ProtocolReminder[] = [];
    const clock = fakeClock();
    const scheduler = new ReminderScheduler({
      store: new ReminderStore(file),
      deliver: (r) => {
        delivered.push(r);
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();
    await settle();
    expect(scheduler.readOnly).toBe(true);
    expect(delivered).toEqual([]);
    expect(scheduler.list(T0)).toEqual([]);
  });

  it('lo entrega sea cual sea el orden de la cola: primero el que antes vence', async () => {
    const h = harness({
      content: {
        schemaVersion: REMINDERS_SCHEMA_VERSION,
        reminders: [
          {
            id: 'rem_b',
            text: 'b',
            dueAt: T0 + 5 * MIN,
            createdAt: T0 - DAY,
            origin: 'person',
            status: 'pending',
          },
          {
            id: 'rem_a',
            text: 'a',
            dueAt: T0 - 5 * MIN,
            createdAt: T0 - DAY,
            origin: 'person',
            status: 'pending',
          },
        ],
      },
    });
    h.scheduler.start();
    await settle();
    expect(h.delivered.map((r) => r.id)).toEqual(['rem_a']);
    expect(h.scheduler.list(T0).map((r) => r.id)).toEqual(['rem_a', 'rem_b']);
  });
});

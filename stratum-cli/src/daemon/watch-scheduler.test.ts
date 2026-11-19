/**
 * M22 — el `WatchScheduler` con reloj y timers falsos: agrupa por conector (una
 * conexión por conector y ciclo), respeta el intervalo de cada vigilante,
 * avisa cuando toca y no evalúa nada con el almacén en solo lectura.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProtocolWatchNotice } from '../protocol/index.js';
import type { ProbeCall, ProbeOutcome } from '../watches/probe.js';
import type { WatchDefinition } from '../watches/define.js';
import { INITIAL_WATCH_STATE, type WatchState } from '../watches/engine.js';
import { WatchStore, WATCHES_SCHEMA_VERSION, watchesFile } from '../watches/store.js';
import { WatchScheduler } from './watch-scheduler.js';

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const MIN = 60_000;
const TICK = 1_000;

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
    now: (): number => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const t: FakeTimer = { at: now + ms, ms, fn, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown): void => {
      (h as FakeTimer).cleared = true;
    },
    pending: (): FakeTimer[] => timers.filter((t) => !t.cleared && !t.fired),
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
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const def = (over: Partial<WatchDefinition> = {}): WatchDefinition => ({
  name: 'Salón',
  connector: 'casa',
  check: 'estado',
  args: { entity_id: 'light.salon' },
  condition: { kind: 'state-is', values: ['on'] },
  intervalSec: 60,
  cooldownMinutes: 30,
  notifyResolved: false,
  origin: 'person',
  ...over,
});

const on = (estado = 'on'): ProbeOutcome => ({
  kind: 'ran',
  outcomes: [{ ok: true, result: { estado, valor: null, detalle: '' } }],
});

function harness(
  opts: {
    defs?: WatchDefinition[];
    content?: unknown;
    respond?: (
      connector: string,
      calls: readonly ProbeCall[],
    ) => ProbeOutcome | Promise<ProbeOutcome>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-watch-sched-'));
  dirs.push(dir);
  const file = watchesFile(dir);
  if (opts.content !== undefined) writeFileSync(file, JSON.stringify(opts.content), 'utf-8');
  const store = new WatchStore(file);
  if (opts.content === undefined) {
    store.load();
    for (const d of opts.defs ?? [def()]) store.add(d, T0);
  }
  const clock = fakeClock();
  const state = {
    respond:
      opts.respond ??
      ((): ProbeOutcome => ({
        kind: 'ran',
        outcomes: [{ ok: true, result: { estado: 'on', valor: null, detalle: '' } }],
      })),
    notifyThrows: false,
  };
  const calls: Array<{ connector: string; calls: ProbeCall[] }> = [];
  const notices: ProtocolWatchNotice[] = [];
  const scheduler = new WatchScheduler({
    store,
    probe: {
      async run(connector, calls_, signal) {
        void signal;
        calls.push({ connector, calls: calls_.map((c) => ({ ...c })) });
        return state.respond(connector, calls_);
      },
    },
    notify: (notice) => {
      if (state.notifyThrows) throw new Error('nadie escucha');
      notices.push(notice);
    },
    now: clock.now,
    tickMs: TICK,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    file,
    store,
    clock,
    scheduler,
    calls,
    notices,
    state,
    /** Un ciclo: dispara lo que venza en `at` y espera a que termine. */
    async at(at: number): Promise<void> {
      clock.runTimers(at);
      await scheduler.idle();
      await settle();
    },
  };
}

describe('M22 — WatchScheduler', () => {
  it('agrupa por conector: una conexión por conector y ciclo', async () => {
    const h = harness({
      defs: [
        def({ name: 'a' }),
        def({ name: 'b' }),
        def({ name: 'c', connector: 'reloj', check: 'hora', args: {} }),
      ],
    });
    h.scheduler.start();
    await h.at(T0);
    expect(h.calls.map((c) => c.connector)).toEqual(['casa', 'reloj']);
    expect(h.calls[0]!.calls.map((c) => c.tool)).toEqual(['estado', 'estado']);
    expect(h.calls[0]!.calls.map((c) => c.args.entity_id)).toEqual(['light.salon', 'light.salon']);
    expect(h.calls[1]!.calls).toEqual([{ tool: 'hora', args: {} }]);
  });

  it('respeta el intervalo: no vuelve a mirar hasta que vence', async () => {
    const h = harness();
    h.scheduler.start();
    await h.at(T0);
    expect(h.calls).toHaveLength(1);

    // Un segundo después no toca todavía.
    await h.at(T0 + TICK);
    expect(h.calls).toHaveLength(1);

    // A los 60 s (con el margen de la vuelta) sí.
    await h.at(T0 + 59_000);
    expect(h.calls).toHaveLength(2);

    // Y sigue sin hacerlo antes de otros 59 s.
    await h.at(T0 + 60_000 + TICK);
    expect(h.calls).toHaveLength(2);
    await h.at(T0 + 60_000 + 59_000);
    expect(h.calls).toHaveLength(3);
  });

  it('salta y llama a notify con el texto ya compuesto', async () => {
    const h = harness({ respond: () => on('on') });
    h.scheduler.start();
    await h.at(T0);
    const watch = h.store.list()[0]!;
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      watchId: watch.id,
      name: 'Salón',
      kind: 'fired',
      at: T0,
    });
    expect(h.notices[0]!.text).toContain('Vigilante «Salón»: el estado es «on»');
    expect(h.store.get(watch.id)!.state).toMatchObject({ firing: true, lastFiredAt: T0 });

    // Mientras siga cumpliéndose no se repite.
    await h.at(T0 + 59_000);
    expect(h.notices).toHaveLength(1);
  });

  it('no evalúa nada con el almacén en solo lectura (repetiría los avisos)', async () => {
    const h = harness({ content: { schemaVersion: WATCHES_SCHEMA_VERSION + 1, watches: [] } });
    h.scheduler.start();
    expect(h.scheduler.readOnly).toBe(true);
    await h.at(T0);
    await h.at(T0 + 10 * MIN);
    expect(h.calls).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('un vigilante pausado no se evalúa', async () => {
    const h = harness();
    h.store.setStatus(h.store.list()[0]!.id, 'paused');
    h.scheduler.start();
    await h.at(T0);
    expect(h.calls).toEqual([]);
  });

  it('un probe.run que lanza cuenta como fallo de cada comprobación', async () => {
    const h = harness({
      respond: () => {
        throw new Error('no se pudo conectar');
      },
    });
    h.scheduler.start();
    // Tres evaluaciones seguidas: al tercer fallo, avisa de que no puede mirar.
    await h.at(T0);
    await h.at(T0 + 59_000);
    await h.at(T0 + 118_000);
    expect(h.calls).toHaveLength(3);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: 'failing' });
    expect(h.notices[0]!.text).toContain('no se pudo conectar');
  });

  it('un notify que lanza no rompe el ciclo: el estado ya se guardó', async () => {
    const h = harness({ respond: () => on('on') });
    h.state.notifyThrows = true;
    h.scheduler.start();
    await h.at(T0);
    expect(h.notices).toEqual([]);
    const watch = h.store.list()[0]!;
    expect(watch.state.firing).toBe(true);

    // El ciclo siguiente vuelve a mirar (no se ha quedado colgado) y, como ya
    // estaba saltado, no repite el aviso.
    h.state.notifyThrows = false;
    await h.at(T0 + 59_000);
    expect(h.calls).toHaveLength(2);
    expect(h.notices).toEqual([]);
  });

  it('stop() deja de mirar y no arma ningún timer más', async () => {
    const h = harness();
    h.scheduler.start();
    await h.at(T0);
    h.scheduler.stop();
    expect(h.clock.pending()).toEqual([]);
    await h.at(T0 + 10 * MIN);
    expect(h.calls).toHaveLength(1);
  });

  it('un vigilante borrado o pausado a mitad de ciclo no se aplica', async () => {
    let deleted = '';
    let paused = '';
    const h = harness({
      defs: [def({ name: 'borrado' }), def({ name: 'pausado' })],
      respond: () => {
        // Alguien lo cambia desde la CLI mientras la sonda está mirando.
        deleted = h.store.list()[0]!.id;
        paused = h.store.list()[1]!.id;
        h.store.remove(deleted);
        h.store.setStatus(paused, 'paused');
        return on('on');
      },
    });
    h.scheduler.start();
    await h.at(T0);
    expect(h.calls).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.store.get(deleted)).toBeUndefined();
    const remaining = h.store.list();
    expect(remaining.map((w) => w.id)).toEqual([paused]);
    expect(remaining[0]!.state.firing).toBe(false);
    expect(remaining[0]!.status).toBe('paused');
  });

  it('start() aplica stateAfterRestart: ni la cuenta ni los fallos sobreviven', async () => {
    const saved: WatchState = {
      ...INITIAL_WATCH_STATE,
      firing: true,
      pendingSince: T0 - 10 * MIN,
      reference: 'off',
      lastFiredAt: T0 - MIN,
      failures: 2,
      failingNotified: true,
    };
    const h = harness({
      content: {
        schemaVersion: WATCHES_SCHEMA_VERSION,
        watches: [
          {
            ...def(),
            id: 'wat_1',
            status: 'active',
            createdAt: T0 - MIN,
            state: saved,
          },
        ],
      },
    });
    h.scheduler.start();
    const state = h.store.get('wat_1')!.state;
    expect(state).toMatchObject({
      pendingSince: null,
      failures: 0,
      firing: true,
      reference: 'off',
    });
    // Ya estaba saltado: la primera lectura no repite el aviso.
    await h.at(T0);
    expect(h.calls).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it('hasActive dice si hay alguno que pueda saltar', async () => {
    const h = harness({ defs: [] });
    expect(h.scheduler.hasActive).toBe(false);
    h.scheduler.add(def());
    expect(h.scheduler.hasActive).toBe(true);
    h.scheduler.start();
    expect(h.scheduler.hasActive).toBe(true);
    h.scheduler.setStatus(h.store.list()[0]!.id, 'paused');
    expect(h.scheduler.hasActive).toBe(false);
  });

  it('reanudar adelanta el ciclo: no espera al siguiente tick', async () => {
    const h = harness();
    h.scheduler.start();
    await h.at(T0);
    const id = h.store.list()[0]!.id;
    h.scheduler.setStatus(id, 'paused');
    // Pausado no se mira, aunque pase el intervalo.
    await h.at(T0 + 59_000);
    expect(h.calls).toHaveLength(1);
    // Al reanudar se adelanta el ciclo (timer a 0) y vuelve a mirar.
    h.scheduler.setStatus(id, 'active');
    await h.at(T0 + 59_000);
    expect(h.calls).toHaveLength(2);
  });
});

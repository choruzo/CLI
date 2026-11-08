/**
 * M19 — pasada automática de dreaming: horario, sin solapes, sin recuperar lo
 * perdido y un fallo no afecta a las demás memorias.
 */
import { describe, expect, it, vi } from 'vitest';
import { StratumConfigSchema } from '../config/schema.js';
import {
  DREAM_MISSED_GRACE_MS,
  DreamingScheduler,
  type DreamAgent,
  type DreamFire,
} from './dreaming-scheduler.js';

function harness(over: { every?: string; targets?: DreamAgent[]; running?: Set<DreamAgent> } = {}) {
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const fires: DreamFire[] = [];
  const run = vi.fn(async (_agent: DreamAgent) => ({
    status: 'done',
    proposals: [1, 2] as unknown[],
  }));
  const sched = new DreamingScheduler({
    every: over.every ?? '1h',
    targets: over.targets ?? ['companion', 'assistant'],
    run,
    isRunning: (a) => over.running?.has(a) ?? false,
    onFire: (f) => fires.push(f),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return {
    sched,
    run,
    fires,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    live: () => timers.filter((t) => !t.cleared),
  };
}

describe('DreamingScheduler', () => {
  it('arma el siguiente vencimiento y al vencer pasa por cada memoria, sin force', async () => {
    const h = harness();
    h.sched.start();
    expect(h.live()).toHaveLength(1);
    expect(h.sched.nextFireAt).toBe(1_000_000 + 3_600_000);
    h.advance(3_600_000);
    h.timers[0]!.fn();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    expect(h.run.mock.calls.map((c) => c[0])).toEqual(['companion', 'assistant']);
    expect(h.run.mock.calls.every((c) => c.length === 1)).toBe(true);
    await vi.waitFor(() => expect(h.fires).toHaveLength(2));
    expect(h.fires[0]).toMatchObject({
      agent: 'companion',
      outcome: 'ran',
      status: 'done',
      proposals: 2,
    });
    // El siguiente ya estaba armado.
    expect(h.sched.nextFireAt).toBe(1_000_000 + 2 * 3_600_000);
  });

  it('un vencimiento perdido no se recupera', async () => {
    const h = harness();
    h.sched.start();
    h.advance(3_600_000 + DREAM_MISSED_GRACE_MS + 1);
    h.timers[0]!.fn();
    await Promise.resolve();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.fires.map((f) => f.outcome)).toEqual(['missed', 'missed']);
    expect(h.sched.nextFireAt).not.toBeNull();
  });

  it('con una pasada en curso de esa memoria, la salta', async () => {
    const h = harness({ running: new Set<DreamAgent>(['companion']) });
    const out = await h.sched.fireAll();
    expect(out.map((f) => [f.agent, f.outcome])).toEqual([
      ['companion', 'skipped-busy'],
      ['assistant', 'ran'],
    ]);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('el fallo de una memoria no afecta a la siguiente ni lanza', async () => {
    const h = harness();
    h.run.mockRejectedValueOnce(new Error('boom'));
    const out = await h.sched.fireAll();
    expect(out.map((f) => f.outcome)).toEqual(['failed', 'ran']);
  });

  it('un horario inválido no se arma y lo dice', () => {
    const h = harness({ every: 'cada rato' });
    h.sched.start();
    expect(h.sched.error).toMatch(/Valid formats/);
    expect(h.timers).toHaveLength(0);
  });

  it('stop quita el timer y nada vence después', async () => {
    const h = harness();
    h.sched.start();
    h.sched.stop();
    expect(h.live()).toHaveLength(0);
    h.advance(3_600_000);
    h.timers[0]!.fn();
    await Promise.resolve();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('la config trae la pasada apagada, a diario y solo para el companion', () => {
    const cfg = StratumConfigSchema.parse({});
    expect(cfg.memory.dreaming.schedule).toEqual({
      enabled: false,
      every: '1d',
      targets: ['companion'],
    });
    expect(() =>
      StratumConfigSchema.parse({ memory: { dreaming: { schedule: { targets: ['project'] } } } }),
    ).toThrow();
  });
});

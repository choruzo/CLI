import { describe, expect, it } from 'vitest';
import {
  BoxBusyError,
  BoxCommandError,
  BoxUnavailableError,
  type BoxStatus,
} from '../box/manager.js';
import { BoxAutostart, type BoxAutostartOptions } from './box-autostart.js';

function status(state: BoxStatus['state']): BoxStatus {
  return {
    name: 'box',
    state,
    runtime: 'docker',
    image: 'stratum-box:1',
    network: true,
    outdated: false,
    enabled: true,
    exchangeDir: '/x',
    desktop: true,
  };
}

/** Reloj y timers a mano: `fire()` dispara el timer armado. */
function harness(results: (() => Promise<BoxStatus>)[], extra: Partial<BoxAutostartOptions> = {}) {
  let clock = 1_000;
  let pending: { fn: () => void; ms: number } | null = null;
  const logs: string[] = [];
  let calls = 0;
  const auto = new BoxAutostart({
    enabled: true,
    start: () => {
      const r = results[Math.min(calls, results.length - 1)]!;
      calls++;
      return r();
    },
    log: (event) => logs.push(event),
    now: () => clock,
    retryMs: 30_000,
    windowMs: 90_000,
    setTimer: (fn, ms) => {
      pending = { fn, ms };
      return {};
    },
    clearTimer: () => {
      pending = null;
    },
    ...extra,
  });
  return {
    auto,
    logs,
    calls: () => calls,
    armed: () => pending,
    async fire() {
      const p = pending;
      if (!p) throw new Error('no timer armed');
      pending = null;
      clock += p.ms;
      p.fn();
      await auto.idle();
    },
  };
}

describe('BoxAutostart (M23)', () => {
  it('apagado: no hace nada', async () => {
    const h = harness([() => Promise.resolve(status('running'))], { enabled: false });
    h.auto.start();
    await h.auto.idle();
    expect(h.calls()).toBe(0);
    expect(h.auto.state().phase).toBe('off');
  });

  it('arranca la caja una vez y lo dice', async () => {
    const h = harness([() => Promise.resolve(status('running'))]);
    expect(h.auto.state().phase).toBe('pending');
    h.auto.start();
    h.auto.start();
    await h.auto.idle();
    expect(h.calls()).toBe(1);
    expect(h.auto.state()).toMatchObject({ phase: 'started', attempts: 1 });
    expect(h.logs).toEqual(['box autostarted']);
  });

  it('sin runtime reintenta dentro de la ventana y luego se rinde', async () => {
    const noRuntime = () => Promise.reject(new BoxUnavailableError('no runtime yet'));
    const h = harness([noRuntime]);
    h.auto.start();
    await h.auto.idle();
    expect(h.auto.state()).toMatchObject({ phase: 'waiting-runtime', reason: 'no runtime yet' });
    expect(h.armed()?.ms).toBe(30_000);
    await h.fire(); // 30 s
    await h.fire(); // 60 s
    await h.fire(); // 90 s: ya no cabe otro
    expect(h.calls()).toBe(4);
    expect(h.armed()).toBeNull();
    expect(h.auto.state()).toMatchObject({ phase: 'failed', attempts: 4 });
    expect(h.logs).toEqual(['box autostart gave up']);
  });

  it('el runtime aparece a mitad: arranca', async () => {
    const h = harness([
      () => Promise.reject(new BoxUnavailableError('docker is starting')),
      () => Promise.resolve(status('running')),
    ]);
    h.auto.start();
    await h.auto.idle();
    await h.fire();
    expect(h.auto.state()).toMatchObject({ phase: 'started', attempts: 2 });
  });

  it('otra operación en curso: no insiste', async () => {
    const h = harness([() => Promise.reject(new BoxBusyError('busy'))]);
    h.auto.start();
    await h.auto.idle();
    expect(h.auto.state().phase).toBe('skipped-busy');
    expect(h.armed()).toBeNull();
  });

  it('una orden rechazada no se reintenta', async () => {
    const h = harness([() => Promise.reject(new BoxCommandError('image build failed'))]);
    h.auto.start();
    await h.auto.idle();
    expect(h.auto.state()).toMatchObject({ phase: 'failed', reason: 'image build failed' });
    expect(h.armed()).toBeNull();
  });

  it('una caja que no queda en marcha es un fallo, sin adivinar', async () => {
    const h = harness([() => Promise.resolve(status('stopped'))]);
    h.auto.start();
    await h.auto.idle();
    expect(h.auto.state()).toMatchObject({ phase: 'failed', reason: 'The box ended up stopped.' });
  });

  it('stop() cancela el reintento armado', async () => {
    const h = harness([() => Promise.reject(new BoxUnavailableError('no runtime'))]);
    h.auto.start();
    await h.auto.idle();
    expect(h.armed()).not.toBeNull();
    h.auto.stop();
    expect(h.armed()).toBeNull();
    expect(h.calls()).toBe(1);
  });
});

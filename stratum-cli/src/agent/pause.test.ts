/**
 * `PauseController`: la máquina de estados de la pausa cooperativa, sola. Lo
 * que hace el loop con ella está en `pause-flow.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PauseController, pausableTimeout, type PauseState } from './pause.js';

function running(): PauseController {
  const pause = new PauseController();
  pause.begin();
  return pause;
}

/** Deja correr las microtareas pendientes. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function settled(promise: Promise<void>): { done: boolean } {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
}

describe('estados', () => {
  it('sin run no hay nada que pausar ni que reanudar', () => {
    const pause = new PauseController();
    expect(pause.state).toBe('idle');
    expect(pause.requestPause()).toBe('not-running');
    expect(pause.resume()).toBe('not-running');
    expect(pause.state).toBe('idle');
  });

  it('pedir pausa no es estar en pausa: hace falta llegar a un punto seguro', async () => {
    const pause = running();
    const unit = pause.enter();
    expect(pause.requestPause()).toBe('requested');
    expect(pause.state).toBe('pause-requested');

    const wait = settled(pause.waitAtSafePoint());
    expect(pause.state).toBe('paused');
    await tick();
    expect(wait.done).toBe(false);

    expect(pause.resume()).toBe('resumed');
    expect(pause.state).toBe('running');
    await tick();
    expect(wait.done).toBe(true);
    unit.leave();
  });

  it('pausar y reanudar son idempotentes', () => {
    const pause = running();
    expect(pause.resume()).toBe('not-paused');
    expect(pause.requestPause()).toBe('requested');
    expect(pause.requestPause()).toBe('already-requested');
    void pause.waitAtSafePoint();
    expect(pause.requestPause()).toBe('already-paused');
    expect(pause.resume()).toBe('resumed');
    expect(pause.resume()).toBe('not-paused');
    pause.end();
    expect(pause.resume()).toBe('not-running');
  });

  it('reanudar con la pausa solo pedida la retira: nadie llega a esperar', async () => {
    const pause = running();
    pause.requestPause();
    expect(pause.resume()).toBe('resumed');
    const wait = settled(pause.waitAtSafePoint());
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.waiting).toBe(0);
  });

  it('sin pausa pedida, un punto seguro no espera', async () => {
    const pause = running();
    const wait = settled(pause.waitAtSafePoint());
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.state).toBe('running');
  });

  it('la pausa es del turno: al terminar se va con él', async () => {
    const pause = running();
    pause.requestPause();
    const wait = settled(pause.waitAtSafePoint());
    expect(pause.state).toBe('paused');
    pause.end();
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.state).toBe('idle');
    // El turno siguiente empieza limpio.
    pause.begin();
    expect(pause.state).toBe('running');
    expect(pause.pauseRequested).toBe(false);
  });
});

describe('cancelación', () => {
  it('abortar suelta la espera sin pasar por resume', async () => {
    const pause = running();
    const abort = new AbortController();
    pause.requestPause();
    const wait = settled(pause.waitAtSafePoint(abort.signal));
    expect(pause.state).toBe('paused');
    abort.abort();
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.waiting).toBe(0);
  });

  it('con la señal ya abortada no se espera', async () => {
    const pause = running();
    const abort = new AbortController();
    abort.abort();
    pause.requestPause();
    const wait = settled(pause.waitAtSafePoint(abort.signal));
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.state).toBe('pause-requested');
  });
});

describe('varios loops', () => {
  it('no está en pausa mientras quede un loop que pueda empezar algo', () => {
    const pause = running();
    const a = pause.enter();
    const b = pause.enter();
    pause.requestPause();

    void pause.waitAtSafePoint();
    expect(pause.state).toBe('pause-requested');
    void pause.waitAtSafePoint();
    expect(pause.state).toBe('paused');
    a.leave();
    b.leave();
  });

  it('un loop que espera a sus hijos no cuenta', () => {
    const pause = running();
    const parent = pause.enter();
    const unpark = parent.park();
    const child = pause.enter();
    pause.requestPause();

    void pause.waitAtSafePoint();
    expect(pause.state).toBe('paused');
    pause.resume();
    unpark();
    child.leave();

    // De vuelta: ahora sí cuenta.
    const other = pause.enter();
    pause.requestPause();
    void pause.waitAtSafePoint();
    expect(pause.state).toBe('pause-requested');
    other.leave();
    expect(pause.state).toBe('paused');
    parent.leave();
  });

  it('un loop que termina sin pasar por un punto seguro deja de contar', () => {
    const pause = running();
    const a = pause.enter();
    const b = pause.enter();
    pause.requestPause();
    void pause.waitAtSafePoint();
    expect(pause.state).toBe('pause-requested');
    b.leave();
    expect(pause.state).toBe('paused');
    a.leave();
  });

  it('reanudar despierta a todos', async () => {
    const pause = running();
    pause.requestPause();
    const waits = [1, 2, 3].map(() => settled(pause.waitAtSafePoint()));
    expect(pause.waiting).toBe(3);
    pause.resume();
    await tick();
    expect(waits.every((w) => w.done)).toBe(true);
    expect(pause.waiting).toBe(0);
  });
});

describe('carreras', () => {
  it('pausa y reanudación en el mismo instante: gana la última, sin esperas huérfanas', async () => {
    const pause = running();
    const waits: Array<{ done: boolean }> = [];
    for (let i = 0; i < 50; i++) {
      pause.requestPause();
      waits.push(settled(pause.waitAtSafePoint()));
      pause.resume();
    }
    await tick();
    expect(waits.every((w) => w.done)).toBe(true);
    expect(pause.waiting).toBe(0);
    expect(pause.state).toBe('running');
  });

  it('pausa + cancelación y reanudación + cancelación', async () => {
    const pause = running();
    const abort = new AbortController();
    pause.requestPause();
    const wait = settled(pause.waitAtSafePoint(abort.signal));
    abort.abort();
    expect(pause.resume()).toBe('resumed');
    pause.end();
    await tick();
    expect(wait.done).toBe(true);
    expect(pause.waiting).toBe(0);
    expect(pause.state).toBe('idle');
  });

  it('los cambios de estado se avisan una vez cada uno, en orden', () => {
    const pause = new PauseController();
    const seen: PauseState[] = [];
    const off = pause.subscribe((state) => seen.push(state));
    pause.begin();
    pause.requestPause();
    pause.requestPause();
    void pause.waitAtSafePoint();
    void pause.waitAtSafePoint();
    pause.resume();
    pause.resume();
    pause.end();
    pause.end();
    expect(seen).toEqual(['running', 'pause-requested', 'paused', 'running', 'idle']);
    off();
    pause.begin();
    expect(seen).toHaveLength(5);
  });

  it('un oyente que lanza no rompe el control', () => {
    const pause = running();
    pause.subscribe(() => {
      throw new Error('boom');
    });
    expect(pause.requestPause()).toBe('requested');
    expect(pause.resume()).toBe('resumed');
  });
});

describe('pausableTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('vence a su hora si nadie pausa', () => {
    vi.useFakeTimers();
    const clock = pausableTimeout(1000);
    vi.advanceTimersByTime(999);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(clock.signal.aborted).toBe(true);
    clock.dispose();
  });

  it('el tiempo en pausa no cuenta; el de la pausa solo pedida, sí', () => {
    vi.useFakeTimers();
    const pause = running();
    const clock = pausableTimeout(1000, pause);
    vi.advanceTimersByTime(300);
    pause.requestPause();
    vi.advanceTimersByTime(300);
    void pause.waitAtSafePoint();
    expect(pause.state).toBe('paused');

    vi.advanceTimersByTime(60_000);
    expect(clock.signal.aborted).toBe(false);

    pause.resume();
    vi.advanceTimersByTime(399);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(clock.signal.aborted).toBe(true);
    clock.dispose();
  });

  it('dispose suelta el temporizador y la suscripción', () => {
    vi.useFakeTimers();
    const pause = running();
    const clock = pausableTimeout(1000, pause);
    clock.dispose();
    vi.advanceTimersByTime(5000);
    pause.requestPause();
    void pause.waitAtSafePoint();
    pause.resume();
    vi.advanceTimersByTime(5000);
    expect(clock.signal.aborted).toBe(false);
  });
});

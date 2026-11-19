/**
 * M22 — la máquina de estados de un vigilante: flanco, «durante N minutos»,
 * descanso entre saltos, `changes`, umbral sin valor, fallos y suspensión.
 * Pura: todo se prueba con `stepWatch` y un reloj que se pasa por parámetro.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_LIMITS } from '../protocol/index.js';
import type { CheckResult } from '../connectors/checks.js';
import type { WatchCondition } from './condition.js';
import {
  INITIAL_WATCH_STATE,
  stateAfterRestart,
  stepWatch,
  type WatchInput,
  type WatchNoticeKind,
  type WatchRule,
  type WatchState,
} from './engine.js';

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const MIN = 60_000;

const rule = (
  condition: WatchCondition,
  opts: { cooldownMinutes?: number; notifyResolved?: boolean } = {},
): WatchRule => ({
  condition,
  cooldownMinutes: opts.cooldownMinutes ?? 0,
  notifyResolved: opts.notifyResolved ?? false,
});

const result = (estado: string, valor: number | null = null, detalle = ''): CheckResult => ({
  estado,
  valor,
  detalle,
});

const ok = (estado: string, valor: number | null = null): WatchInput => ({
  kind: 'result',
  result: result(estado, valor),
});
const failure = (reason = 'timeout'): WatchInput => ({ kind: 'failure', reason });
const suspended = (reason = 'la caja no está en marcha'): WatchInput => ({
  kind: 'suspended',
  reason,
});

/** Los pasos de una secuencia, con el estado encadenado. */
function run(
  r: WatchRule,
  inputs: Array<{ at: number; input: WatchInput }>,
  from: WatchState = INITIAL_WATCH_STATE,
): { state: WatchState; notices: Array<WatchNoticeKind | null> } {
  let state = from;
  const notices: Array<WatchNoticeKind | null> = [];
  for (const { at, input } of inputs) {
    const step = stepWatch(r, state, input, at);
    state = step.state;
    notices.push(step.notice);
  }
  return { state, notices };
}

describe('M22 — stepWatch: cada condición', () => {
  it('state-is salta al cumplirse y no repite mientras siga cumpliéndose', () => {
    const r = rule({ kind: 'state-is', values: ['on'] });
    const first = stepWatch(r, INITIAL_WATCH_STATE, ok('on'), T0);
    expect(first.notice).toBe('fired');
    expect(first.state).toMatchObject({ firing: true, lastFiredAt: T0, pendingSince: null });
    const second = stepWatch(r, first.state, ok('on'), T0 + MIN);
    expect(second.notice).toBeNull();
    expect(second.state.firing).toBe(true);
  });

  it('state-is-not salta cuando el estado no es ninguno de los valores', () => {
    const r = rule({ kind: 'state-is-not', values: ['closed'] });
    expect(stepWatch(r, INITIAL_WATCH_STATE, ok('closed'), T0).notice).toBeNull();
    expect(stepWatch(r, INITIAL_WATCH_STATE, ok('open'), T0).notice).toBe('fired');
  });

  it('above y below saltan solo al pasar el umbral, y un valor nulo no cambia nada', () => {
    const above = rule({ kind: 'above', threshold: 22 });
    expect(stepWatch(above, INITIAL_WATCH_STATE, ok('x', 21), T0).notice).toBeNull();
    expect(stepWatch(above, INITIAL_WATCH_STATE, ok('x', 23), T0).notice).toBe('fired');

    const below = rule({ kind: 'below', threshold: 5 });
    expect(stepWatch(below, INITIAL_WATCH_STATE, ok('x', 6), T0).notice).toBeNull();
    expect(stepWatch(below, INITIAL_WATCH_STATE, ok('x', 4), T0).notice).toBe('fired');

    // Sin valor numérico no se puede saber: ni salta ni se resuelve ni reinicia la cuenta.
    const pending = stepWatch(above, INITIAL_WATCH_STATE, ok('x', 10), T0).state;
    expect(pending.pendingSince).toBeNull();
    const unknown = stepWatch(above, pending, ok('desconocido'), T0 + MIN);
    expect(unknown.notice).toBeNull();
    expect(unknown.state).toEqual(pending);
    const firing = stepWatch(above, INITIAL_WATCH_STATE, ok('x', 30), T0).state;
    const stillFiring = stepWatch(above, firing, ok('desconocido'), T0 + MIN);
    expect(stillFiring.notice).toBeNull();
    expect(stillFiring.state.firing).toBe(true);
    expect(stillFiring.state.lastFiredAt).toBe(T0);
  });
});

describe('M22 — stepWatch: el flanco', () => {
  const r = rule({ kind: 'state-is', values: ['on'] });

  it('resolved solo con notifyResolved, y solo si estaba saltado', () => {
    const quiet = rule({ kind: 'state-is', values: ['on'] });
    const fired = stepWatch(quiet, INITIAL_WATCH_STATE, ok('on'), T0).state;
    const back = stepWatch(quiet, fired, ok('off'), T0 + MIN);
    expect(back.notice).toBeNull();
    expect(back.state.firing).toBe(false);

    const loud = rule({ kind: 'state-is', values: ['on'] }, { notifyResolved: true });
    const fired2 = stepWatch(loud, INITIAL_WATCH_STATE, ok('on'), T0).state;
    const back2 = stepWatch(loud, fired2, ok('off'), T0 + MIN);
    expect(back2.notice).toBe('resolved');
    expect(back2.state.firing).toBe(false);
    // Ya resuelto, seguir en falso no repite el aviso.
    expect(stepWatch(loud, back2.state, ok('off'), T0 + 2 * MIN).notice).toBeNull();
    // Y sin haber saltado nunca, no hay nada que resolver.
    expect(stepWatch(loud, INITIAL_WATCH_STATE, ok('off'), T0).notice).toBeNull();
  });

  it('vuelve a saltar al recuperarse, una sola vez por flanco', () => {
    const { notices } = run(r, [
      { at: T0, input: ok('off') },
      { at: T0 + MIN, input: ok('on') },
      { at: T0 + 2 * MIN, input: ok('on') },
      { at: T0 + 3 * MIN, input: ok('off') },
      { at: T0 + 4 * MIN, input: ok('on') },
      { at: T0 + 5 * MIN, input: ok('on') },
    ]);
    expect(notices).toEqual([null, 'fired', null, null, 'fired', null]);
  });
});

describe('M22 — stepWatch: «durante al menos N minutos»', () => {
  const r = rule({ kind: 'state-is', values: ['on'], forMinutes: 5 });

  it('no salta antes y salta al cumplirse', () => {
    const { notices, state } = run(r, [
      { at: T0, input: ok('on') },
      { at: T0 + 2 * MIN, input: ok('on') },
      { at: T0 + 5 * MIN, input: ok('on') },
      { at: T0 + 6 * MIN, input: ok('on') },
    ]);
    expect(notices).toEqual([null, null, 'fired', null]);
    expect(state).toMatchObject({ firing: true, lastFiredAt: T0 + 5 * MIN });
  });

  it('un falso en medio reinicia la cuenta', () => {
    const { notices, state } = run(r, [
      { at: T0, input: ok('on') },
      { at: T0 + 3 * MIN, input: ok('on') },
      { at: T0 + 4 * MIN, input: ok('off') },
      { at: T0 + 5 * MIN, input: ok('on') },
      { at: T0 + 9 * MIN, input: ok('on') },
      { at: T0 + 10 * MIN, input: ok('on') },
    ]);
    expect(notices).toEqual([null, null, null, null, null, 'fired']);
    expect(state.lastFiredAt).toBe(T0 + 10 * MIN);
  });
});

describe('M22 — stepWatch: descanso entre saltos', () => {
  const r = rule({ kind: 'state-is', values: ['on'] }, { cooldownMinutes: 30 });

  it('dentro del descanso no salta; al acabar sí, si sigue cumpliéndose', () => {
    const { notices, state } = run(r, [
      { at: T0, input: ok('on') },
      { at: T0 + MIN, input: ok('off') },
      { at: T0 + 2 * MIN, input: ok('on') },
      { at: T0 + 20 * MIN, input: ok('on') },
      { at: T0 + 29 * MIN, input: ok('on') },
      { at: T0 + 30 * MIN, input: ok('on') },
    ]);
    expect(notices).toEqual(['fired', null, null, null, null, 'fired']);
    expect(state.lastFiredAt).toBe(T0 + 30 * MIN);
  });
});

describe('M22 — stepWatch: changes', () => {
  const r = rule({ kind: 'changes' });

  it('el primer resultado solo anota la referencia', () => {
    const first = stepWatch(r, INITIAL_WATCH_STATE, ok('off'), T0);
    expect(first.notice).toBeNull();
    expect(first.state.reference).toBe('off');
    expect(first.state.lastFiredAt).toBeNull();
  });

  it('salta al cambiar y actualiza la referencia', () => {
    const first = stepWatch(r, INITIAL_WATCH_STATE, ok('off'), T0);
    const same = stepWatch(r, first.state, ok('off'), T0 + MIN);
    expect(same.notice).toBeNull();
    expect(same.state.reference).toBe('off');

    const changed = stepWatch(r, same.state, ok('on'), T0 + 2 * MIN);
    expect(changed.notice).toBe('fired');
    expect(changed.state.reference).toBe('on');
    expect(changed.state.lastFiredAt).toBe(T0 + 2 * MIN);
    // Y el siguiente cambio vuelve a saltar.
    expect(stepWatch(r, changed.state, ok('off'), T0 + 3 * MIN).notice).toBe('fired');
  });

  it('con «durante N minutos», el cambio tiene que sostenerse', () => {
    const held = rule({ kind: 'changes', forMinutes: 2 });
    const first = stepWatch(held, INITIAL_WATCH_STATE, ok('off'), T0);
    const changed = stepWatch(held, first.state, ok('on'), T0 + MIN);
    expect(changed.notice).toBeNull();
    expect(changed.state.pendingSince).toBe(T0 + MIN);
    // Volver al valor de referencia borra la cuenta.
    const back = stepWatch(held, changed.state, ok('off'), T0 + 2 * MIN);
    expect(back.state.pendingSince).toBeNull();
    // Y sostenido, salta al cumplirse.
    const again = stepWatch(held, back.state, ok('on'), T0 + 3 * MIN);
    const done = stepWatch(held, again.state, ok('on'), T0 + 5 * MIN);
    expect(done.notice).toBe('fired');
    expect(done.state.reference).toBe('on');
  });

  it('respeta el descanso entre dos cambios', () => {
    const slow = rule({ kind: 'changes' }, { cooldownMinutes: 10 });
    const first = stepWatch(slow, INITIAL_WATCH_STATE, ok('off'), T0);
    const fired = stepWatch(slow, first.state, ok('on'), T0 + MIN);
    expect(fired.notice).toBe('fired');
    const quick = stepWatch(slow, fired.state, ok('off'), T0 + 2 * MIN);
    expect(quick.notice).toBeNull();
    const later = stepWatch(slow, quick.state, ok('off'), T0 + 11 * MIN);
    expect(later.notice).toBe('fired');
  });
});

describe('M22 — stepWatch: fallos de la comprobación', () => {
  const r = rule({ kind: 'state-is', values: ['on'] });

  it(`avisa una sola vez al ${WATCH_LIMITS.failuresBeforeNotice}.º fallo seguido`, () => {
    const { notices, state } = run(r, [
      { at: T0, input: failure() },
      { at: T0 + MIN, input: failure() },
      { at: T0 + 2 * MIN, input: failure() },
      { at: T0 + 3 * MIN, input: failure() },
    ]);
    expect(notices).toEqual([null, null, 'failing', null]);
    expect(state).toMatchObject({ failures: 4, failingNotified: true });
  });

  it('un fallo nunca salta, y un éxito reinicia la cuenta', () => {
    const state = stepWatch(r, INITIAL_WATCH_STATE, ok('on'), T0).state;
    const failing = stepWatch(r, state, failure(), T0 + MIN).state;
    expect(failing.firing).toBe(true);
    expect(failing.failures).toBe(1);

    const drained = stepWatch(r, failing, ok('on'), T0 + 2 * MIN);
    expect(drained.state).toMatchObject({ failures: 0, failingNotified: false });
    expect(drained.notice).toBeNull();

    const { notices } = run(
      r,
      [
        { at: T0 + 3 * MIN, input: failure() },
        { at: T0 + 4 * MIN, input: failure() },
      ],
      drained.state,
    );
    expect(notices).toEqual([null, null]);
  });
});

describe('M22 — stepWatch: suspendido', () => {
  const r = rule({ kind: 'state-is', values: ['on'] });

  it('avisa una sola vez, y se vuelve a avisar tras una lectura buena', () => {
    const first = stepWatch(r, INITIAL_WATCH_STATE, suspended(), T0);
    expect(first.notice).toBe('suspended');
    expect(first.state.suspendedNotified).toBe(true);

    const again = stepWatch(r, first.state, suspended('otra vez'), T0 + MIN);
    expect(again.notice).toBeNull();

    const recovered = stepWatch(r, again.state, ok('off'), T0 + 2 * MIN);
    expect(recovered.state.suspendedNotified).toBe(false);
    expect(stepWatch(r, recovered.state, suspended(), T0 + 3 * MIN).notice).toBe('suspended');
  });

  it('la cuenta de «durante N minutos» vuelve a empezar y los fallos se olvidan', () => {
    const held = rule({ kind: 'state-is', values: ['on'], forMinutes: 5 });
    const started = stepWatch(held, INITIAL_WATCH_STATE, ok('on'), T0).state;
    expect(started.pendingSince).toBe(T0);
    const failed = stepWatch(held, started, failure(), T0 + MIN).state;
    expect(failed.failures).toBe(1);

    const away = stepWatch(held, failed, suspended(), T0 + 2 * MIN);
    expect(away.state).toMatchObject({ pendingSince: null, failures: 0 });

    // Al volver, la cuenta empieza de cero: no salta hasta 5 min después.
    const back = stepWatch(held, away.state, ok('on'), T0 + 3 * MIN);
    expect(back.notice).toBeNull();
    expect(back.state.pendingSince).toBe(T0 + 3 * MIN);
    expect(stepWatch(held, back.state, ok('on'), T0 + 7 * MIN).notice).toBeNull();
    expect(stepWatch(held, back.state, ok('on'), T0 + 8 * MIN).notice).toBe('fired');
  });
});

describe('M22 — stateAfterRestart', () => {
  it('conserva si estaba saltado y la referencia, y reinicia la cuenta y los fallos', () => {
    const before: WatchState = {
      firing: true,
      pendingSince: T0,
      reference: 'off',
      lastFiredAt: T0 - MIN,
      failures: 2,
      failingNotified: true,
      suspendedNotified: true,
    };
    expect(stateAfterRestart(before)).toEqual({
      ...before,
      pendingSince: null,
      failures: 0,
    });
  });

  it('lo que pasó con el daemon apagado no se recupera: no salta otra vez', () => {
    const r = rule({ kind: 'state-is', values: ['on'] });
    const fired: WatchState = { ...INITIAL_WATCH_STATE, firing: true, lastFiredAt: T0 - MIN };
    const step = stepWatch(r, stateAfterRestart(fired), ok('on'), T0);
    expect(step.notice).toBeNull();
    expect(step.state.firing).toBe(true);
  });

  it('sin haber saltado, la primera lectura vuelve a contar desde cero', () => {
    const r = rule({ kind: 'state-is', values: ['on'], forMinutes: 5 });
    const pending: WatchState = { ...INITIAL_WATCH_STATE, pendingSince: T0 - 10 * MIN };
    const step = stepWatch(r, stateAfterRestart(pending), ok('on'), T0);
    expect(step.notice).toBeNull();
    expect(step.state.pendingSince).toBe(T0);
  });
});

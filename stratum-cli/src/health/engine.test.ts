import { describe, expect, it } from 'vitest';
import {
  HEALTH_FAILURES_BEFORE_NOTICE,
  INITIAL_CONNECTOR_HEALTH,
  accessStatusOf,
  stepConnectorHealth,
  type AccessStatus,
  type ConnectorHealthState,
} from './engine.js';

function run(statuses: AccessStatus[], from: ConnectorHealthState = INITIAL_CONNECTOR_HEALTH) {
  let state = from;
  const notices: (string | null)[] = [];
  for (const s of statuses) {
    const step = stepConnectorHealth(state, s);
    state = step.state;
    notices.push(step.notice);
  }
  return { state, notices };
}

describe('stepConnectorHealth', () => {
  it('ok sin nada avisado no avisa', () => {
    expect(run(['ok', 'ok']).notices).toEqual([null, null]);
  });

  it('auth avisa a la primera y no se repite', () => {
    const { notices, state } = run(['auth', 'auth', 'auth']);
    expect(notices).toEqual(['auth', null, null]);
    expect(state.notified).toBe('auth');
  });

  it('un fallo de red avisa solo al segundo seguido', () => {
    expect(HEALTH_FAILURES_BEFORE_NOTICE).toBe(2);
    expect(run(['unreachable', 'error', 'error']).notices).toEqual([null, 'failing', null]);
  });

  it('un ok entre fallos reinicia la cuenta', () => {
    expect(run(['unreachable', 'ok', 'unreachable']).notices).toEqual([null, null, null]);
  });

  it('volver a ok tras un aviso avisa una vez de que funciona', () => {
    expect(run(['auth', 'ok', 'ok']).notices).toEqual(['auth', 'recovered', null]);
    expect(run(['error', 'error', 'ok']).notices).toEqual([null, 'failing', 'recovered']);
  });

  it('un fallo de red tras auth no cambia lo avisado', () => {
    const { notices, state } = run(['auth', 'unreachable', 'unreachable', 'unreachable']);
    expect(notices).toEqual(['auth', null, null, null]);
    expect(state.notified).toBe('auth');
  });

  it('auth tras «falla» avisa (es otra causa)', () => {
    expect(run(['error', 'error', 'auth']).notices).toEqual([null, 'failing', 'auth']);
  });

  it('lo avisado antes de reiniciar no se repite', () => {
    expect(run(['auth'], { failures: 0, notified: 'auth' }).notices).toEqual([null]);
    expect(run(['error', 'error'], { failures: 0, notified: 'failing' }).notices).toEqual([
      null,
      null,
    ]);
  });
});

describe('accessStatusOf', () => {
  it('reconoce los cuatro estados y lo demás es error', () => {
    expect(accessStatusOf('ok')).toBe('ok');
    expect(accessStatusOf('auth')).toBe('auth');
    expect(accessStatusOf('unreachable')).toBe('unreachable');
    expect(accessStatusOf('error')).toBe('error');
    expect(accessStatusOf('OK')).toBe('error');
    expect(accessStatusOf('')).toBe('error');
  });
});

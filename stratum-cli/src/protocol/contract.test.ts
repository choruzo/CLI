import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  EVENT_CLASS,
  METHODS,
  OVERVIEW_EVENT_TYPES,
  PROTOCOL_ERROR_CODES,
  ROLES,
  ROLE_CAPABILITIES,
  STRATUM_PROTOCOL_VERSION,
  capabilitiesOf,
  isErrorResponse,
  isMethodName,
  isProtocolErrorCode,
  isStateEvent,
  messageKind,
  type MethodName,
  type ProtocolEvent,
} from './index.js';

describe('contrato del protocolo', () => {
  it('versión 1', () => {
    expect(STRATUM_PROTOCOL_VERSION).toBe(1);
  });

  it('códigos de error: los que un cliente necesita distinguir', () => {
    for (const code of [
      'PROTOCOL_MISMATCH',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'METHOD_NOT_FOUND',
      'INVALID_PARAMS',
      'NOT_FOUND',
      'BUSY',
      'ALREADY_RESOLVED',
      'STALE_STATE',
      'INTERNAL_ERROR',
    ]) {
      expect(PROTOCOL_ERROR_CODES).toContain(code);
      expect(isProtocolErrorCode(code)).toBe(true);
    }
    expect(isProtocolErrorCode('Boom')).toBe(false);
    expect(new Set(PROTOCOL_ERROR_CODES).size).toBe(PROTOCOL_ERROR_CODES.length);
  });
});

describe('roles y capacidades', () => {
  it('cancelar, pausar o redirigir no es aprobar', () => {
    const control: MethodName[] = ['runs.cancel', 'runs.pause', 'runs.resume', 'runs.steer'];
    const approve: MethodName[] = ['approvals.resolve', 'questions.answer', 'plans.decide'];
    for (const m of control) expect(METHODS[m].capability).toBe('control');
    for (const m of approve) expect(METHODS[m].capability).toBe('approve');

    expect(ROLE_CAPABILITIES.operator).not.toContain('approve');
    expect(ROLE_CAPABILITIES.approver).not.toContain('control');
    expect(ROLE_CAPABILITIES.host).not.toContain('approve');
    expect(ROLE_CAPABILITIES.host).not.toContain('control');
  });

  it('observer solo lee: ningún método que cambie algo exige únicamente `observe`', () => {
    expect(ROLE_CAPABILITIES.observer).toEqual(['observe']);
    const leaks = (Object.keys(METHODS) as MethodName[]).filter(
      (m) => METHODS[m].mutating && METHODS[m].capability === 'observe',
    );
    expect(leaks).toEqual([]);
  });

  it('cada rol existe en la tabla y sus capacidades son conocidas', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      for (const cap of ROLE_CAPABILITIES[role]) expect(CAPABILITIES).toContain(cap);
    }
  });

  it('capabilitiesOf une roles sin repetir', () => {
    expect(capabilitiesOf(['operator', 'approver'])).toEqual(['observe', 'control', 'approve']);
    expect(capabilitiesOf([])).toEqual([]);
  });
});

describe('métodos', () => {
  const names = Object.keys(METHODS) as MethodName[];

  it('solo core.hello va sin capacidad', () => {
    expect(names.filter((m) => METHODS[m].capability === null)).toEqual(['core.hello']);
  });

  it('las operaciones que no se pueden reenviar a ciegas están marcadas como mutantes', () => {
    for (const m of [
      'approvals.resolve',
      'runs.start',
      'runs.cancel',
      'sessions.open',
      'sessions.detach',
      'host.publish',
      'host.handoffBegin',
      'host.handoffCommit',
    ] as const) {
      expect(METHODS[m].mutating, m).toBe(true);
    }
    for (const m of ['sessions.list', 'runs.get', 'events.subscribe', 'core.hello'] as const) {
      expect(METHODS[m].mutating, m).toBe(false);
    }
  });

  it('lo que el servidor pide a un anfitrión exige la capacidad host', () => {
    const toHost = names.filter((m) => METHODS[m].direction === 'server-to-host');
    expect(toHost.length).toBeGreaterThan(0);
    for (const m of toHost) expect(METHODS[m].capability).toBe('host');
  });

  it('isMethodName no se deja engañar por el prototipo', () => {
    expect(isMethodName('runs.start')).toBe(true);
    expect(isMethodName('toString')).toBe(false);
    expect(isMethodName('constructor')).toBe(false);
  });
});

describe('eventos', () => {
  it('solo los fragmentos de texto son volátiles', () => {
    const volatile = Object.entries(EVENT_CLASS)
      .filter(([, cls]) => cls === 'volatile')
      .map(([type]) => type);
    expect(volatile.sort()).toEqual(['message.delta', 'reasoning.delta']);
  });

  it('un evento de estado lleva seq; uno volátil lleva after y ningún seq', () => {
    const state: ProtocolEvent = {
      type: 'message.completed',
      sessionId: 's1',
      at: 1,
      seq: 4,
      data: { text: 'hola' },
    };
    const volatile: ProtocolEvent = {
      type: 'message.delta',
      sessionId: 's1',
      at: 1,
      after: 3,
      data: { text: 'ho' },
    };
    expect(isStateEvent(state)).toBe(true);
    expect(isStateEvent(volatile)).toBe(false);
    expect('seq' in volatile).toBe(false);
  });

  it('el resumen solo lleva eventos de estado', () => {
    for (const type of OVERVIEW_EVENT_TYPES) expect(EVENT_CLASS[type]).toBe('state');
  });
});

describe('messageKind', () => {
  it('distingue petición, respuesta y notificación por su forma', () => {
    expect(messageKind({ id: 1, method: 'core.status' })).toBe('request');
    expect(messageKind({ id: 'a', method: 'runs.get', params: {} })).toBe('request');
    expect(messageKind({ method: 'events', params: {} })).toBe('notification');
    expect(messageKind({ id: 1, result: {} })).toBe('response');
    expect(messageKind({ id: null, error: { code: 'INVALID_REQUEST', message: 'x' } })).toBe(
      'response',
    );
  });

  it('rechaza lo que no es ninguna de las tres', () => {
    for (const bad of [
      null,
      42,
      'hola',
      [],
      {},
      { id: 1 },
      { id: 1, method: 'x', result: {} },
      { id: 1, result: {}, error: { code: 'BUSY', message: '' } },
      { id: {}, method: 'x' },
      { id: null, result: {} },
      { result: {} },
      { method: 7 },
    ]) {
      expect(messageKind(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('isErrorResponse', () => {
    expect(isErrorResponse({ id: 1, error: { code: 'BUSY', message: '' } })).toBe(true);
    expect(isErrorResponse({ id: 1, result: {} })).toBe(false);
  });
});

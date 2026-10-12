import { describe, it, expect } from 'vitest';
import { METHODS, type Capability, type MethodName, type Role } from '../protocol/index.js';
import { GRANTABLE, authorize, grantCapabilities } from './authorize.js';

const methods = Object.keys(METHODS) as MethodName[];
const as = (...roles: Role[]): { authenticated: boolean; capabilities: Capability[] } => ({
  authenticated: true,
  capabilities: grantCapabilities(roles),
});
const code = (principal: ReturnType<typeof as>, method: MethodName): string | null =>
  authorize(principal, method)?.code ?? null;

describe('autorización por capacidad', () => {
  it('antes del handshake no se atiende ningún método salvo core.hello', () => {
    const anonymous = { authenticated: false, capabilities: [] as Capability[] };
    for (const method of methods) {
      expect(authorize(anonymous, method)?.code ?? null, method).toBe(
        method === 'core.hello' ? null : 'UNAUTHORIZED',
      );
    }
    // Tener capacidades «apuntadas» sin haberse autenticado tampoco vale.
    const forged = { authenticated: false, capabilities: [...GRANTABLE] };
    expect(authorize(forged, 'runs.cancel')?.code).toBe('UNAUTHORIZED');
  });

  it('observer lee y no controla', () => {
    const observer = as('observer');
    expect(code(observer, 'sessions.list')).toBeNull();
    expect(code(observer, 'events.subscribe')).toBeNull();
    expect(code(observer, 'runs.cancel')).toBe('FORBIDDEN');
    expect(code(observer, 'sessions.open')).toBe('FORBIDDEN');
    expect(code(observer, 'approvals.resolve')).toBe('FORBIDDEN');
  });

  it('operator cancela y no aprueba', () => {
    const operator = as('operator');
    expect(code(operator, 'runs.cancel')).toBeNull();
    expect(code(operator, 'sessions.open')).toBeNull();
    for (const m of ['approvals.resolve', 'questions.answer', 'plans.decide'] as const) {
      expect(authorize(operator, m)).toMatchObject({
        code: 'FORBIDDEN',
        data: { capability: 'approve' },
      });
    }
  });

  it('approver aprueba y no cancela', () => {
    const approver = as('approver');
    expect(code(approver, 'approvals.resolve')).toBeNull();
    expect(code(approver, 'approvals.list')).toBeNull();
    expect(authorize(approver, 'runs.cancel')).toMatchObject({
      code: 'FORBIDDEN',
      data: { capability: 'control' },
    });
    expect(code(approver, 'core.shutdown')).toBe('FORBIDDEN');
  });

  it('la regla sale de la tabla del protocolo, para todos los métodos y todos los roles', () => {
    const principals = [as('observer'), as('operator'), as('approver'), as('operator', 'approver')];
    for (const principal of principals) {
      for (const method of methods) {
        if (method === 'core.hello') continue;
        const info = METHODS[method];
        const expected =
          info.direction !== 'client-to-server'
            ? 'METHOD_NOT_FOUND'
            : info.capability && !principal.capabilities.includes(info.capability)
              ? 'FORBIDDEN'
              : null;
        expect(code(principal, method), method).toBe(expected);
      }
    }
  });

  it('broker no se concede todavía; host sí, y no trae control ni approve', () => {
    expect(grantCapabilities(['host'])).toEqual(['observe', 'host']);
    expect(grantCapabilities(['broker'])).toEqual([]);
    expect(grantCapabilities(['operator', 'approver'])).toEqual(['observe', 'control', 'approve']);

    const host = { authenticated: true, capabilities: grantCapabilities(['host']) };
    expect(authorize(host, 'host.register')).toBeNull();
    expect(authorize(host, 'host.publish')).toBeNull();
    expect(authorize(host, 'host.unregister')).toBeNull();
    // Alojar una sesión no da derecho a gobernar ni a aprobar nada.
    for (const method of [
      'runs.cancel',
      'runs.steer',
      'runs.start',
      'sessions.open',
      'sessions.close',
      'core.shutdown',
      'approvals.resolve',
      'questions.answer',
      'plans.decide',
    ] as const) {
      expect(authorize(host, method)?.code, method).toBe('FORBIDDEN');
    }
    // Y lo que el servidor le pide a un anfitrión no lo puede pedir un cliente.
    expect(authorize(host, 'host.cancel')?.code).toBe('METHOD_NOT_FOUND');
    // Un operador no publica sesiones.
    const operator = { authenticated: true, capabilities: grantCapabilities(['operator']) };
    expect(authorize(operator, 'host.publish')?.code).toBe('FORBIDDEN');
  });

  it('un segundo core.hello en una conexión ya autenticada se rechaza', () => {
    expect(code(as('operator'), 'core.hello')).toBe('INVALID_REQUEST');
  });
});

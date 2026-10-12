import { describe, it, expect } from 'vitest';
import {
  INTERNAL_ERROR_MESSAGE,
  ProtocolError,
  decodeMessage,
  encodeMessage,
  toErrorPayload,
  validateNotification,
  validateRequest,
  validateResult,
} from './codec.js';
import { sampleRun, sampleSession, sampleSnapshot } from '../protocol/protocol.fixtures.js';

describe('decodeMessage', () => {
  it('ida y vuelta de las tres formas', () => {
    const request = { id: 7, method: 'runs.get', params: { runId: 'run_1' } };
    const notification = { method: 'goodbye', params: { reason: 'shutdown' } };
    const response = { id: 7, result: { run: sampleRun() } };
    const failure = { id: 7, error: { code: 'NOT_FOUND', message: 'No such run.' } } as const;

    expect(decodeMessage(encodeMessage(request))).toEqual({ kind: 'request', message: request });
    expect(decodeMessage(encodeMessage(notification))).toEqual({
      kind: 'notification',
      message: notification,
    });
    expect(decodeMessage(encodeMessage(response))).toEqual({ kind: 'response', message: response });
    expect(decodeMessage(encodeMessage(failure))).toEqual({ kind: 'response', message: failure });
  });

  it('una línea es un mensaje: el texto con saltos va escapado', () => {
    const line = encodeMessage({ method: 'events', params: { text: 'a\nb\r\nc' } });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('lo que no es JSON o no es un mensaje sale como invalid, sin lanzar', () => {
    for (const line of ['', '{', 'null', '42', '"hola"', '[]', '{}', '{"id":1}']) {
      const decoded = decodeMessage(line);
      expect(decoded.kind, line).toBe('invalid');
      if (decoded.kind === 'invalid') expect(decoded.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('conserva el id de una petición mal formada, para poder contestarla', () => {
    const decoded = decodeMessage('{"id":9,"method":"x","extra":true}');
    expect(decoded).toMatchObject({ kind: 'invalid', id: 9 });
    expect(decodeMessage('{"id":{},"method":"x"}')).toMatchObject({ kind: 'invalid', id: null });
  });
});

describe('validateRequest', () => {
  it('método desconocido → METHOD_NOT_FOUND', () => {
    const result = validateRequest('runs.explode', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_FOUND' } });
    expect(validateRequest('constructor', {})).toMatchObject({ ok: false });
  });

  it('parámetros que no validan → INVALID_PARAMS con la ruta, sin el valor', () => {
    const secret = 'sk-live-0123456789';
    const result = validateRequest('runs.start', { sessionId: 's', input: 7, token: secret });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PARAMS');
    expect(result.error.data?.issues?.map((i) => i.path)).toContain('input');
    expect(JSON.stringify(result.error)).not.toContain(secret);
  });

  it('sin params equivale a un objeto vacío', () => {
    expect(validateRequest('core.status', undefined)).toEqual({
      ok: true,
      method: 'core.status',
      params: {},
    });
    expect(validateRequest('runs.get', undefined).ok).toBe(false);
  });

  it('devuelve los parámetros ya validados', () => {
    const result = validateRequest('runs.cancel', { sessionId: 's1', runId: 'run_1' });
    expect(result).toEqual({
      ok: true,
      method: 'runs.cancel',
      params: { sessionId: 's1', runId: 'run_1' },
    });
  });
});

describe('validateResult y validateNotification', () => {
  it('un resultado se queda con los campos del contrato', () => {
    const checked = validateResult('sessions.open', {
      session: { ...sampleSession(), env: { K: 'v' } },
    });
    expect(checked).toEqual({ ok: true, result: { session: sampleSession() } });
    expect(validateResult('sessions.open', { session: { id: 's' } })).toEqual({ ok: false });
  });

  it('una notificación desconocida o mal formada se ignora (null)', () => {
    expect(validateNotification('something.new', {})).toBeNull();
    expect(validateNotification('snapshot', { subscriptionId: 'x' })).toBeNull();
    expect(
      validateNotification('snapshot', { subscriptionId: 'sub1', snapshot: sampleSnapshot() }),
    ).toEqual({ name: 'snapshot', params: { subscriptionId: 'sub1', snapshot: sampleSnapshot() } });
  });
});

describe('errores hacia el otro extremo', () => {
  it('un ProtocolError conserva su código, su mensaje y sus datos', () => {
    const err = new ProtocolError('BUSY', 'Session has a run in progress.');
    expect(toErrorPayload(err)).toEqual({
      code: 'BUSY',
      message: 'Session has a run in progress.',
    });
    expect(
      toErrorPayload(new ProtocolError('FORBIDDEN', 'Not allowed.', { capability: 'approve' })),
    ).toEqual({ code: 'FORBIDDEN', message: 'Not allowed.', data: { capability: 'approve' } });
  });

  it('cualquier otra excepción sale como INTERNAL_ERROR, sin stack, rutas ni su mensaje', () => {
    const boom = new Error(
      'ENOENT: no such file, open C:\\Users\\javie\\.stratum\\secrets.json (API_KEY=sk-live-123)',
    );
    const payload = toErrorPayload(boom);
    expect(payload).toEqual({ code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE });
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('javie');
    expect(wire).not.toContain('sk-live');
    expect(wire).not.toContain('at ');
    expect(toErrorPayload('cadena')).toEqual(payload);
    expect(toErrorPayload(undefined)).toEqual(payload);
  });
});

import { describe, it, expect } from 'vitest';
import { initialSidecarState, isOperational, sidecarReducer, type SidecarState } from './useSidecar';
import type { SidecarStatus } from '../ipc/types';

const connected: SidecarStatus = {
  state: 'connected',
  core: {
    version: '0.4.0',
    protocolVersion: 1,
    configSchemaVersion: 1,
    sessionSchemaVersion: 1,
    platform: 'win32',
    node: '22.20.0',
    sea: true,
  },
  natives: [],
};

function withStatus(status: SidecarStatus): SidecarState {
  return sidecarReducer(initialSidecarState, { type: 'status', status });
}

describe('sidecarReducer', () => {
  it('un estado viejo que llega tarde no pisa a uno más nuevo (seq, D7)', () => {
    // El evento «connected» (seq 2) llega antes que la respuesta de
    // `sidecar_status`, que leyó «starting» (seq 1) un instante antes.
    let s = sidecarReducer(initialSidecarState, { type: 'status', status: { ...connected, seq: 2 } });
    s = sidecarReducer(s, { type: 'status', status: { state: 'starting', seq: 1 } });
    expect(s.status.state).toBe('connected');
    expect(s.statusSeq).toBe(2);
    expect('seq' in s.status).toBe(false);
    // Uno más nuevo sí se aplica.
    s = sidecarReducer(s, {
      type: 'status',
      status: { state: 'disconnected', reason: 'x', exitCode: 1, seq: 3 },
    });
    expect(s.status.state).toBe('disconnected');
  });

  it('mide la latencia solo con el pong del ping pendiente', () => {
    let s = withStatus(connected);
    s = sidecarReducer(s, { type: 'ping_sent', id: 'p1', now: 100 });
    s = sidecarReducer(s, { type: 'frame', frame: { type: 'pong', id: 'otro', ts: 0 }, now: 105 });
    expect(s.latencyMs).toBeNull();
    s = sidecarReducer(s, { type: 'frame', frame: { type: 'pong', id: 'p1', ts: 0 }, now: 112.5 });
    expect(s.latencyMs).toBe(12.5);
    expect(s.pendingPing).toBeNull();
  });

  it('descarta el ping en vuelo al perder la conexión', () => {
    let s = sidecarReducer(withStatus(connected), { type: 'ping_sent', id: 'p1', now: 0 });
    s = sidecarReducer(s, {
      type: 'status',
      status: { state: 'disconnected', reason: 'x', exitCode: null },
    });
    expect(s.pendingPing).toBeNull();
  });

  it('acumula errores del sidecar sin duplicarlos y un fatal impide operar', () => {
    const err = {
      type: 'sidecar_error' as const,
      fatal: true,
      code: 'schema_incompatible' as const,
      message: 'schemaVersion 2',
    };
    let s = withStatus(connected);
    expect(isOperational(s)).toBe(true);
    s = sidecarReducer(s, { type: 'frame', frame: err, now: 0 });
    s = sidecarReducer(s, { type: 'frame', frame: err, now: 1 });
    expect(s.errors).toEqual([err]);
    expect(isOperational(s)).toBe(false);
  });
});

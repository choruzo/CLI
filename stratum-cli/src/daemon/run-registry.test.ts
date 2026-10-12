import { describe, it, expect } from 'vitest';
import type { ProtocolEvent, ProtocolRun, ProtocolSession } from '../protocol/index.js';
import { sampleRun, sampleSession, sampleSnapshot } from '../protocol/protocol.fixtures.js';
import { RunRegistry } from './run-registry.js';

const session = (id: string, over: Partial<ProtocolSession> = {}): ProtocolSession => ({
  ...sampleSession(),
  id,
  ...over,
});
const run = (id: string, sessionId: string, over: Partial<ProtocolRun> = {}): ProtocolRun => ({
  ...sampleRun(),
  id,
  sessionId,
  ...over,
});

let seq = 0;
function ev<T extends ProtocolEvent['type']>(
  type: T,
  sessionId: string,
  data: unknown,
): ProtocolEvent {
  return { type, sessionId, at: 1, seq: ++seq, data } as ProtocolEvent;
}

describe('RunRegistry', () => {
  it('es una proyección de los eventos: sesiones vivas, runs y su estado', () => {
    const registry = new RunRegistry();
    registry.apply(ev('session.opened', 'a', { session: session('a', { state: 'idle' }) }));
    registry.apply(ev('session.opened', 'b', { session: session('b', { state: 'idle' }) }));
    registry.apply(ev('run.started', 'a', { run: run('r1', 'a', { status: 'running' }) }));
    registry.apply(ev('session.updated', 'a', { session: session('a', { state: 'running' }) }));
    // Lo que no es de sesión o de run no cambia nada.
    registry.apply(ev('warning', 'a', { message: 'x' }));
    registry.apply({ type: 'message.delta', sessionId: 'a', at: 1, after: 1, data: { text: 'x' } });

    expect(registry.liveSessions).toBe(2);
    expect(registry.activeRuns).toBe(1);
    expect(registry.session('a')?.state).toBe('running');
    expect(registry.listRuns({ active: true }).map((r) => r.id)).toEqual(['r1']);

    registry.apply(ev('run.completed', 'a', { run: run('r1', 'a', { status: 'completed' }) }));
    expect(registry.activeRuns).toBe(0);
    expect(registry.run('r1')?.status).toBe('completed');
    expect(registry.listRuns({ sessionId: 'b' })).toEqual([]);
  });

  it('una sesión que se cierra deja de estar viva y su run en curso queda interrumpido', () => {
    const registry = new RunRegistry();
    registry.apply(ev('session.opened', 'a', { session: session('a') }));
    registry.apply(ev('run.started', 'a', { run: run('r1', 'a', { status: 'running' }) }));
    registry.apply(ev('session.closed', 'a', { reason: 'host-exit' }));
    expect(registry.liveSessions).toBe(0);
    expect(registry.session('a')).toBeUndefined();
    expect(registry.run('r1')?.status).toBe('interrupted');
    expect(registry.activeRuns).toBe(0);
  });

  it('se rehace desde los snapshots de las sesiones: no guarda nada que no salga de ellas', () => {
    const live = new RunRegistry();
    live.apply(ev('session.opened', 'a', { session: session('a', { state: 'idle' }) }));
    live.apply(ev('run.started', 'a', { run: run('r1', 'a', { status: 'running' }) }));
    live.apply(ev('session.updated', 'a', { session: session('a', { state: 'running', seq: 3 }) }));

    const rebuilt = new RunRegistry();
    rebuilt.replace(
      sampleSnapshot({
        session: session('a', { state: 'running', seq: 3 }),
        seq: 3,
        run: run('r1', 'a', { status: 'running' }),
      }),
    );
    expect(rebuilt.listSessions()).toEqual(live.listSessions());
    expect(rebuilt.listRuns()).toEqual(live.listRuns());
    expect(rebuilt.activeRuns).toBe(live.activeRuns);
  });

  it('el historial de runs está acotado y nunca olvida uno en curso', () => {
    const registry = new RunRegistry(5);
    registry.apply(ev('run.started', 'a', { run: run('vivo', 'a', { status: 'running' }) }));
    for (let i = 0; i < 20; i++) {
      registry.apply(ev('run.completed', 'a', { run: run(`r${i}`, 'a', { status: 'completed' }) }));
    }
    expect(registry.listRuns().length).toBeLessThanOrEqual(5);
    expect(registry.run('vivo')?.status).toBe('running');
    // Los más recientes primero, y `limit` se respeta.
    expect(registry.listRuns({ limit: 2 }).map((r) => r.id)).toEqual(['r19', 'r18']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  EMPTY_OVERVIEW,
  applyOverviewEvent,
  applySessionEvent,
  followSession,
  type ProtocolEvent,
  type ProtocolOverviewSnapshot,
} from './index.js';
import { classifyEvent, parseOverviewSnapshot, parseSessionSnapshot } from './schemas.js';
import { sampleApproval, sampleRun, sampleSession, sampleSnapshot } from './protocol.fixtures.js';

/**
 * M12 — la capa cliente compartida: seguir una sesión (Dot y Desktop) y la
 * foto de conjunto con estado operativo. Ninguna tiene reductor propio.
 */

const SID = 'ses_20261012_abc123';

const runUpdated = (seq: number, status: 'running' | 'paused'): unknown => ({
  type: 'run.updated',
  sessionId: SID,
  seq,
  at: 1_760_000_002_000 + seq,
  data: { run: sampleRun({ status }) },
});

describe('classifyEvent y las fotos: lo que no es del contrato no pasa', () => {
  it('una foto válida queda solo con los campos del contrato; una rota es null', () => {
    const raw = { ...sampleSnapshot(), env: { TOKEN: 'x' } };
    const parsed = parseSessionSnapshot(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('env');
    expect(parseSessionSnapshot({ seq: 3 })).toBeNull();
    expect(
      parseOverviewSnapshot({
        sessions: [sampleSession()],
        approvals: [],
        questions: [],
        plans: [],
      }),
    ).not.toBeNull();
    expect(parseOverviewSnapshot({ sessions: 'x' })).toBeNull();
  });

  it('un tipo de estado desconocido con seq cuenta; uno conocido que no valida, no', () => {
    expect(
      classifyEvent({ type: 'future.thing', sessionId: SID, seq: 4, at: 9, data: {} }),
    ).toEqual({
      kind: 'unknown-state',
      sessionId: SID,
      seq: 4,
      at: 9,
    });
    expect(classifyEvent({ type: 'future.delta', sessionId: SID, after: 4, data: {} })).toEqual({
      kind: 'skip',
    });
    expect(
      classifyEvent({ type: 'run.updated', sessionId: SID, seq: 4, at: 1, data: { run: {} } }),
    ).toEqual({ kind: 'invalid' });
    expect(classifyEvent(null)).toEqual({ kind: 'invalid' });
  });
});

describe('followSession: el reductor del contrato, y cuándo pedir foto', () => {
  it('el evento siguiente se aplica con applySessionEvent; la foto de entrada no se toca', () => {
    const before = sampleSnapshot();
    const parsed = classifyEvent(runUpdated(4, 'paused'));
    if (parsed.kind !== 'event') throw new Error('evento válido');
    const result = followSession(before, [parsed]);
    expect(result.snapshot).toEqual(applySessionEvent(before, parsed.event));
    expect(result.snapshot.run?.status).toBe('paused');
    expect(result.applied.map((e) => e.type)).toEqual(['run.updated']);
    expect(result.needsResync).toBe(false);
    expect(before.seq).toBe(3);
  });

  it('un hueco no se remienda: se aplica lo anterior y se pide foto', () => {
    const r = followSession(sampleSnapshot(), [
      classifyEvent(runUpdated(4, 'paused')),
      classifyEvent(runUpdated(6, 'running')),
    ]);
    expect(r.snapshot.seq).toBe(4);
    expect(r.needsResync).toBe(true);
  });

  it('lo repetido o de otra sesión se ignora; un desconocido avanza la secuencia', () => {
    const r = followSession(sampleSnapshot(), [
      classifyEvent(runUpdated(3, 'paused')),
      classifyEvent({ ...(runUpdated(4, 'paused') as object), sessionId: 'otra' }),
      classifyEvent({ type: 'future.thing', sessionId: SID, seq: 4, at: 7, data: {} }),
      classifyEvent(runUpdated(5, 'paused')),
    ]);
    expect(r.needsResync).toBe(false);
    expect(r.snapshot.seq).toBe(5);
    expect(r.snapshot.run?.status).toBe('paused');
  });

  it('un evento inválido pide foto', () => {
    expect(followSession(sampleSnapshot(), [{ kind: 'invalid' }]).needsResync).toBe(true);
  });
});

describe('applyOverviewEvent: estado operativo sin conversaciones', () => {
  const event = (type: string, data: unknown, sessionId = SID, seq = 4): ProtocolEvent => {
    const parsed = classifyEvent({ type, sessionId, seq, at: 1, data });
    if (parsed.kind !== 'event') throw new Error(`${type} no valida`);
    return parsed.event;
  };

  it('abre, actualiza y cierra sesiones; un evento más viejo no gana', () => {
    let o: ProtocolOverviewSnapshot = EMPTY_OVERVIEW;
    o = applyOverviewEvent(
      o,
      event('session.opened', { session: sampleSession({ seq: 1, state: 'idle' }) }),
    );
    o = applyOverviewEvent(
      o,
      event('session.updated', {
        session: sampleSession({ seq: 5, state: 'running', origin: 'desktop' }),
      }),
    );
    expect(o.sessions).toHaveLength(1);
    expect(o.sessions[0]).toMatchObject({ state: 'running', origin: 'desktop' });
    o = applyOverviewEvent(
      o,
      event('session.updated', { session: sampleSession({ seq: 4, state: 'idle' }) }),
    );
    expect(o.sessions[0]?.state).toBe('running');
    o = applyOverviewEvent(o, event('approval.requested', { approval: sampleApproval() }));
    expect(o.approvals).toHaveLength(1);
    o = applyOverviewEvent(o, event('session.closed', { reason: 'closed' }));
    expect(o).toEqual(EMPTY_OVERVIEW);
    expect(EMPTY_OVERVIEW.sessions).toEqual([]);
  });

  it('las solicitudes se resuelven por id y sesión; un run no cambia la vista', () => {
    let o: ProtocolOverviewSnapshot = { ...EMPTY_OVERVIEW, sessions: [sampleSession()] };
    o = applyOverviewEvent(o, event('approval.requested', { approval: sampleApproval() }));
    o = applyOverviewEvent(o, event('approval.requested', { approval: sampleApproval() }));
    expect(o.approvals).toHaveLength(1);
    const same = applyOverviewEvent(
      o,
      event('approval.resolved', { approvalId: 'call_2', status: 'approved' }, 'otra'),
    );
    expect(same.approvals).toHaveLength(1);
    o = applyOverviewEvent(
      o,
      event('approval.resolved', { approvalId: 'call_2', status: 'approved' }),
    );
    expect(o.approvals).toEqual([]);
    expect(applyOverviewEvent(o, event('run.updated', { run: sampleRun() }))).toBe(o);
  });
});

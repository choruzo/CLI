import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_LIMITS,
  applySessionEvent,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
} from './index.js';
import { sampleRun, sampleSession, sampleSnapshot, sampleToolCall } from './protocol.fixtures.js';

const ID = 'ses_20261012_abc123';

function idle(seq = 1): ProtocolSessionSnapshot {
  return sampleSnapshot({
    session: sampleSession({ seq, state: 'idle', currentRunId: null }),
    seq,
    run: null,
    partial: { text: '', reasoning: '' },
    toolCalls: [],
    approvals: [],
  });
}

const at = (seq: number): number => 1_760_000_010_000 + seq;

function reduce(start: ProtocolSessionSnapshot, events: ProtocolEvent[]): ProtocolSessionSnapshot {
  return events.reduce(applySessionEvent, start);
}

describe('applySessionEvent', () => {
  it('un run completo: de la foto y sus eventos sale la foto siguiente', () => {
    const run = sampleRun({ status: 'running' });
    const done = { ...run, status: 'completed' as const, stopReason: 'stop' as const };
    const end = reduce(idle(), [
      { type: 'run.started', sessionId: ID, at: at(2), seq: 2, data: { run } },
      {
        type: 'session.updated',
        sessionId: ID,
        at: at(3),
        seq: 3,
        data: { session: sampleSession({ seq: 3, state: 'running', updatedAt: at(3) }) },
      },
      { type: 'message.delta', sessionId: ID, at: at(3), after: 3, data: { text: 'Voy ' } },
      { type: 'message.delta', sessionId: ID, at: at(3), after: 3, data: { text: 'a ello' } },
      {
        type: 'tool.started',
        sessionId: ID,
        at: at(4),
        seq: 4,
        data: { call: sampleToolCall({ state: 'running' }) },
      },
      {
        type: 'tool.completed',
        sessionId: ID,
        at: at(5),
        seq: 5,
        data: { call: sampleToolCall({ output: 'x'.repeat(5_000) }) },
      },
      { type: 'message.delta', sessionId: ID, at: at(5), after: 5, data: { text: 'Hecho' } },
      { type: 'message.completed', sessionId: ID, at: at(6), seq: 6, data: { text: 'Hecho' } },
      { type: 'run.completed', sessionId: ID, at: at(7), seq: 7, data: { run: done } },
    ]);

    expect(end.seq).toBe(7);
    expect(end.session).toMatchObject({ seq: 7, updatedAt: at(7) });
    expect(end.run).toEqual(done);
    expect(end.partial).toEqual({ text: '', reasoning: '' });
    expect(end.toolCalls).toHaveLength(1);
    expect(end.toolCalls[0]).toMatchObject({ id: 'call_1', state: 'completed' });
    // Dentro de una foto los textos van recortados, como los da el anfitrión.
    expect(end.toolCalls[0]!.output).toHaveLength(SNAPSHOT_LIMITS.textChars);
  });

  it('el texto del bloque abierto se acumula y una tool lo cierra', () => {
    const delta = (after: number, text: string): ProtocolEvent => ({
      type: 'message.delta',
      sessionId: ID,
      at: at(after),
      after,
      data: { text },
    });
    let snapshot = reduce(idle(), [delta(1, 'uno '), delta(1, 'dos')]);
    expect(snapshot.partial.text).toBe('uno dos');
    // Un fragmento anterior a la foto, o de un subagente, no es del bloque abierto.
    snapshot = reduce(snapshot, [delta(0, 'tarde'), { ...delta(1, 'hijo'), subagentId: 'sub_1' }]);
    expect(snapshot.partial.text).toBe('uno dos');
    snapshot = applySessionEvent(snapshot, {
      type: 'tool.started',
      sessionId: ID,
      at: at(2),
      seq: 2,
      data: { call: sampleToolCall({ state: 'running' }) },
    });
    expect(snapshot.partial.text).toBe('');
  });

  it('no aplica lo que no sigue a la foto: repetidos, huecos y otras sesiones', () => {
    const start = idle(5);
    const warning = (seq: number, sessionId = ID): ProtocolEvent => ({
      type: 'warning',
      sessionId,
      at: at(seq),
      seq,
      data: { message: 'aviso' },
    });
    expect(applySessionEvent(start, warning(5))).toBe(start);
    expect(applySessionEvent(start, warning(7))).toBe(start);
    expect(applySessionEvent(start, warning(6, 'ses_otra'))).toBe(start);
    expect(applySessionEvent(start, warning(6)).seq).toBe(6);
    // Y la foto de entrada no se toca.
    expect(start.seq).toBe(5);
  });

  it('un id de tool ya cerrado que reaparece es otra llamada; las listas están acotadas', () => {
    let snapshot = idle(0);
    let seq = 0;
    const emit = (state: 'running' | 'completed', id: string): void => {
      seq++;
      snapshot = applySessionEvent(snapshot, {
        type: state === 'running' ? 'tool.started' : 'tool.completed',
        sessionId: ID,
        at: at(seq),
        seq,
        data: { call: sampleToolCall({ id, state }) },
      });
    };
    emit('running', 'c');
    emit('completed', 'c');
    emit('running', 'c');
    expect(snapshot.toolCalls.map((c) => c.state)).toEqual(['completed', 'running']);
    for (let i = 0; i < SNAPSHOT_LIMITS.toolCalls + 20; i++) emit('running', `n${i}`);
    expect(snapshot.toolCalls).toHaveLength(SNAPSHOT_LIMITS.toolCalls);
    expect(snapshot.toolCalls.at(-1)!.id).toBe(`n${SNAPSHOT_LIMITS.toolCalls + 19}`);
  });

  it('session.closed deja la sesión cerrada y sin run vigente', () => {
    const closed = applySessionEvent(sampleSnapshot(), {
      type: 'session.closed',
      sessionId: ID,
      at: at(4),
      seq: 4,
      data: { reason: 'closed' },
    });
    expect(closed.session).toMatchObject({ state: 'closed', currentRunId: null, seq: 4 });
  });
});

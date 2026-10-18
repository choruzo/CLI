import { describe, it, expect } from 'vitest';
import { sampleRun, sampleSession, sampleSnapshot } from '../protocol/protocol.fixtures.js';
import type { ProtocolSession } from '../protocol/index.js';
import {
  attachAction,
  formatChatMessage,
  formatEvent,
  formatHeader,
  formatPending,
  hostChange,
  truncatedNote,
} from './attach-view.js';
import { describeDetachRefusal, handedOffNotice } from './handoff-text.js';

const daemonIdle = (): ProtocolSession =>
  sampleSession({
    state: 'idle',
    currentRunId: null,
    host: { kind: 'daemon', client: 'daemon', connected: true },
  });
const peerIdle = (): ProtocolSession =>
  sampleSession({
    state: 'idle',
    currentRunId: null,
    host: { kind: 'peer', client: 'cli', connected: true },
  });

describe('attachAction — attach es un cliente', () => {
  it('parada y en el daemon: un turno nuevo; con un run: steering, también si es de una terminal', () => {
    expect(attachAction(daemonIdle(), '  hola  ')).toEqual({ kind: 'start', input: 'hola' });
    const running = { ...peerIdle(), state: 'running' as const, currentRunId: 'run_1' };
    expect(attachAction(running, 'mira esto')).toEqual({ kind: 'steer', text: 'mira esto' });
    expect(attachAction({ ...running, state: 'paused' }, 'x')).toEqual({
      kind: 'steer',
      text: 'x',
    });
  });

  it('una sesión de una terminal parada no admite turnos desde aquí: se explica, no se envía', () => {
    const action = attachAction(peerIdle(), 'hola');
    expect(action.kind).toBe('refuse');
    expect(action.kind === 'refuse' && action.message).toMatch(/\/detach/);
    expect(attachAction({ ...daemonIdle(), state: 'closed' }, 'hola').kind).toBe('refuse');
    expect(attachAction(null, 'hola').kind).toBe('refuse');
  });

  it('comandos', () => {
    for (const [line, kind] of [
      ['/quit', 'quit'],
      ['/exit', 'quit'],
      ['/help', 'help'],
      ['/pending', 'pending'],
      ['/cancel', 'cancel'],
      ['/pause', 'pause'],
      ['/resume', 'resume'],
      ['/detach', 'detach'],
      ['/nope', 'refuse'],
      ['   ', 'none'],
    ] as const) {
      expect(attachAction(daemonIdle(), line).kind, line).toBe(kind);
    }
  });
});

describe('pintar', () => {
  it('conversación, cabecera y pendientes', () => {
    expect(formatChatMessage({ kind: 'user', id: '1', runId: 'r', at: 0, text: 'hola' })).toBe(
      '› hola',
    );
    expect(
      formatChatMessage({
        kind: 'tool',
        id: '2',
        runId: 'r',
        at: 0,
        callId: 'c',
        name: 'exec',
        description: 'ls',
        state: 'error',
      }),
    ).toBe('  ⏺ exec · ls ✗');
    expect(
      formatChatMessage({
        kind: 'outcome',
        id: '3',
        runId: 'r',
        at: 0,
        status: 'cancelled',
        text: '',
      }),
    ).toBe('[run cancelled]');
    const header = formatHeader(sampleSnapshot({ session: peerIdle() }));
    expect(header).toContain('cli (terminal)');
    expect(formatPending({ approvals: [], questions: [], plans: [] })).toMatch(/Nothing/);
  });

  it('eventos: el texto del asistente no se pinta aquí, lo de un subagente tampoco', () => {
    const run = sampleRun({ status: 'paused' });
    const base = { sessionId: run.sessionId, at: 0, seq: 5 };
    expect(formatEvent({ ...base, type: 'run.updated', data: { run } })).toMatch(/paused/);
    expect(formatEvent({ ...base, type: 'message.completed', data: { text: 'x' } })).toBeNull();
    expect(
      formatEvent({ ...base, subagentId: 'sub_1', type: 'run.updated', data: { run } }),
    ).toBeNull();
    expect(formatEvent({ ...base, type: 'session.closed', data: { reason: 'closed' } })).toMatch(
      /closed/,
    );
  });

  it('cambio de anfitrión: de la terminal al daemon se dice; nada más cambia', () => {
    expect(hostChange(peerIdle(), daemonIdle())).toMatch(/stratumd/);
    expect(hostChange(daemonIdle(), daemonIdle())).toBeNull();
    expect(hostChange(null, daemonIdle())).toBeNull();
    const lost = {
      ...peerIdle(),
      host: { kind: 'peer' as const, client: 'cli' as const, connected: false },
    };
    expect(hostChange(peerIdle(), lost)).toMatch(/unreachable/);
  });
});

describe('textos del traspaso', () => {
  it('cada motivo del contrato tiene su explicación; lo desconocido no se inventa', () => {
    for (const reason of [
      'run-active',
      'handoff-in-progress',
      'jobs-running',
      'inbox-pending',
      'background-work',
      'unsupported-host',
      'startup',
      'cwd',
      'context',
      'changed',
      'host-unavailable',
    ]) {
      const text = describeDetachRefusal('BUSY', reason);
      expect(text, reason).not.toBe('busy');
      expect(text.length).toBeGreaterThan(10);
    }
    expect(describeDetachRefusal('NOT_FOUND')).toMatch(/no live session/);
    expect(describeDetachRefusal('SOMETHING_NEW', 'whatever')).toBe('something new');
    expect(handedOffNotice('sess_1')).toContain('stratum attach sess_1');
  });
});

describe('attach — conversación guardada (M11)', () => {
  it('/history pide lo anterior, con un tope', () => {
    expect(attachAction(null, '/history')).toEqual({ kind: 'history', count: 20 });
    expect(attachAction(null, '/history 5')).toEqual({ kind: 'history', count: 5 });
    expect(attachAction(null, '/history 0').kind).toBe('refuse');
    expect(attachAction(null, '/history mucho').kind).toBe('refuse');
  });

  it('una sesión del daemon dice cómo ver lo antiguo; una de terminal, que no se guarda', () => {
    const base = { host: { kind: 'daemon', client: 'daemon', connected: true } };
    expect(truncatedNote(base as never)).toContain('/history');
    expect(
      truncatedNote({ host: { kind: 'peer', client: 'cli', connected: true } } as never),
    ).toContain('not kept');
  });
});

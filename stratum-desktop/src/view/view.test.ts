import { describe, expect, it } from 'vitest';
import {
  sampleRun,
  sampleSession,
  sampleSnapshot,
  sampleToolCall,
} from '../../../stratum-cli/src/protocol/protocol.fixtures';
import type { ConnectionState } from '../ipc/native';
import type { ProtocolChatMessage } from '../protocol';
import { chatMessages, composerMode, draftComposer } from './chat';
import { describeSession, sessionItems } from './sessions';

const SID = 'ses_20261012_abc123';
const m = (seq: number, rest: Record<string, unknown>): ProtocolChatMessage =>
  ({ id: `m${seq}`, at: seq, runId: 'run_1', ...rest }) as ProtocolChatMessage;

const connected = (capabilities = ['observe', 'control']): ConnectionState => ({
  kind: 'connected',
  serverVersion: '0',
  serverPlatform: 'x',
  protocol: 1,
  capabilities,
  features: [],
});

describe('chatMessages: la conversación de la foto, agrupada por run', () => {
  it('turnos de usuario y de agente, tools con su salida del último run y lo que se está generando', () => {
    const snapshot = sampleSnapshot({
      messages: [
        m(1, { kind: 'user', text: 'busca', runId: 'run_0' }),
        m(2, { kind: 'assistant', text: 'Hecho.', runId: 'run_0' }),
        m(3, { kind: 'user', text: 'otra' }),
        m(4, { kind: 'tool', callId: 'call_1', name: 'exec', description: 'git status', state: 'completed' }),
      ],
      partial: { text: 'Voy a', reasoning: 'pienso' },
      toolCalls: [sampleToolCall()],
    });
    const out = chatMessages([], snapshot);
    expect(out.map((x) => `${x.role}:${x.turnId}`)).toEqual([
      'user:run_0',
      'agent:run_0',
      'user:run_1',
      'agent:run_1',
    ]);
    const live = out[3];
    if (live?.role !== 'agent') throw new Error('agente');
    expect(live.status).toBe('streaming');
    expect(live.toolCalls.call_1).toMatchObject({ state: 'completed', output: 'clean', input: 'git status' });
    expect(live.parts.map((p) => p.kind)).toEqual(['tool', 'reasoning', 'text']);
    const done = out[1];
    expect(done?.role === 'agent' && done.status).toBe('done');
  });

  it('lo anterior del historial va primero, sin repetir lo que ya trae la foto', () => {
    const snapshot = sampleSnapshot({
      messages: [m(5, { kind: 'user', text: 'b', runId: 'run_5' })],
      session: sampleSession({ currentRunId: null }),
      run: null,
    });
    const out = chatMessages([m(1, { kind: 'user', text: 'a', runId: 'run_a' }), m(5, { kind: 'user', text: 'b', runId: 'run_5' })], snapshot);
    expect(out.map((x) => x.role === 'user' && x.text)).toEqual(['a', 'b']);
  });

  it('un run que acabó mal lo dice; uno interrumpido por un reinicio del daemon, también', () => {
    const failed = sampleSnapshot({
      session: sampleSession({ currentRunId: null }),
      run: sampleRun({ status: 'interrupted' }),
      messages: [
        m(1, { kind: 'user', text: 'x' }),
        m(2, { kind: 'outcome', status: 'failed', text: 'sin modelo' }),
      ],
      partial: { text: '', reasoning: '' },
    });
    const turn = chatMessages([], failed)[1];
    expect(turn?.role === 'agent' && turn.status).toBe('interrupted');
    expect(turn?.role === 'agent' && turn.parts).toEqual([{ kind: 'notice', tone: 'error', text: 'sin modelo' }]);
  });
});

describe('composerMode: qué hace el campo, según el daemon y quien aloja la sesión', () => {
  const idleDaemon = sampleSnapshot({
    session: sampleSession({ currentRunId: null, state: 'idle', host: { kind: 'daemon', client: 'daemon', connected: true } }),
  });
  it('en reposo en el daemon se pregunta; con un run se redirige', () => {
    expect(composerMode(connected(), idleDaemon)).toEqual({ kind: 'ask' });
    expect(composerMode(connected(), sampleSnapshot())).toEqual({ kind: 'steer', paused: false });
  });

  it('observar no es conducir: sin la capacidad `control` no se escribe', () => {
    expect(composerMode(connected(['observe']), idleDaemon).kind).toBe('none');
    expect(draftComposer(connected(['observe'])).kind).toBe('none');
    expect(draftComposer({ kind: 'reconnecting', attempt: 1 }).kind).toBe('none');
  });

  it('una sesión de la terminal en reposo no se conduce desde aquí; cerrada, tampoco', () => {
    const peer = sampleSnapshot({ session: sampleSession({ currentRunId: null, state: 'idle' }) });
    expect(composerMode(connected(), peer)).toMatchObject({ kind: 'none', reason: expect.stringContaining('/detach') });
    const closed = sampleSnapshot({ session: sampleSession({ state: 'closed', currentRunId: null }) });
    expect(composerMode(connected(), closed).kind).toBe('none');
  });
});

describe('sessionItems: la lista, del estado operativo', () => {
  it('ordenada por actividad, sin cerradas, con lo que espera a una persona y su procedencia', () => {
    const items = sessionItems({
      sessions: [
        sampleSession({ id: 'a', updatedAt: 1, origin: 'cli', agent: 'general' }),
        sampleSession({ id: 'b', updatedAt: 3, origin: 'desktop', agent: 'assistant', host: { kind: 'daemon', client: 'daemon', connected: true } }),
        sampleSession({ id: 'c', updatedAt: 2, state: 'closed' }),
      ],
      approvals: [{ ...sampleSnapshot().approvals[0]!, sessionId: 'a' }],
      questions: [],
      plans: [],
    });
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(items[1]).toMatchObject({ waiting: 1, origin: 'cli', peer: true });
    expect(describeSession(items[1]!)).toBe('código · desde terminal · en su terminal');
    expect(describeSession(items[0]!)).toBe('');
    expect(SID).toBeTruthy();
  });
});

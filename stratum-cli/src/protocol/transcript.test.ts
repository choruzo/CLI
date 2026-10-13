import { describe, it, expect } from 'vitest';
import {
  EMPTY_TRANSCRIPT,
  TRANSCRIPT_LIMITS,
  applySessionEvent,
  clipText,
  applyTranscriptEvent,
  type ProtocolStateEvent,
  type ProtocolTranscript,
} from './index.js';
import { sessionSnapshotSchema } from './schemas.js';
import { sampleRun, sampleSession, sampleSnapshot, sampleToolCall } from './protocol.fixtures.js';

const ID = 'ses_20261012_abc123';
const at = (seq: number): number => 1_760_000_010_000 + seq;

type Data<T extends ProtocolStateEvent['type']> = Extract<ProtocolStateEvent, { type: T }>['data'];

function ev<T extends ProtocolStateEvent['type']>(
  seq: number,
  type: T,
  data: Data<T>,
  extra: { runId?: string; subagentId?: string } = { runId: 'run_1' },
): ProtocolStateEvent {
  return { type, sessionId: ID, at: at(seq), seq, ...extra, data } as ProtocolStateEvent;
}

function reduce(events: ProtocolStateEvent[], from = EMPTY_TRANSCRIPT): ProtocolTranscript {
  return events.reduce(applyTranscriptEvent, from);
}

describe('applyTranscriptEvent', () => {
  it('un turno con tools: usuario, asistente y cada llamada, en orden', () => {
    const run = sampleRun({ input: 'crea hello.txt' });
    const t = reduce([
      ev(2, 'run.started', { run }),
      ev(3, 'message.completed', { text: 'Voy a crearlo.' }),
      ev(4, 'tool.started', { call: sampleToolCall({ state: 'running', description: 'write' }) }),
      ev(5, 'tool.completed', { call: sampleToolCall({ state: 'completed', output: 'secreto' }) }),
      ev(6, 'message.completed', { text: 'Hecho.' }),
      ev(7, 'run.completed', { run: { ...run, status: 'completed' } }),
    ]);
    expect(t.messagesTruncated).toBe(false);
    expect(t.messages).toEqual([
      { kind: 'user', id: 'm2', runId: 'run_1', at: at(2), text: 'crea hello.txt' },
      { kind: 'assistant', id: 'm3', runId: 'run_1', at: at(3), text: 'Voy a crearlo.' },
      {
        kind: 'tool',
        id: 'm4',
        runId: 'run_1',
        at: at(4),
        callId: 'call_1',
        name: 'exec',
        description: 'write',
        target: 'local',
        state: 'completed',
      },
      { kind: 'assistant', id: 'm6', runId: 'run_1', at: at(6), text: 'Hecho.' },
    ]);
    // Ni la salida de la tool ni sus argumentos viajan en la conversación.
    expect(JSON.stringify(t)).not.toContain('secreto');
  });

  it('un evento que no es de la conversación devuelve el mismo objeto', () => {
    const t = reduce([ev(2, 'run.started', { run: sampleRun() })]);
    expect(applyTranscriptEvent(t, ev(3, 'warning', { message: 'x' }))).toBe(t);
    expect(applyTranscriptEvent(t, ev(3, 'run.updated', { run: sampleRun() }))).toBe(t);
    expect(applyTranscriptEvent(t, ev(3, 'message.completed', { text: '' }))).toBe(t);
  });

  it('lo de un subagente no entra', () => {
    const sub = { runId: 'run_1', subagentId: 'sub_1' };
    const t = reduce([
      ev(2, 'message.completed', { text: 'soy el hijo' }, sub),
      ev(3, 'tool.started', { call: sampleToolCall({ state: 'running' }) }, sub),
      ev(4, 'tool.started', { call: sampleToolCall({ state: 'running', subagentId: 'sub_1' }) }),
    ]);
    expect(t).toBe(EMPTY_TRANSCRIPT);
  });

  it('un id de tool que vuelve tras cerrarse es otra llamada', () => {
    const t = reduce([
      ev(2, 'tool.started', { call: sampleToolCall({ state: 'running' }) }),
      ev(3, 'tool.failed', { call: sampleToolCall({ state: 'error' }), recoverable: true }),
      ev(4, 'tool.started', { call: sampleToolCall({ state: 'running' }) }),
    ]);
    expect(t.messages.map((m) => (m.kind === 'tool' ? [m.id, m.state] : null))).toEqual([
      ['m2', 'error'],
      ['m4', 'running'],
    ]);
  });

  it('un id de tool que se repite en otro run no se funde con una llamada que quedó abierta', () => {
    const open = sampleToolCall({ state: 'running', description: 'ls r1' });
    const next = sampleToolCall({ runId: 'run_2', state: 'running', description: 'ls r2' });
    const t = reduce([
      ev(2, 'tool.started', { call: open }),
      ev(3, 'run.failed', { run: sampleRun({ status: 'failed' }) }),
      ev(4, 'tool.started', { call: next }, { runId: 'run_2' }),
      ev(5, 'tool.completed', { call: { ...next, state: 'completed' } }, { runId: 'run_2' }),
    ]);
    expect(
      t.messages.flatMap((m) => (m.kind === 'tool' ? [[m.runId, m.state, m.description]] : [])),
    ).toEqual([
      ['run_1', 'running', 'ls r1'],
      ['run_2', 'completed', 'ls r2'],
    ]);
  });

  it('recortar no parte un emoji: el texto sigue bien formado', () => {
    const max = TRANSCRIPT_LIMITS.textChars;
    // El emoji (dos unidades) cae justo donde se corta.
    const text = `${'a'.repeat(max - 2)}😀${'b'.repeat(50)}`;
    const t = reduce([ev(2, 'message.completed', { text })]);
    const shown = t.messages[0]!.kind === 'assistant' ? t.messages[0]!.text : '';
    expect(shown.length).toBeLessThanOrEqual(max);
    expect(shown.endsWith('…')).toBe(true);
    // Ni un surrogate suelto: lo que un parser JSON estricto rechazaría.
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(shown),
    ).toBe(false);
    expect(clipText('ab😀cd', 4)).toBe('ab…');
    expect(clipText('ab😀cd', 5)).toBe('ab😀…');
    expect(clipText('corto', 10)).toBe('corto');
  });

  it('un turno fallido o cancelado deja constancia, sin inventar un mensaje del asistente', () => {
    const failed = sampleRun({ status: 'failed', error: 'provider down' });
    const cancelled = sampleRun({ id: 'run_2', status: 'cancelled' });
    const t = reduce([
      ev(2, 'run.failed', { run: failed }),
      ev(3, 'run.cancelled', { run: cancelled }, { runId: 'run_2' }),
    ]);
    expect(t.messages).toEqual([
      {
        kind: 'outcome',
        id: 'm2',
        runId: 'run_1',
        at: at(2),
        status: 'failed',
        text: 'provider down',
      },
      { kind: 'outcome', id: 'm3', runId: 'run_2', at: at(3), status: 'cancelled', text: '' },
    ]);
  });

  it('un texto largo se recorta y lo dice; una entrada recortada por el anfitrión, también', () => {
    const t = reduce([
      ev(2, 'run.started', { run: sampleRun({ input: 'principio…', inputTruncated: true }) }),
      ev(3, 'message.completed', { text: 'x'.repeat(TRANSCRIPT_LIMITS.textChars + 50) }),
      ev(4, 'message.completed', { text: 'corto' }),
    ]);
    const [user, long, short] = t.messages;
    expect(user).toMatchObject({ kind: 'user', truncated: true });
    expect(long).toMatchObject({ kind: 'assistant', truncated: true });
    expect(long!.kind === 'assistant' && long.text.length).toBe(TRANSCRIPT_LIMITS.textChars);
    expect(short).not.toHaveProperty('truncated');
  });

  it('está acotada en número y en tamaño, y dice cuándo ha descartado', () => {
    let t = EMPTY_TRANSCRIPT;
    for (let seq = 1; seq <= TRANSCRIPT_LIMITS.messages + 25; seq++) {
      t = applyTranscriptEvent(t, ev(seq, 'message.completed', { text: `m${seq}` }));
    }
    expect(t.messages).toHaveLength(TRANSCRIPT_LIMITS.messages);
    expect(t.messagesTruncated).toBe(true);
    expect(t.messages[0]!.id).toBe('m26');

    let big = EMPTY_TRANSCRIPT;
    const chunk = 'y'.repeat(TRANSCRIPT_LIMITS.textChars);
    for (let seq = 1; seq <= 40; seq++) {
      big = applyTranscriptEvent(big, ev(seq, 'message.completed', { text: chunk }));
    }
    const total = big.messages.reduce((n, m) => n + (m.kind === 'tool' ? 0 : m.text.length), 0);
    expect(total).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.totalChars);
    expect(big.messagesTruncated).toBe(true);
    expect(big.messages.at(-1)!.id).toBe('m40');
  });

  it('una foto con la conversación al límite cabe en un mensaje del protocolo', () => {
    let t = EMPTY_TRANSCRIPT;
    // Peor caso razonable: texto que se escapa en JSON.
    const chunk = '"\\\n'.repeat(TRANSCRIPT_LIMITS.textChars / 3);
    for (let seq = 1; seq <= 60; seq++) {
      t = applyTranscriptEvent(t, ev(seq, 'message.completed', { text: chunk }));
    }
    const snapshot = sampleSnapshot({ ...t });
    expect(sessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(512 * 1024);
  });
});

describe('applySessionEvent — la conversación', () => {
  it('sale de los mismos eventos y sobrevive al cambio de run', () => {
    const start = sampleSnapshot({
      session: sampleSession({ seq: 1, state: 'idle', currentRunId: null }),
      seq: 1,
      run: null,
      partial: { text: '', reasoning: '' },
      toolCalls: [],
      approvals: [],
    });
    const first = sampleRun({ input: 'hola' });
    const second = sampleRun({ id: 'run_2', input: '¿y ahora?' });
    const events: ProtocolStateEvent[] = [
      ev(2, 'run.started', { run: first }),
      ev(3, 'tool.started', { call: sampleToolCall({ state: 'running' }) }),
      ev(4, 'tool.completed', { call: sampleToolCall() }),
      ev(5, 'message.completed', { text: 'uno' }),
      ev(6, 'run.completed', { run: { ...first, status: 'completed' } }),
      ev(7, 'run.started', { run: second }, { runId: 'run_2' }),
      ev(8, 'message.completed', { text: 'dos' }, { runId: 'run_2' }),
    ];
    const end = events.reduce(applySessionEvent, start);
    // Las tools del run son del run; la conversación es de la sesión.
    expect(end.toolCalls).toEqual([]);
    expect(end.messages.map((m) => m.kind)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(end.messages).toEqual(reduce(events).messages);
    // Los fragmentos no son conversación: solo `partial`.
    const typing = applySessionEvent(end, {
      type: 'message.delta',
      sessionId: ID,
      at: at(9),
      after: 8,
      data: { text: 'escribiendo' },
    });
    expect(typing.messages).toBe(end.messages);
    expect(typing.partial.text).toBe('escribiendo');
  });
});

import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import type { ProtocolApproval, ProtocolQuestionRequest } from '../protocol/index.js';
import type { OutgoingMessage } from '../channels/telegram/outbox.js';
import { BUTTON } from '../channels/telegram/render.js';
import type { PendingChange, Resolution } from './approval-center.js';
import { ChannelApprovals, TELEGRAM_LINK } from './channel-approvals.js';

const approval = (over: Partial<ProtocolApproval> = {}): ProtocolApproval => ({
  id: 'ap1',
  kind: 'tool',
  sessionId: 's1',
  runId: 'r1',
  tool: 'exec',
  description: 'rm -rf build',
  target: 'local',
  forced: false,
  resolvable: 'anywhere',
  requestedAt: 1,
  expiresAt: null,
  status: 'pending',
  ...over,
});

function setup(resolve: (r: Resolution) => Promise<void> = async () => undefined) {
  let listener: ((c: PendingChange) => void) | null = null;
  const resolutions: Resolution[] = [];
  const sent: { chatId: number; message: OutgoingMessage; messageId: number }[] = [];
  const edits: { chatId: number; messageId: number; text: string }[] = [];
  const answers: (string | undefined)[] = [];
  let nextId = 100;
  let token = 0;
  const cards = new ChannelApprovals({
    approvals: {
      subscribe: (l) => {
        listener = l;
        return () => (listener = null);
      },
      resolve: async (link, r) => {
        expect(link).toBe(TELEGRAM_LINK);
        resolutions.push(r);
        await resolve(r);
      },
    },
    target: () => ({
      sendMessage: (chatId, message) => {
        const messageId = nextId++;
        sent.push({ chatId, message, messageId });
        message.onSent?.(messageId);
      },
      edit: (chatId, messageId, text) => edits.push({ chatId, messageId, text }),
      answerCallback: (_id, text) => answers.push(text),
    }),
    chats: () => [42],
    redact: (text) => text.replaceAll('sk-secreto1', '[redacted]'),
    sessionLabel: () => ({ title: 'Ordenar', agent: 'companion', origin: 'dot', cwd: '/home/a' }),
    makeToken: () => `t${++token}`,
  });
  cards.start();
  const emit = (c: PendingChange): void => listener!(c);
  const press = (data: string) => cards.onCallback({ id: 'cb', from: {} as never, data });
  return { cards, emit, press, sent, edits, answers, resolutions };
}

describe('ChannelApprovals (M18)', () => {
  it('una aprobación normal: tarjeta con la sesión y dos botones, sin ids en claro', () => {
    const { emit, sent } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval({ description: 'usa sk-secreto1' }) });
    expect(sent).toHaveLength(1);
    const { text, keyboard } = sent[0]!.message;
    expect(text).toContain('Session: Ordenar (companion, from dot)');
    expect(text).toContain('exec on local');
    expect(text).toContain('[redacted]');
    expect(keyboard).toEqual([
      [
        { text: BUTTON.approve, callbackData: 'b:t2' },
        { text: BUTTON.deny, callbackData: 'b:t1' },
      ],
    ]);
    expect(JSON.stringify(keyboard)).not.toContain('ap1');
  });

  it('lo forzado, sin botón de aprobar y diciendo por qué', () => {
    const { emit, sent } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval({ forced: true }) });
    expect(sent[0]!.message.keyboard).toEqual([[{ text: BUTTON.deny, callbackData: 'b:t1' }]]);
    expect(sent[0]!.message.text).toContain('Approve it in Dot');
  });

  it('pulsar resuelve por el centro; al cerrarse la tarjeta se edita y el botón ya no vale', async () => {
    const { emit, press, edits, answers, resolutions } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval() });
    await press('b:t2');
    expect(resolutions).toEqual([
      { kind: 'approval', id: 'ap1', sessionId: 's1', decision: 'approve' },
    ]);
    expect(answers).toEqual(['Approved.']);
    emit({
      type: 'closed',
      id: 'ap1',
      sessionId: 's1',
      resolution: 'approved',
      by: { kind: 'channel', channel: 'telegram', at: 1 },
    });
    expect(edits[0]).toMatchObject({ chatId: 42, messageId: 100 });
    expect(edits[0]!.text).toContain('— Approved from Telegram.');
    await press('b:t1');
    expect(resolutions).toHaveLength(1);
    expect(answers.at(-1)).toContain('no longer valid');
  });

  it('resuelta en Dot o caducada: se dice en la tarjeta', () => {
    const { emit, edits } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval() });
    emit({
      type: 'closed',
      id: 'ap1',
      sessionId: 's1',
      resolution: 'denied',
      by: { kind: 'remote', client: 'dot', at: 1 },
    });
    expect(edits[0]!.text).toContain('— Denied in Dot.');
    emit({ type: 'added', kind: 'approval', dto: approval({ id: 'ap2' }) });
    emit({ type: 'closed', id: 'ap2', sessionId: 's1', resolution: 'expired' });
    expect(edits[1]!.text).toContain('Expired');
  });

  it('el centro lo rechaza: se contesta al botón y no se edita nada', async () => {
    const { emit, press, edits, answers } = setup(async () => {
      throw new ProtocolError('INVALID_PARAMS', 'no');
    });
    emit({ type: 'added', kind: 'approval', dto: approval() });
    await press('b:t2');
    expect(answers).toEqual(['This one has to be resolved in Dot.']);
    expect(edits).toEqual([]);
  });

  it('una pregunta con opciones: un botón por opción, que contesta con su optionId', async () => {
    const { emit, press, sent, resolutions } = setup();
    const request: ProtocolQuestionRequest = {
      id: 'q1',
      sessionId: 's1',
      runId: 'r1',
      questions: [
        {
          question: '¿Qué carpeta?',
          options: [
            { id: 'o1', label: 'Fotos' },
            { id: 'o2', label: 'Docs' },
          ],
        },
      ],
      requestedAt: 1,
      expiresAt: null,
    };
    emit({ type: 'added', kind: 'question', dto: request });
    expect(sent[0]!.message.keyboard).toEqual([
      [{ text: 'Fotos', callbackData: 'b:t1' }],
      [{ text: 'Docs', callbackData: 'b:t2' }],
    ]);
    await press('b:t2');
    expect(resolutions[0]).toEqual({
      kind: 'question',
      id: 'q1',
      sessionId: 's1',
      answers: [{ question: '¿Qué carpeta?', answer: '', optionId: 'o2' }],
    });
  });

  it('texto libre y planes: aviso sin botones', () => {
    const { emit, sent } = setup();
    emit({
      type: 'added',
      kind: 'question',
      dto: {
        id: 'q1',
        sessionId: 's1',
        runId: 'r1',
        questions: [{ question: '¿Nombre?' }],
        requestedAt: 1,
        expiresAt: null,
      },
    });
    emit({
      type: 'added',
      kind: 'plan',
      dto: {
        id: 'p1',
        sessionId: 's1',
        runId: 'r1',
        plan: { steps: [] } as never,
        requestedAt: 1,
        expiresAt: null,
      },
    });
    expect(sent.map((s) => s.message.keyboard)).toEqual([undefined, undefined]);
    expect(sent[0]!.message.text).toContain('Answer it in Dot');
    expect(sent[1]!.message.text).toContain('Review it in Dot');
  });

  it('tras un reset (reload) los botones anteriores no resuelven nada', async () => {
    const { cards, emit, press, resolutions } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval() });
    cards.reset();
    await press('b:t2');
    expect(resolutions).toEqual([]);
  });
});

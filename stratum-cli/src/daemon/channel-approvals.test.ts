import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import type { ProtocolApproval, ProtocolQuestionRequest } from '../protocol/index.js';
import type { OutgoingMessage } from '../channels/telegram/outbox.js';
import { BUTTON, QUESTION_TEXT } from '../channels/telegram/render.js';
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
      [{ text: BUTTON.skip, callbackData: 'b:t3' }],
    ]);
    expect(sent[0]!.message.text).toContain('Choose an option.');
    await press('b:t2');
    expect(resolutions[0]).toEqual({
      kind: 'question',
      id: 'q1',
      sessionId: 's1',
      answers: [{ question: '¿Qué carpeta?', answer: '', optionId: 'o2' }],
    });
    expect(sent.at(-1)!.message.text).toBe(QUESTION_TEXT.sent);
  });

  const batch = (id = 'q1'): ProtocolQuestionRequest => ({
    id,
    sessionId: 's1',
    runId: 'r1',
    questions: [
      { question: '¿Nombre?' },
      {
        question: '¿Formato?',
        options: [
          { id: 'o1', label: 'PDF' },
          { id: 'o2', label: 'PNG' },
        ],
      },
      { question: '¿Color?', options: [{ id: 'c1', label: 'Rojo' }], allowCustom: true },
    ],
    requestedAt: 1,
    expiresAt: null,
  });

  it('varias preguntas (6C): de una en una; el texto del chat las contesta y no llega al asistente', async () => {
    const { cards, emit, press, sent, answers, resolutions } = setup();
    emit({ type: 'added', kind: 'question', dto: batch() });
    expect(sent[0]!.message.text).toContain('3 questions, one at a time.');
    expect(sent[0]!.message.text).toContain('Question 1 of 3: ¿Nombre?');
    expect(sent[0]!.message.text).toContain('Reply in this chat');
    expect(sent[0]!.message.keyboard).toEqual([[{ text: BUTTON.skip, callbackData: 'b:t1' }]]);
    // Otro chat no tiene nada abierto: su texto es para el asistente.
    expect(await cards.takeText(7, 'hola')).toBe(false);

    expect(await cards.takeText(42, '  Ana  ')).toBe(true);
    expect(sent[1]!.message.text).toContain('Question 2 of 3: ¿Formato?');
    // Solo opciones: escribir no vale, se dice y se queda aquí.
    expect(await cards.takeText(42, 'JPG')).toBe(true);
    expect(sent[2]!.message.text).toBe(QUESTION_TEXT.chooseOption);
    await press('b:t3'); // PNG
    expect(sent[3]!.message.text).toContain('Question 3 of 3: ¿Color?');
    // Un botón de una pregunta ya contestada no hace nada.
    await press('b:t2');
    expect(answers.at(-1)).toBe('Already answered.');
    expect(resolutions).toEqual([]);
    expect(sent[3]!.message.text).toContain('or reply in this chat');
    expect(await cards.takeText(42, 'Verde')).toBe(true);
    expect(resolutions).toEqual([
      {
        kind: 'question',
        id: 'q1',
        sessionId: 's1',
        answers: [
          { question: '¿Nombre?', answer: 'Ana' },
          { question: '¿Formato?', answer: '', optionId: 'o2' },
          { question: '¿Color?', answer: 'Verde' },
        ],
      },
    ]);
    expect(sent.at(-1)!.message.text).toBe(QUESTION_TEXT.sent);
    // Ya resuelta: lo siguiente vuelve a ser para el asistente.
    expect(await cards.takeText(42, 'gracias')).toBe(false);
  });

  it('Skip questions omite la tanda entera; al cerrarse, cada mensaje pierde sus botones', async () => {
    const { cards, emit, press, edits, answers, resolutions } = setup();
    emit({ type: 'added', kind: 'question', dto: batch() });
    await cards.takeText(42, 'Ana');
    await press('b:t1');
    expect(resolutions).toEqual([{ kind: 'question', id: 'q1', sessionId: 's1', answers: null }]);
    expect(answers).toEqual([QUESTION_TEXT.skipped]);
    emit({
      type: 'closed',
      id: 'q1',
      sessionId: 's1',
      resolution: 'resolved',
      by: { kind: 'channel', channel: 'telegram', at: 1 },
    });
    expect(edits.map((e) => e.messageId)).toEqual([100, 101]);
    expect(edits[1]!.text).toContain('— Answered from Telegram.');
    expect(await cards.takeText(42, 'Verde')).toBe(false);
  });

  it('con dos tandas abiertas, el texto contesta a la más antigua y luego se recuerda la otra', async () => {
    const { cards, emit, sent, resolutions } = setup();
    const one = (id: string, question: string): ProtocolQuestionRequest => ({
      id,
      sessionId: 's1',
      runId: 'r1',
      questions: [{ question }],
      requestedAt: 1,
      expiresAt: null,
    });
    emit({ type: 'added', kind: 'question', dto: one('q1', '¿Primera?') });
    emit({ type: 'added', kind: 'question', dto: one('q2', '¿Segunda?') });
    await cards.takeText(42, 'uno');
    expect(resolutions[0]).toMatchObject({ id: 'q1', answers: [{ answer: 'uno' }] });
    expect(sent.at(-1)!.message.text).toContain('¿Segunda?');
    await cards.takeText(42, 'dos');
    expect(resolutions[1]).toMatchObject({ id: 'q2', answers: [{ answer: 'dos' }] });
  });

  it('contestada en Dot antes de terminar: se dice y no se resuelve dos veces', async () => {
    const { cards, emit, sent, resolutions } = setup(async () => {
      throw new ProtocolError('ALREADY_RESOLVED', 'ya');
    });
    emit({
      type: 'added',
      kind: 'question',
      dto: { ...batch(), questions: [{ question: '¿Nombre?' }] },
    });
    await cards.takeText(42, 'Ana');
    expect(resolutions).toHaveLength(1);
    expect(sent.at(-1)!.message.text).toBe(QUESTION_TEXT.already);
  });

  it('un plan (6C): pasos, Aprobar plan y Rechazar, sin editar', async () => {
    const { emit, press, sent, edits, answers, resolutions } = setup();
    emit({
      type: 'added',
      kind: 'plan',
      dto: {
        id: 'p1',
        sessionId: 's1',
        runId: 'r1',
        plan: {
          summary: 'Ordenar fotos',
          steps: [
            { id: 'a', title: 'Listar', status: 'pending' },
            { id: 'b', title: 'Mover', status: 'pending' },
          ],
        },
        requestedAt: 1,
        expiresAt: null,
      },
    });
    const { text, keyboard } = sent[0]!.message;
    expect(text).toContain('Ordenar fotos\n1. Listar\n2. Mover');
    expect(text).toContain('does not approve its actions');
    expect(keyboard).toEqual([
      [
        { text: BUTTON.approvePlan, callbackData: 'b:t1' },
        { text: BUTTON.rejectPlan, callbackData: 'b:t2' },
      ],
    ]);
    await press('b:t1');
    expect(resolutions).toEqual([{ kind: 'plan', id: 'p1', sessionId: 's1', decision: 'approve' }]);
    expect(answers).toEqual(['Plan approved.']);
    emit({
      type: 'closed',
      id: 'p1',
      sessionId: 's1',
      resolution: 'resolved',
      by: { kind: 'remote', client: 'dot', at: 1 },
    });
    expect(edits[0]!.text).toContain('— Decided in Dot.');
  });

  it('tras un reset (reload) los botones anteriores no resuelven nada', async () => {
    const { cards, emit, press, resolutions } = setup();
    emit({ type: 'added', kind: 'approval', dto: approval() });
    cards.reset();
    await press('b:t2');
    expect(resolutions).toEqual([]);
  });
});

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationHost } from './conversation-host.js';
import { ConversationSession } from './conversation.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { ConversationOutboundFrame } from './protocol.js';

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-host-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config = buildAssistantConfig(
  StratumConfigSchema.parse({
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: 32768,
        },
      },
    },
    memory: { globalFile: join(root, 'none', 'STRATUM.md'), autoExtract: false },
  }),
  join(root, 'data'),
);

let seq = 0;
function cid(): string {
  seq++;
  return `6f1c1c0e-3d2a-4b8e-9c1d-${seq.toString(16).padStart(12, '0')}`;
}

/** Provider que registra las requests. */
class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push({ ...req, messages: [...req.messages] });
    return super.complete(req);
  }
}

/** Provider que emite un trozo y se queda esperando hasta que abortan la request. */
class HangingProvider implements IProvider {
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    yield {
      choices: [{ delta: { content: 'Empiezo…' }, finish_reason: null, index: 0 }],
    } as OpenAIStreamChunk;
    await new Promise<void>((resolve) => {
      if (req.signal?.aborted) return resolve();
      req.signal?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 10_000).unref();
    });
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function setup(provider: IProvider, storeDir = join(root, `s${++seq}`)) {
  const frames: ConversationOutboundFrame[] = [];
  const store = new DesktopSessionStore(storeDir);
  const host = new ConversationHost({
    config,
    store,
    makeRouter: () => {
      const router = new ProviderRouter(config);
      vi.spyOn(router, 'getActive').mockReturnValue(provider);
      return router;
    },
  });
  host.attach(1, (f) => frames.push(f));
  const waitFor = async (pred: () => boolean, ms = 3_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(`timeout: ${JSON.stringify(frames.map((f) => f.type))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const ended = (turnId: string) =>
    waitFor(() => frames.some((f) => f.type === 'turn_ended' && f.turnId === turnId));
  return { frames, store, host, waitFor, ended, storeDir };
}

describe('ConversationHost (D1)', () => {
  it('conversación completa: stream de eventos, turn_ended y sesión guardada', async () => {
    const { frames, host, ended, store } = setup(
      new MockProvider([makeTextRound('¡Hola! ¿En qué te ayudo?')]),
    );
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await ended('t1');

    expect(frames[0]).toMatchObject({
      type: 'conversation_opened',
      conversationId: id,
      resumed: false,
      messageCount: 0,
      transcript: [],
      activeTurnId: null,
    });
    const events = frames.flatMap((f) => (f.type === 'agent_event' ? [f.event] : []));
    expect(events.map((e) => e.type)).toContain('text_delta');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(frames.find((f) => f.type === 'turn_ended')).toEqual({
      type: 'turn_ended',
      conversationId: id,
      turnId: 't1',
      stopReason: 'stop',
    });
    expect(
      frames.every((f) =>
        f.type === 'conversation_updated'
          ? f.summary.conversationId === id
          : 'conversationId' in f && f.conversationId === id,
      ),
    ).toBe(true);

    const saved = store.load(id);
    expect(saved?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('una pregunta del agente se responde desde el cliente y el turno continúa', async () => {
    const { frames, host, ended, waitFor } = setup(
      new MockProvider([
        makeToolCallRound('q1', 'question', {
          questions: [{ question: '¿Formato?', options: ['Tabla', 'Lista'] }],
        }),
        makeTextRound('Hecho en tabla.'),
      ]),
    );
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'compara' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'questions_request'));
    const req = frames.find((f) => f.type === 'questions_request');
    if (req?.type !== 'questions_request') throw new Error('sin questions_request');
    const option = req.questions[0].options?.find((o) => o.label === 'Tabla');
    host.handle(
      {
        type: 'answer_questions',
        conversationId: id,
        requestId: req.requestId,
        answers: [{ question: '¿Formato?', answer: 'Tabla', optionId: option?.id }],
      },
      1,
    );
    await ended('t1');

    const events = frames.flatMap((f) => (f.type === 'agent_event' ? [f.event] : []));
    const answered = events.find((e) => e.type === 'questions_answered');
    expect(answered).toMatchObject({ answers: [{ answer: 'Tabla', optionId: option?.id }] });
    expect(events.some((e) => e.type === 'text_delta' && e.delta.includes('tabla'))).toBe(true);
  });

  it('cancel aborta la generación en curso y resuelve el turno', async () => {
    const { frames, host, ended, waitFor } = setup(new HangingProvider());
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'escribe mucho' }, 1);
    await waitFor(() =>
      frames.some((f) => f.type === 'agent_event' && f.event.type === 'text_delta'),
    );
    // Un cancel de otro turno no toca el turno en curso.
    host.handle({ type: 'cancel', conversationId: id, turnId: 'otro' }, 1);
    host.handle({ type: 'cancel', conversationId: id, turnId: 't1' }, 1);
    await ended('t1');
    expect(frames.find((f) => f.type === 'turn_ended')).toMatchObject({ stopReason: 'cancelled' });
  });

  it('un chat durante un turno se rechaza como busy', async () => {
    const { frames, host, waitFor } = setup(new HangingProvider());
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'uno' }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't2', text: 'dos' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'chat_rejected'));
    expect(frames.find((f) => f.type === 'chat_rejected')).toMatchObject({
      turnId: 't2',
      reason: 'busy',
    });
    await host.closeAll();
  });

  it('un chat a una conversación no abierta se rechaza', async () => {
    const { frames, host } = setup(new MockProvider([makeTextRound('x')]));
    host.handle({ type: 'chat', conversationId: cid(), turnId: 't1', text: 'hola' }, 1);
    await host.idle();
    expect(frames).toMatchObject([{ type: 'chat_rejected', reason: 'unknown_conversation' }]);
  });

  it('reinicio del sidecar: un host nuevo rehidrata la conversación con su contexto (15.5)', async () => {
    const first = setup(new MockProvider([makeTextRound('Me llamo Stratum.')]));
    const id = cid();
    first.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    first.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'Soy Ana' }, 1);
    await first.ended('t1');

    // "Muere" el sidecar: host y agente nuevos sobre el mismo directorio de sesiones.
    const provider = new RecordingProvider([makeTextRound('Hola de nuevo, Ana.')]);
    const second = setup(provider, first.storeDir);
    second.host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
    second.host.handle(
      { type: 'chat', conversationId: id, turnId: 't2', text: '¿Cómo me llamo?' },
      1,
    );
    await second.ended('t2');

    expect(second.frames[0]).toMatchObject({
      type: 'conversation_opened',
      conversationId: id,
      resumed: true,
      messageCount: 2,
      title: 'Soy Ana',
      transcript: [{ turnId: 't1', user: { text: 'Soy Ana' }, status: 'done' }],
    });
    const sent = provider.requests[0].messages.map((m) => m.content);
    expect(sent).toContain('Soy Ana');
    expect(sent).toContain('Me llamo Stratum.');
    expect(sent.at(-1)).toBe('¿Cómo me llamo?');
  });

  it('resume sin sesión en disco abre una conversación vacía', async () => {
    const { frames, host } = setup(new MockProvider([makeTextRound('x')]));
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
    await host.idle();
    expect(frames).toMatchObject([
      { type: 'conversation_opened', conversationId: id, resumed: false, messageCount: 0 },
    ]);
  });

  it('detach del cliente activo cancela los turnos y guarda; el de otro cliente no hace nada', async () => {
    const { frames, host, waitFor, store } = setup(new HangingProvider());
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'largo' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'agent_event'));
    await host.detach(99);
    expect(host.size).toBe(1);
    await host.detach(1);
    expect(host.size).toBe(0);
    expect(store.load(id)?.messages.some((m) => m.content === 'largo')).toBe(true);
  });

  it('close_conversation cierra y confirma', async () => {
    const { frames, host, waitFor } = setup(new MockProvider([makeTextRound('x')]));
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'close_conversation', conversationId: id }, 1);
    await waitFor(() => frames.some((f) => f.type === 'conversation_closed'));
    expect(host.size).toBe(0);
  });
});

describe('ConversationSession — confirmaciones (15.4)', () => {
  type Confirm = (
    req: { callId: string; toolName: string; description: string },
    s: AbortSignal,
  ) => Promise<string>;

  function session(confirmTimeoutMs = 3_000) {
    const frames: ConversationOutboundFrame[] = [];
    const router = new ProviderRouter(config);
    const s = new ConversationSession({
      conversationId: cid(),
      config,
      router,
      store: new DesktopSessionStore(join(root, `c${++seq}`)),
      send: (f) => frames.push(f),
      confirmTimeoutMs,
    });
    const confirm = (s as unknown as { confirm: Confirm }).confirm.bind(s);
    return { s, frames, confirm };
  }

  const REQ = { callId: 'c1', toolName: 'write_file', description: 'write_file notas.md' };

  it('pide confirmación con la descripción y espera la respuesta', async () => {
    const { s, frames, confirm } = session();
    const decision = confirm(REQ, new AbortController().signal);
    expect(frames).toEqual([
      {
        type: 'confirm_request',
        conversationId: s.conversationId,
        callId: 'c1',
        tool: 'write_file',
        description: 'write_file notas.md',
      },
    ]);
    s.answerConfirm('c1', 'deny');
    await expect(decision).resolves.toBe('deny');
  });

  it('allow-all aprueba esta y las siguientes sin volver a preguntar', async () => {
    const { s, frames, confirm } = session();
    const first = confirm(REQ, new AbortController().signal);
    s.answerConfirm('c1', 'allow-all');
    await expect(first).resolves.toBe('approve');
    await expect(confirm({ ...REQ, callId: 'c2' }, new AbortController().signal)).resolves.toBe(
      'approve',
    );
    expect(frames.filter((f) => f.type === 'confirm_request')).toHaveLength(1);
  });

  it('sin respuesta en plazo → deny, y la UI recibe prompt_resolved', async () => {
    const { frames, confirm } = session(20);
    await expect(confirm(REQ, new AbortController().signal)).resolves.toBe('deny');
    expect(frames.at(-1)).toMatchObject({ type: 'prompt_resolved', kind: 'confirm', id: 'c1' });
  });

  it('cerrar la conversación deniega la confirmación pendiente', async () => {
    const { s, frames, confirm } = session();
    const decision = confirm(REQ, new AbortController().signal);
    await s.close();
    await expect(decision).resolves.toBe('deny');
    expect(frames.at(-1)).toMatchObject({ type: 'prompt_resolved', kind: 'confirm', id: 'c1' });
    // Tras cerrar, una confirmación nueva se deniega sin preguntar.
    await expect(confirm({ ...REQ, callId: 'c2' }, new AbortController().signal)).resolves.toBe(
      'deny',
    );
  });
});

/** Provider que ignora el abort: tarda `ms` pase lo que pase y luego responde. */
class StubbornProvider implements IProvider {
  constructor(private readonly ms: number) {}
  async *complete(): AsyncGenerator<OpenAIStreamChunk> {
    await new Promise((r) => setTimeout(r, this.ms));
    yield {
      choices: [{ delta: { content: 'tarde' }, finish_reason: 'stop', index: 0 }],
    } as OpenAIStreamChunk;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe('revisión final de Codex (D1)', () => {
  it('un turno que no atiende el cierre no pisa la sesión ni emite tras retirarse', async () => {
    const storeDir = join(root, `r${++seq}`);
    const store = new DesktopSessionStore(storeDir);
    const frames: ConversationOutboundFrame[] = [];
    const router = new ProviderRouter(config);
    vi.spyOn(router, 'getActive').mockReturnValue(new StubbornProvider(300));
    const s = new ConversationSession({
      conversationId: cid(),
      config,
      router,
      store,
      send: (f) => frames.push(f),
      closeGraceMs: 20,
    });
    s.chat('t1', 'hola');
    await s.close();
    const saved = store.load(s.conversationId);
    const framesAtClose = frames.length;
    expect(saved?.messages.some((m) => m.content === 'hola')).toBe(true);

    // Una sesión nueva reabre y guarda algo distinto; luego acaba el turno viejo.
    store.save({
      conversationId: s.conversationId,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'sesión nueva' }],
      toolCallCount: 0,
    });
    await new Promise((r) => setTimeout(r, 450));

    expect(store.load(s.conversationId)?.messages).toEqual([
      { role: 'user', content: 'sesión nueva' },
    ]);
    expect(frames.length).toBe(framesAtClose);
  });

  it('las tramas de un cliente que perdió el lease se descartan aunque ya estuvieran en cola', async () => {
    const { frames, host } = setup(new MockProvider([makeTextRound('x')]));
    const id = cid();
    // El cliente 1 encola una apertura y un chat y se va antes de que se procesen.
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    void host.detach(1);
    await host.idle();
    expect(host.size).toBe(0);
    expect(frames).toEqual([]);
  });

  it('aceptar una respuesta la acusa con prompt_resolved', async () => {
    const { frames, host, waitFor, ended } = setup(
      new MockProvider([
        makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
        makeTextRound('Sigo.'),
      ]),
    );
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'x' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'questions_request'));
    const req = frames.find((f) => f.type === 'questions_request');
    if (req?.type !== 'questions_request') throw new Error('sin questions_request');
    host.handle(
      { type: 'answer_questions', conversationId: id, requestId: req.requestId, answers: null },
      1,
    );
    await ended('t1');
    expect(frames).toContainEqual({
      type: 'prompt_resolved',
      conversationId: id,
      kind: 'questions',
      id: req.requestId,
    });
  });
});

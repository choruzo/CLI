import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationHost } from './conversation-host.js';
import { checkpointMessages } from './conversation.js';
import { DesktopConversationStore } from './conversation-store.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { MemoryPanel } from './memory-panel.js';
import { WorkspaceManager } from './workspace.js';
import { TurnCancelledInQueue, TurnScheduler } from './turn-scheduler.js';
import {
  applyTranscriptEvent,
  TRANSCRIPT_REASONING_CHARS,
  deriveTitle,
  newTurn,
  settleTranscriptTurn,
  transcriptFromMessages,
} from './transcript.js';
import { parseInboundFrame } from './codec.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { DecisionStore } from '../memory/decisions.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { Message } from '../agent/types.js';
import type { ConversationOutboundFrame } from './protocol.js';

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-d4-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function cid(): string {
  seq++;
  return `7a2c1c0e-3d2a-4b8e-9c1d-${seq.toString(16).padStart(12, '0')}`;
}

function makeConfig(dir: string) {
  return buildAssistantConfig(
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
      memory: { globalFile: join(dir, 'STRATUM.md'), autoExtract: false },
    }),
    join(dir, 'data'),
  );
}

/** Provider que emite un trozo y espera a que lo liberen (o aborten). */
class GatedProvider implements IProvider {
  private opened!: () => void;
  readonly gate = new Promise<void>((r) => (this.opened = r));
  constructor(private readonly label: string) {}
  open(): void {
    this.opened();
  }
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    yield {
      choices: [{ delta: { content: `${this.label}-1 ` }, finish_reason: null, index: 0 }],
    } as OpenAIStreamChunk;
    await Promise.race([
      this.gate,
      new Promise<void>((r) => req.signal?.addEventListener('abort', () => r(), { once: true })),
    ]);
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    yield {
      choices: [{ delta: { content: `${this.label}-2` }, finish_reason: 'stop', index: 0 }],
    } as OpenAIStreamChunk;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

interface SetupOpts {
  provider?: (id: number) => IProvider;
  maxConcurrentTurns?: number;
  workspaces?: WorkspaceManager;
  dir?: string;
  checkpointMs?: number;
}

function setup(opts: SetupOpts = {}) {
  const dir = opts.dir ?? join(root, `h${++seq}`);
  const config = makeConfig(dir);
  const frames: ConversationOutboundFrame[] = [];
  const store = new DesktopSessionStore(join(dir, 'sessions'));
  let routers = 0;
  const host = new ConversationHost({
    config,
    store,
    maxConcurrentTurns: opts.maxConcurrentTurns,
    workspaces: opts.workspaces,
    checkpointMs: opts.checkpointMs,
    makeRouter: () => {
      const router = new ProviderRouter(config);
      const n = routers++;
      const provider = opts.provider?.(n) ?? new MockProvider([makeTextRound('ok')]);
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
  const records = new DesktopConversationStore(join(dir, 'conversations'), store);
  return { dir, config, frames, store, records, host, waitFor, ended };
}

const text = (frames: ConversationOutboundFrame[], conversationId: string) =>
  frames
    .flatMap((f) =>
      f.type === 'agent_event' &&
      f.conversationId === conversationId &&
      f.event.type === 'text_delta'
        ? [f.event.delta]
        : [],
    )
    .join('');

describe('transcript (D4)', () => {
  it('acumula texto, tool calls y avisos como los ve la UI', () => {
    let t = newTurn('t1', 'hola', [], 'streaming');
    t = applyTranscriptEvent(t, { type: 'text_delta', delta: 'Voy ' });
    t = applyTranscriptEvent(t, {
      type: 'tool_call_start',
      id: 'c1',
      name: 'web_search',
      input_so_far: '{"q',
    });
    t = applyTranscriptEvent(t, {
      type: 'tool_call_ready',
      id: 'c1',
      name: 'web_search',
      input: { q: 'x' },
    });
    t = applyTranscriptEvent(t, {
      type: 'tool_result',
      id: 'c1',
      name: 'web_search',
      result: 'r'.repeat(20_000),
      durationMs: 5,
    });
    t = applyTranscriptEvent(t, { type: 'text_delta', delta: 'listo' });
    t = applyTranscriptEvent(t, { type: 'warning', message: 'ojo' });
    t = applyTranscriptEvent(t, { type: 'done', stopReason: 'stop' });
    expect(t.parts.map((p) => p.kind)).toEqual(['text', 'tool', 'text', 'notice']);
    expect(t.toolCalls.c1).toMatchObject({ state: 'completed', durationMs: 5 });
    // La salida se recorta: el transcript no crece con cada lectura grande.
    expect(t.toolCalls.c1.output!.length).toBeLessThan(9_000);
    expect(t.status).toBe('done');
  });

  it('guarda el razonamiento como bloques propios y recortados (D7)', () => {
    let t = newTurn('t1', 'hola', [], 'streaming');
    t = applyTranscriptEvent(t, { type: 'thinking', text: 'Pienso ' });
    t = applyTranscriptEvent(t, { type: 'thinking', text: 'un poco' });
    t = applyTranscriptEvent(t, { type: 'text_delta', delta: 'Hola' });
    t = applyTranscriptEvent(t, { type: 'thinking', text: 'x'.repeat(TRANSCRIPT_REASONING_CHARS) });
    t = applyTranscriptEvent(t, { type: 'thinking', text: 'más' });
    expect(t.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'reasoning']);
    expect(t.parts[0]).toEqual({ kind: 'reasoning', text: 'Pienso un poco' });
    const last = t.parts[2];
    expect(last.kind === 'reasoning' && last.text.endsWith('(recortado)')).toBe(true);
    expect(last.kind === 'reasoning' && last.text.includes('más')).toBe(false);
  });

  it('un turno sin terminar se guarda como interrumpido, sin tools «ejecutándose»', () => {
    let t = newTurn('t1', 'hola', [], 'streaming');
    t = applyTranscriptEvent(t, {
      type: 'tool_call_ready',
      id: 'c1',
      name: 'read_file',
      input: {},
    });
    const settled = settleTranscriptTurn(t, 'interrupted');
    expect(settled.status).toBe('interrupted');
    expect(settled.toolCalls.c1.state).toBe('error');
  });

  it('título derivado: una línea, cortado por palabra; sin texto, el primer adjunto', () => {
    expect(deriveTitle('  Resumen\n de ventas  ')).toBe('Resumen de ventas');
    const long = deriveTitle('palabra '.repeat(20));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
    expect(deriveTitle('', [{ path: 'inputs/a.csv', name: 'a.csv', size: 1 }])).toBe('a.csv');
  });

  it('las sesiones anteriores a D4 se leen desde el historial del agente', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content:
          '<attachments>\nThe user attached these files to this message. They are in the conversation workspace:\n- inputs/v.csv (text/csv, 10 B)\n</attachments>\n\nresume',
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'datos' },
      { role: 'assistant', content: 'Hecho.' },
    ];
    const [turn] = transcriptFromMessages(messages, '2026-09-01T00:00:00.000Z');
    expect(turn.user).toEqual({
      text: 'resume',
      attachments: [{ path: 'inputs/v.csv', name: 'v.csv', size: 0 }],
    });
    expect(turn.toolCalls.c1).toMatchObject({ name: 'read_file', output: 'datos' });
    expect(turn.parts.at(-1)).toEqual({ kind: 'text', text: 'Hecho.' });
  });
});

describe('checkpointMessages (15.12)', () => {
  const call = (id: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'read_file', arguments: '{}' },
  });

  it('quita un assistant con tool_calls sin todas sus respuestas y el user sin respuesta', () => {
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    expect(checkpointMessages(msgs)).toEqual([{ role: 'system', content: 's' }]);
  });

  it('conserva un bloque de tools completo', () => {
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [call('a')] },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    expect(checkpointMessages(msgs)).toEqual(msgs);
  });
});

describe('TurnScheduler (15.15)', () => {
  it('respeta el límite y atiende la cola en orden', async () => {
    const s = new TurnScheduler(1);
    const order: string[] = [];
    const a = s.acquire();
    const positions: number[] = [];
    const b = s.acquire(undefined, (p) => positions.push(p));
    const c = s.acquire();
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
    void b.ready.then(() => order.push('b'));
    void c.ready.then(() => order.push('c'));
    a.release();
    await b.ready;
    expect(order).toEqual(['b']);
    b.release();
    await c.ready;
    expect(order).toEqual(['b', 'c']);
    expect(s.active).toBe(1);
    c.release();
    c.release(); // idempotente
    expect(s.active).toBe(0);
  });

  it('cancelar en cola saca al turno sin ocupar hueco', async () => {
    const s = new TurnScheduler(1);
    const a = s.acquire();
    const abort = new AbortController();
    const b = s.acquire(abort.signal);
    abort.abort();
    await expect(b.ready).rejects.toBeInstanceOf(TurnCancelledInQueue);
    expect(s.waiting).toBe(0);
    a.release();
    expect(s.active).toBe(0);
  });
});

describe('conversaciones múltiples (D4)', () => {
  it('dos conversaciones generan en paralelo sin mezclar streams ni workspaces', async () => {
    const providers = [new GatedProvider('A'), new GatedProvider('B')];
    const workspaces = new WorkspaceManager({
      root: join(root, `ws${++seq}`),
      maxFileBytes: 1024,
      maxWorkspaceBytes: 4096,
    });
    const { host, frames, waitFor, ended } = setup({
      provider: (n) => providers[n]!,
      workspaces,
    });
    const a = cid();
    const b = cid();
    host.handle({ type: 'new_conversation', conversationId: a }, 1);
    host.handle({ type: 'new_conversation', conversationId: b }, 1);
    host.handle({ type: 'chat', conversationId: a, turnId: 'ta', text: 'uno' }, 1);
    host.handle({ type: 'chat', conversationId: b, turnId: 'tb', text: 'dos' }, 1);
    // Las dos arrancan sin esperar a la otra (límite 2 por defecto).
    await waitFor(() => text(frames, a) === 'A-1 ' && text(frames, b) === 'B-1 ');
    expect(frames.some((f) => f.type === 'turn_queued')).toBe(false);
    providers[1]!.open();
    await ended('tb');
    providers[0]!.open();
    await ended('ta');
    expect(text(frames, a)).toBe('A-1 A-2');
    expect(text(frames, b)).toBe('B-1 B-2');
    // Cada evento lleva el turno de su conversación.
    for (const f of frames) {
      if (f.type === 'agent_event') expect(f.turnId).toBe(f.conversationId === a ? 'ta' : 'tb');
    }
    const opened = frames.filter((f) => f.type === 'conversation_opened');
    expect(new Set(opened.map((f) => f.conversationId))).toEqual(new Set([a, b]));
    expect(existsSync(join(workspaces.root, a))).toBe(true);
    expect(existsSync(join(workspaces.root, b))).toBe(true);
    await host.closeAll();
  });

  it('pasado el límite, el turno espera en cola y arranca cuando se libera un hueco', async () => {
    const providers = [new GatedProvider('A'), new GatedProvider('B')];
    const { host, frames, waitFor, ended } = setup({
      provider: (n) => providers[n]!,
      maxConcurrentTurns: 1,
    });
    const a = cid();
    const b = cid();
    host.handle({ type: 'new_conversation', conversationId: a }, 1);
    host.handle({ type: 'new_conversation', conversationId: b }, 1);
    host.handle({ type: 'chat', conversationId: a, turnId: 'ta', text: 'uno' }, 1);
    host.handle({ type: 'chat', conversationId: b, turnId: 'tb', text: 'dos' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'turn_queued'));
    expect(frames.find((f) => f.type === 'turn_queued')).toMatchObject({
      conversationId: b,
      turnId: 'tb',
      position: 1,
    });
    expect(text(frames, b)).toBe('');
    providers[0]!.open();
    providers[1]!.open();
    await ended('ta');
    await ended('tb');
    const started = frames.findIndex((f) => f.type === 'turn_started' && f.turnId === 'tb');
    const endedA = frames.findIndex((f) => f.type === 'turn_ended' && f.turnId === 'ta');
    expect(started).toBeGreaterThan(endedA);
    expect(text(frames, b)).toBe('B-1 B-2');
  });

  it('cancelar un turno en cola lo cierra como cancelado sin llamar al modelo', async () => {
    const providers = [new GatedProvider('A'), new GatedProvider('B')];
    const complete = vi.spyOn(providers[1]!, 'complete');
    const { host, frames, waitFor, ended } = setup({
      provider: (n) => providers[n]!,
      maxConcurrentTurns: 1,
    });
    const a = cid();
    const b = cid();
    host.handle({ type: 'new_conversation', conversationId: a }, 1);
    host.handle({ type: 'new_conversation', conversationId: b }, 1);
    host.handle({ type: 'chat', conversationId: a, turnId: 'ta', text: 'uno' }, 1);
    host.handle({ type: 'chat', conversationId: b, turnId: 'tb', text: 'dos' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'turn_queued'));
    host.handle({ type: 'cancel', conversationId: b, turnId: 'tb' }, 1);
    await ended('tb');
    expect(frames.find((f) => f.type === 'turn_ended' && f.turnId === 'tb')).toMatchObject({
      stopReason: 'cancelled',
    });
    expect(complete).not.toHaveBeenCalled();
    providers[0]!.open();
    await ended('ta');
  });

  it('listado, título derivado, renombrar y eliminar (con su workspace archivado)', async () => {
    const workspaces = new WorkspaceManager({
      root: join(root, `ws${++seq}`),
      maxFileBytes: 1024,
      maxWorkspaceBytes: 4096,
    });
    const { host, frames, waitFor, ended, store, records } = setup({ workspaces });
    const a = cid();
    const b = cid();
    host.handle({ type: 'new_conversation', conversationId: a }, 1);
    host.handle(
      { type: 'chat', conversationId: a, turnId: 't1', text: 'Plan de viaje a Lisboa' },
      1,
    );
    await ended('t1');
    host.handle({ type: 'new_conversation', conversationId: b }, 1);
    host.handle({ type: 'chat', conversationId: b, turnId: 't2', text: 'Receta de pan' }, 1);
    await ended('t2');
    // Una abierta y sin usar no aparece.
    const c = cid();
    host.handle({ type: 'new_conversation', conversationId: c }, 1);
    host.handle({ type: 'list_conversations' }, 1);
    await host.idle();
    const list = [...frames].reverse().find((f) => f.type === 'conversations');
    if (list?.type !== 'conversations') throw new Error('sin listado');
    expect(list.items.map((i) => [i.conversationId, i.title])).toEqual([
      [b, 'Receta de pan'],
      [a, 'Plan de viaje a Lisboa'],
    ]);
    expect(list.items[0].workspace).toMatchObject({ state: 'active', sizeBytes: 0 });

    // Renombrar una cerrada: se guarda y se anuncia.
    host.handle({ type: 'close_conversation', conversationId: a }, 1);
    await waitFor(() => frames.some((f) => f.type === 'conversation_closed'));
    host.handle({ type: 'rename_conversation', conversationId: a, title: '  Lisboa\n2027 ' }, 1);
    await host.idle();
    expect([...frames].reverse().find((f) => f.type === 'conversation_updated')).toMatchObject({
      summary: { conversationId: a, title: 'Lisboa 2027', titleEdited: true },
    });
    expect(records.load(a)?.title).toBe('Lisboa 2027');

    // Eliminar una archivada: se van la sesión, el registro y el archivo.
    writeFileSync(join(workspaces.root, a, 'outputs', 'x.txt'), 'hola');
    await workspaces.withLock(a, () => workspaces.archive(a));
    expect(existsSync(workspaces.archivePath(a))).toBe(true);
    host.handle({ type: 'delete_conversation', conversationId: a }, 1);
    await waitFor(() => frames.some((f) => f.type === 'conversation_deleted'));
    expect(store.exists(a)).toBe(false);
    expect(records.ids()).not.toContain(a);
    expect(existsSync(workspaces.archivePath(a))).toBe(false);
    expect(existsSync(workspaces.recordPath(a))).toBe(false);

    // Eliminar una abierta: se cierra y se borra su carpeta.
    host.handle({ type: 'delete_conversation', conversationId: b }, 1);
    await waitFor(() => frames.filter((f) => f.type === 'conversation_deleted').length === 2);
    expect(host.size).toBe(1);
    expect(existsSync(join(workspaces.root, b))).toBe(false);
    await host.closeAll();
  });

  it('fijar desde el sidebar una conversación cerrada (activa o archivada)', async () => {
    const workspaces = new WorkspaceManager({
      root: join(root, `ws${++seq}`),
      maxFileBytes: 1024,
      maxWorkspaceBytes: 4096,
    });
    const { host, frames, ended, waitFor } = setup({ workspaces });
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await ended('t1');
    host.handle({ type: 'close_conversation', conversationId: id }, 1);
    await waitFor(() => frames.some((f) => f.type === 'conversation_closed'));
    host.handle({ type: 'workspace_pin', conversationId: id, pinned: true }, 1);
    await waitFor(() =>
      frames.some((f) => f.type === 'conversation_updated' && f.summary.workspace?.pinned === true),
    );
    expect(workspaces.statusOf(id)).toMatchObject({ state: 'active', pinned: true, purgeAt: null });
    // Archivada: se fija en el registro, sin restaurarla.
    await workspaces.withLock(id, () => workspaces.archive(id));
    await workspaces.setPinned(id, false);
    expect(workspaces.statusOf(id)).toMatchObject({ state: 'archived', pinned: false });
    await host.closeAll();
  });

  it('un borrador abandonado (sin mensajes ni ficheros) no deja carpeta; uno usado sí', async () => {
    const workspaces = new WorkspaceManager({
      root: join(root, `ws${++seq}`),
      maxFileBytes: 1024,
      maxWorkspaceBytes: 4096,
    });
    const { host, frames, waitFor, ended } = setup({ workspaces });
    const draft = cid();
    const used = cid();
    host.handle({ type: 'new_conversation', conversationId: draft }, 1);
    host.handle({ type: 'new_conversation', conversationId: used }, 1);
    host.handle({ type: 'chat', conversationId: used, turnId: 't1', text: 'hola' }, 1);
    await ended('t1');
    await host.idle();
    expect(existsSync(join(workspaces.root, draft))).toBe(true);
    host.handle({ type: 'close_conversation', conversationId: draft }, 1);
    host.handle({ type: 'close_conversation', conversationId: used }, 1);
    await waitFor(() => frames.filter((f) => f.type === 'conversation_closed').length === 2);
    expect(existsSync(join(workspaces.root, draft))).toBe(false);
    expect(existsSync(join(workspaces.root, used))).toBe(true);
    // Reabrir el borrador lo crea otra vez, sin restos.
    host.handle({ type: 'new_conversation', conversationId: draft, resume: true }, 1);
    await host.idle();
    expect(existsSync(join(workspaces.root, draft))).toBe(true);
    await host.closeAll();
  });

  it('un título vacío no es una trama válida', () => {
    const id = cid();
    expect(
      parseInboundFrame(
        JSON.stringify({ type: 'rename_conversation', conversationId: id, title: ' \n ' }),
      ),
    ).toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'set_model', conversationId: id, model: '   ' })),
    ).toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'memory_forget', id: 'x', extra: 1 })),
    ).toBeNull();
  });

  it('/clear vacía el historial y el transcript; /model es por conversación y persiste', async () => {
    const first = setup({ provider: () => new MockProvider([makeTextRound('respuesta')]) });
    const id = cid();
    first.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    first.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await first.ended('t1');
    first.host.handle({ type: 'set_model', conversationId: id, model: 'otro-modelo' }, 1);
    await first.host.idle();
    expect([...first.frames].reverse().find((f) => f.type === 'conversation_stats')).toMatchObject({
      stats: { model: 'otro-modelo', provider: 'test' },
    });
    await first.host.closeAll();

    // Al reabrir (sidecar nuevo) se reaplica el modelo de la conversación.
    const second = setup({ dir: first.dir });
    second.host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
    await second.host.idle();
    expect(second.frames[0]).toMatchObject({
      type: 'conversation_opened',
      stats: { model: 'otro-modelo' },
      transcript: [{ turnId: 't1' }],
    });
    // Otra conversación nueva sigue con el modelo de la config.
    const other = cid();
    second.host.handle({ type: 'new_conversation', conversationId: other }, 1);
    await second.host.idle();
    expect(second.frames.at(-1)).toMatchObject({ stats: { model: 'test-model' } });

    second.host.handle({ type: 'clear_conversation', conversationId: id }, 1);
    await second.host.idle();
    expect(second.frames).toContainEqual({ type: 'conversation_cleared', conversationId: id });
    expect(second.store.load(id)?.messages.map((m) => m.role)).toEqual(['system']);
    expect(second.records.load(id)?.transcript).toEqual([]);
    await second.host.closeAll();
  });

  it('/clear durante un turno se rechaza con aviso', async () => {
    const gated = new GatedProvider('A');
    const { host, frames, waitFor, ended } = setup({ provider: () => gated });
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await waitFor(() => text(frames, id) !== '');
    host.handle({ type: 'clear_conversation', conversationId: id }, 1);
    await host.idle();
    expect(frames.find((f) => f.type === 'conversation_notice')).toMatchObject({
      tone: 'warning',
    });
    gated.open();
    await ended('t1');
  });

  it('cierre forzado en el primer turno, antes de ningún checkpoint: el mensaje no se pierde', async () => {
    const gated = new GatedProvider('A');
    const first = setup({ provider: () => gated });
    const id = cid();
    first.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    first.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'no me pierdas' }, 1);
    await first.waitFor(() => text(first.frames, id) !== '');
    // El proceso "muere" aquí: un sidecar nuevo lee el disco.
    const second = setup({ dir: first.dir });
    second.host.handle({ type: 'list_conversations' }, 1);
    second.host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
    await second.host.idle();
    expect(second.frames[0]).toMatchObject({
      type: 'conversations',
      items: [{ conversationId: id, title: 'no me pierdas' }],
    });
    expect(second.frames[1]).toMatchObject({
      type: 'conversation_opened',
      transcript: [{ turnId: 't1', status: 'interrupted', user: { text: 'no me pierdas' } }],
    });
    await second.host.closeAll();
    gated.open();
    await first.host.closeAll();
  });

  it('cierre forzado a mitad de turno: la conversación se recupera con lo hecho (15.12)', async () => {
    const workspaces = new WorkspaceManager({
      root: join(root, `ws${++seq}`),
      maxFileBytes: 1024,
      maxWorkspaceBytes: 4096,
    });
    // Una tool que termina y luego el modelo se queda colgado: el proceso "muere" ahí.
    class ToolThenHang implements IProvider {
      private n = 0;
      async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
        if (this.n++ === 0) {
          yield* makeToolCallRound('l1', 'list_directory', { path: 'outputs' });
          return;
        }
        await new Promise<void>((r) =>
          req.signal?.addEventListener('abort', () => r(), { once: true }),
        );
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      async healthCheck(): Promise<boolean> {
        return true;
      }
    }
    const first = setup({ provider: () => new ToolThenHang(), workspaces });
    const id = cid();
    first.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    first.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'mira outputs' }, 1);
    await first.waitFor(() =>
      first.frames.some((f) => f.type === 'agent_event' && f.event.type === 'tool_result'),
    );
    // Sin cerrar nada: lo que hay en disco es el checkpoint tras la tool.
    const onDisk = first.store.load(id)!;
    expect(onDisk.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    const rec = JSON.parse(
      readFileSync(join(first.dir, 'conversations', `${id}.json`), 'utf-8'),
    ) as { transcript: { status: string; toolCalls: Record<string, { state: string }> }[] };
    expect(rec.transcript[0].status).toBe('streaming');
    expect(rec.transcript[0].toolCalls.l1.state).toBe('completed');

    // Sidecar nuevo sobre el mismo disco (el viejo se abandona sin guardar).
    const second = setup({ dir: first.dir, workspaces: new WorkspaceManager(workspaces.settings) });
    second.host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
    await second.host.idle();
    expect(second.frames[0]).toMatchObject({
      type: 'conversation_opened',
      resumed: true,
      messageCount: 3,
      transcript: [{ turnId: 't1', status: 'interrupted', user: { text: 'mira outputs' } }],
    });
    await second.host.closeAll();
    await first.host.closeAll();
  });
});

describe('memoria global (D4, §7.3)', () => {
  it('se lee, se guarda con control de conflictos y se borran decisiones', async () => {
    const { host, frames, dir, config } = setup();
    const globalFile = join(dir, 'STRATUM.md');
    host.handle({ type: 'memory_get' }, 1);
    await host.idle();
    expect(frames.at(-1)).toMatchObject({
      type: 'memory_state',
      global: { exists: false, content: '', mtimeMs: null },
      decisions: [],
    });

    host.handle({ type: 'memory_save', content: '# Yo\n\nPrefiero tablas.', baseMtimeMs: null }, 1);
    await host.idle();
    const saved = frames.at(-1);
    if (saved?.type !== 'memory_saved') throw new Error(`esperaba memory_saved: ${saved?.type}`);
    expect(readFileSync(globalFile, 'utf-8')).toBe('# Yo\n\nPrefiero tablas.');

    // Otro editor lo cambia: guardar sobre la versión vieja no lo pisa.
    writeFileSync(globalFile, '# Cambiado desde la CLI');
    const future = new Date(Date.now() + 5_000);
    const { utimesSync } = await import('fs');
    utimesSync(globalFile, future, future);
    host.handle({ type: 'memory_save', content: 'mío', baseMtimeMs: saved.mtimeMs }, 1);
    await host.idle();
    expect(frames.at(-1)).toMatchObject({
      type: 'memory_conflict',
      content: '# Cambiado desde la CLI',
    });
    expect(readFileSync(globalFile, 'utf-8')).toBe('# Cambiado desde la CLI');

    // Decisiones del asistente: se listan y se borran.
    const decisionsFile = config.memory.decisionsFile;
    mkdirSync(join(decisionsFile, '..'), { recursive: true });
    const record = new DecisionStore(decisionsFile).add({
      title: 'Usa tablas',
      content: 'El usuario prefiere tablas.',
      type: 'user_preference',
      tags: [],
      importance: 'medium',
    });
    vi.spyOn(MemoryPanel.prototype, 'forget').mockImplementation(async (id) =>
      new DecisionStore(decisionsFile).remove(id),
    );
    host.handle({ type: 'memory_get' }, 1);
    await host.idle();
    expect(frames.at(-1)).toMatchObject({ decisions: [{ id: record.id, title: 'Usa tablas' }] });
    host.handle({ type: 'memory_forget', id: record.id }, 1);
    await host.idle();
    expect(frames.at(-1)).toMatchObject({ type: 'memory_state', decisions: [] });
    vi.restoreAllMocks();
  });
});

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RENAME_RETRY_DELAYS_MS, sweepTempFiles, writeFileAtomicSync } from './atomic-file.js';
import { ConversationSession } from './conversation.js';
import { DesktopConversationStore } from './conversation-store.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { CANCELLED_BY_USER } from '../agent/cancel.js';
import type { Message } from '../agent/types.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { ConversationOutboundFrame } from './protocol.js';

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-save-'));
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
const cid = () => `6f1c1c0e-3d2a-4b8e-9c1d-${(++seq).toString(16).padStart(12, '0')}`;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Emite un trozo y espera `ms`; con `ignoreAbort` no atiende la cancelación. */
class SlowProvider implements IProvider {
  constructor(
    private readonly ms: number,
    private readonly ignoreAbort = false,
  ) {}
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    yield {
      choices: [{ delta: { content: 'Empiezo…' }, finish_reason: null, index: 0 }],
    } as OpenAIStreamChunk;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.ms);
      t.unref();
      if (!this.ignoreAbort) req.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    yield {
      choices: [{ delta: { content: ' fin.' }, finish_reason: 'stop', index: 0 }],
    } as OpenAIStreamChunk;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push({ ...req, messages: [...req.messages] });
    return super.complete(req);
  }
}

function session(
  provider: IProvider,
  extra: Partial<ConstructorParameters<typeof ConversationSession>[0]> = {},
) {
  const dir = join(root, `c${++seq}`);
  const store = new DesktopSessionStore(join(dir, 'sessions'));
  const records = new DesktopConversationStore(join(dir, 'conversations'), store);
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const frames: ConversationOutboundFrame[] = [];
  const s = new ConversationSession({
    conversationId: cid(),
    config,
    router,
    store,
    records,
    send: (f) => frames.push(f),
    ...extra,
  });
  const ended = async (turnId: string) => {
    const deadline = Date.now() + 3_000;
    while (!frames.some((f) => f.type === 'turn_ended' && f.turnId === turnId)) {
      if (Date.now() > deadline) throw new Error(`sin turn_ended: ${frames.map((f) => f.type)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { s, store, records, frames, ended };
}

describe('writeFileAtomicSync', () => {
  it('reintenta el rename ante un bloqueo transitorio de Windows', () => {
    const path = join(root, `a${++seq}.json`);
    let calls = 0;
    const sleeps: number[] = [];
    writeFileAtomicSync(path, '{"ok":true}', {
      rename: (from, to) => {
        if (++calls <= 2) throw errno('EPERM');
        rmSync(to, { force: true });
        writeFileSync(to, readFileSync(from));
        rmSync(from);
      },
      sleep: (ms) => sleeps.push(ms),
    });
    expect(readFileSync(path, 'utf-8')).toBe('{"ok":true}');
    expect(sleeps).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('agotados los reintentos lanza y no deja el temporal', () => {
    const dir = join(root, `d${++seq}`);
    mkdirSync(dir);
    const path = join(dir, 'x.json');
    expect(() =>
      writeFileAtomicSync(path, '{}', {
        rename: () => {
          throw errno('EBUSY');
        },
        sleep: () => undefined,
      }),
    ).toThrow('EBUSY');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('un error no transitorio no se reintenta', () => {
    const dir = join(root, `d${++seq}`);
    mkdirSync(dir);
    const sleep = vi.fn();
    expect(() =>
      writeFileAtomicSync(join(dir, 'x.json'), '{}', {
        rename: () => {
          throw errno('ENOSPC');
        },
        sleep,
      }),
    ).toThrow('ENOSPC');
    expect(sleep).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('sweepTempFiles', () => {
  it('borra solo los temporales viejos; nunca un .json ni uno reciente', () => {
    const dir = join(root, `d${++seq}`);
    mkdirSync(dir);
    const id = '6f1c1c0e-3d2a-4b8e-9c1d-000000000abc';
    const old = [`${id}.json.123.tmp`, `${id}.json.123.4.tmp`];
    for (const f of [...old, `${id}.json`, `${id}.json.999.7.tmp`, 'otro.tmp']) {
      writeFileSync(join(dir, f), 'x');
    }
    const past = new Date(Date.now() - 60 * 60_000);
    for (const f of [...old, `${id}.json`, 'otro.tmp']) utimesSync(join(dir, f), past, past);

    expect(sweepTempFiles(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(
      [`${id}.json`, `${id}.json.999.7.tmp`, 'otro.tmp'].sort(),
    );
  });

  it('sin directorio no lanza', () => {
    expect(sweepTempFiles(join(root, 'no-existe'))).toBe(0);
  });
});

describe('ConversationSession: guardado', () => {
  it('reanudar cierra las tool calls que el historial dejó sin respuesta', async () => {
    const provider = new RecordingProvider([makeTextRound('Vale.')]);
    const initialMessages: Message[] = [
      { role: 'user', content: 'lee el fichero' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
    ];
    const { s, ended } = session(provider, { initialMessages });
    s.chat('t1', 'sigue');
    await ended('t1');
    const sent = provider.requests[0]!.messages;
    const i = sent.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(sent[i + 1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: CANCELLED_BY_USER,
    });
  });

  it('cerrar con un turno en marcha guarda en el acto, sin esperar al plazo de gracia', async () => {
    const { s, records, frames } = session(new SlowProvider(5_000, true), {
      closeGraceMs: 60_000,
    });
    s.chat('t1', 'hola');
    const deadline = Date.now() + 3_000;
    while (!frames.some((f) => f.type === 'agent_event' && f.event.type === 'text_delta')) {
      if (Date.now() > deadline) throw new Error('sin texto');
      await new Promise((r) => setTimeout(r, 10));
    }
    void s.close();
    // Síncrono: el apagado del sidecar no espera los 60 s de gracia.
    const turn = records.load(s.conversationId)?.transcript[0];
    expect(JSON.stringify(turn?.parts)).toContain('Empiezo');
  });

  it('un fallo de guardado se avisa una vez por racha, y también cuando se recupera', async () => {
    const { s, store, frames, ended } = session(
      new MockProvider([makeTextRound('uno'), makeTextRound('dos'), makeTextRound('tres')]),
    );
    const spy = vi.spyOn(store, 'save').mockImplementation(() => {
      throw errno('ENOSPC');
    });
    s.chat('t1', 'a');
    await ended('t1');
    s.chat('t2', 'b');
    await ended('t2');
    const warnings = frames.filter((f) => f.type === 'conversation_notice' && f.tone === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: expect.stringContaining('ENOSPC') });

    spy.mockRestore();
    s.chat('t3', 'c');
    await ended('t3');
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'conversation_notice', tone: 'info' }),
    );
    expect(store.load(s.conversationId)?.messages.some((m) => m.content === 'tres')).toBe(true);
  });

  it('un checkpoint sin cambios en el historial no reescribe la sesión', async () => {
    const initialMessages: Message[] = [
      { role: 'user', content: 'antes' },
      { role: 'assistant', content: 'vale' },
    ];
    const { s, store } = session(new SlowProvider(300), { initialMessages, checkpointMs: 20 });
    const spy = vi.spyOn(store, 'save');
    s.chat('t1', 'hola');
    await new Promise((r) => setTimeout(r, 200));
    // Varios checkpoints con el mismo historial reanudable: una sola escritura.
    expect(spy).toHaveBeenCalledTimes(1);
    await s.close();
  });

  it('la sesión se guarda sin sangrado', async () => {
    const { s, store, ended } = session(new MockProvider([makeTextRound('hola')]));
    s.chat('t1', 'hola');
    await ended('t1');
    const path = join(store.dir, `${s.conversationId}.json`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('\n');
  });
});

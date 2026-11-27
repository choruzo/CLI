import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import type {
  ProtocolEvent,
  ProtocolReminder,
  ProtocolRun,
  SteerStatus,
} from '../protocol/index.js';
import type { UserImage } from '../agent/user-images.js';
import { TelegramApiError, type TelegramMessage } from '../channels/telegram/api.js';
import {
  TEXT,
  fromDot,
  imageRejected,
  turnFailed,
  warningLine,
} from '../channels/telegram/render.js';
import { CompanionLink, type CompanionTurns, type VoiceTraceMeta } from './channel-companion.js';
import type {
  VoiceModelHookInfo,
  VoiceModelPhase,
  VoiceNoteHooks,
  VoiceNoteResult,
  VoiceNotesPort,
} from './voice-notes.js';
import { VoiceQueueFullError } from '../voice/client.js';

/** Una sesión del companion de mentira: registra lo que se le pide. */
class FakeTurns implements CompanionTurns {
  readonly sessionId = 'ses_companion';
  running = false;
  started: string[] = [];
  steered: string[] = [];
  /** Las imágenes de cada `startRun`/`steer`, en orden. */
  images: (readonly UserImage[])[] = [];
  /** M25 fase 3 — los metadatos de cada nota de voz que llegaron a la traza. */
  traced: VoiceTraceMeta[] = [];
  steerStatus: SteerStatus = 'accepted';
  busyOnce = false;
  private idleWaiters: (() => void)[] = [];

  startRun(input: string, images: readonly UserImage[] = []): ProtocolRun {
    if (this.busyOnce) {
      this.busyOnce = false;
      this.running = true;
      throw new ProtocolError('BUSY', 'busy');
    }
    this.started.push(input);
    this.images.push(images);
    this.running = true;
    return { id: `run${this.started.length}` } as ProtocolRun;
  }
  steer(text: string, images: readonly UserImage[] = []): SteerStatus {
    this.steered.push(text);
    this.images.push(images);
    return this.steerStatus;
  }
  async waitAtSafePoint(): Promise<void> {}
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  traceVoice(meta: VoiceTraceMeta): void {
    this.traced.push(meta);
  }
  finish(): void {
    this.running = false;
    for (const w of this.idleWaiters.splice(0)) w();
  }
}

function message(text: string | undefined, hasMedia = false): TelegramMessage {
  return {
    messageId: 1,
    date: 0,
    chat: { id: 42, type: 'private' },
    ...(text !== undefined ? { text } : {}),
    hasMedia,
  };
}

function setup(
  opts: {
    open?: () => Promise<CompanionTurns>;
    chats?: number[];
    files?: Map<string, Uint8Array | Error>;
    /** M25 fase 3 — las notas de voz, si el test las monta. */
    voiceNotes?: VoiceNotesPort;
    voiceFiles?: Map<string, Uint8Array | Error>;
    pairedKey?: (chatId: number) => string | undefined;
  } = {},
) {
  const turns = new FakeTurns();
  const sent: { chatId: number; text: string }[] = [];
  const markdown: { chatId: number; text: string }[] = [];
  const typing: number[] = [];
  const images: { chatId: number; name: string; mime: string; caption: string }[] = [];
  const link = new CompanionLink({
    companion: { open: opts.open ?? (async () => turns), currentId: () => turns.sessionId },
    readImage: (id) =>
      id === 'img1' ? { data: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' } : null,
    download: async (image, maxBytes) => {
      const file = opts.files?.get(image.fileId);
      if (!file) throw new TelegramApiError('api', 'not found');
      if (file instanceof Error) throw file;
      if (file.length > maxBytes) throw new TelegramApiError('too-large', 'too large');
      return file;
    },
    ...(opts.voiceNotes
      ? {
          voiceNotes: opts.voiceNotes,
          downloadVoice: async (
            voice: { fileId: string },
            maxBytes: number,
          ): Promise<Uint8Array> => {
            const file = opts.voiceFiles?.get(voice.fileId);
            if (!file) throw new TelegramApiError('api', 'not found');
            if (file instanceof Error) throw file;
            if (file.length > maxBytes) throw new TelegramApiError('too-large', 'too large');
            return file;
          },
        }
      : {}),
    target: () => ({
      send: (chatId, text) => sent.push({ chatId, text }),
      sendMarkdown: (chatId, text) => markdown.push({ chatId, text }),
      sendImage: (chatId, file, caption) =>
        images.push({ chatId, name: file.name, mime: file.mime, caption }),
      typing: (chatId) => typing.push(chatId),
    }),
    chats: () => opts.chats ?? [42],
    ...(opts.pairedKey ? { pairedKey: opts.pairedKey } : {}),
    redact: (text) => text.replaceAll('sk-secreto1', '[redacted]'),
    typingIntervalMs: 10,
  });
  return { turns, sent, markdown, typing, images, link };
}

let seq = 0;
function ev<T extends ProtocolEvent['type']>(
  type: T,
  data: unknown,
  extra: Record<string, unknown> = {},
): ProtocolEvent {
  return { type, sessionId: 'ses_companion', seq: ++seq, at: 0, data, ...extra } as ProtocolEvent;
}

const run = (over: Partial<ProtocolRun> = {}): ProtocolRun =>
  ({ id: 'r1', kind: 'run', input: 'hola', status: 'running', ...over }) as ProtocolRun;

describe('CompanionLink: fotos del chat (6E)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const photo = (fileId: string, caption?: string): TelegramMessage => ({
    ...message(undefined, true),
    ...(caption !== undefined ? { caption } : {}),
    image: { fileId },
  });

  it('con pie de foto: abre un turno con ese texto y la imagen en memoria', async () => {
    const { turns, link } = setup({ files: new Map([['f1', PNG]]) });
    await link.input(42, photo('f1', ' ¿qué es esto? '));
    expect(turns.started).toEqual(['¿qué es esto?']);
    expect(turns.images[0]).toHaveLength(1);
    expect(turns.images[0]![0]).toMatchObject({ mime: 'image/png', bytes: PNG.length });
  });

  it('sin texto lleva una marca; con turno en curso, es steering con la imagen', async () => {
    const { turns, link } = setup({ files: new Map([['f1', PNG]]) });
    turns.running = true;
    await link.input(42, photo('f1'));
    expect(turns.steered).toEqual([TEXT.photoInput]);
    expect(turns.images[0]).toHaveLength(1);
  });

  it('demasiado grande, no es una imagen o no se descarga: se dice y no llega nada', async () => {
    const { turns, link, sent } = setup({
      files: new Map<string, Uint8Array | Error>([
        ['big', new Uint8Array(6 * 1024 * 1024)],
        ['pdf', new TextEncoder().encode('%PDF-1.7 ...')],
        ['net', new TelegramApiError('network', 'boom')],
      ]),
    });
    await link.input(42, photo('big', 'a'));
    await link.input(42, photo('pdf', 'b'));
    await link.input(42, photo('net', 'c'));
    expect(turns.started).toEqual([]);
    expect(sent.map((s) => s.text)).toEqual([
      imageRejected(new TelegramApiError('too-large', '')),
      expect.stringContaining('not a PNG, JPEG, WebP or GIF'),
      expect.stringContaining('could not be downloaded'),
    ]);
  });

  it('otros adjuntos siguen sin pasar', async () => {
    const { turns, link, sent } = setup();
    await link.input(42, message(undefined, true));
    expect(turns.started).toEqual([]);
    expect(sent).toEqual([{ chatId: 42, text: TEXT.textOnly }]);
  });

  it('una imagen que envía el asistente llega a cada chat, con el pie redactado otra vez', () => {
    const { link, images } = setup({ chats: [42, 43] });
    link.observe(
      ev('image.shared', {
        image: { id: 'img1', mime: 'image/jpeg', bytes: 3, caption: 'clave sk-secreto1' },
      }),
    );
    // Ya no está en el almacén: no se refleja nada (ni rompe).
    link.observe(ev('image.shared', { image: { id: 'gone', mime: 'image/png', bytes: 3 } }));
    expect(images).toEqual([
      { chatId: 42, name: 'image.jpg', mime: 'image/jpeg', caption: 'clave [redacted]' },
      { chatId: 43, name: 'image.jpg', mime: 'image/jpeg', caption: 'clave [redacted]' },
    ]);
  });

  it('un aviso de la sesión (p. ej., modelo sin visión) llega al chat; el de un subagente, no', () => {
    const { link, sent } = setup();
    link.observe(ev('warning', { message: 'no vision' }));
    link.observe(ev('warning', { message: 'del hijo' }, { subagentId: 'sub1' }));
    expect(sent).toEqual([{ chatId: 42, text: warningLine('no vision') }]);
  });
});

describe('CompanionLink: entrada (M18)', () => {
  it('sin turno, abre uno con el texto', async () => {
    const { turns, link } = setup();
    await link.input(42, message('  hola  '));
    expect(turns.started).toEqual(['hola']);
  });

  it('con turno, es steering', async () => {
    const { turns, link, sent } = setup();
    turns.running = true;
    await link.input(42, message('y además'));
    expect(turns.steered).toEqual(['y además']);
    expect(turns.started).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('too-large se contesta y no se recorta', async () => {
    const { turns, link, sent } = setup();
    turns.running = true;
    turns.steerStatus = 'too-large';
    await link.input(42, message('largo'));
    expect(sent).toEqual([{ chatId: 42, text: TEXT.tooLarge }]);
  });

  it('not-accepting: se junta y abre un turno al terminar el actual', async () => {
    const { turns, link } = setup();
    turns.running = true;
    turns.steerStatus = 'not-accepting';
    await link.input(42, message('uno'));
    await link.input(42, message('dos'));
    expect(turns.started).toEqual([]);
    turns.finish();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.started).toEqual(['uno\n\ndos']);
  });

  it('si otro abre turno entretanto (BUSY), pasa a steering', async () => {
    const { turns, link } = setup();
    turns.busyOnce = true;
    await link.input(42, message('hola'));
    expect(turns.steered).toEqual(['hola']);
  });

  it('sin companion: se dice en el chat y no se pasa nada', async () => {
    const { link, sent } = setup({
      open: async () => {
        throw new ProtocolError('UNAVAILABLE', 'no provider');
      },
    });
    await link.input(42, message('hola'));
    expect(sent[0]!.text).toContain('no provider');
  });

  it('fotos y ficheros sin texto: «aún no»', async () => {
    const { turns, link, sent } = setup();
    await link.input(42, message(undefined, true));
    expect(sent).toEqual([{ chatId: 42, text: TEXT.textOnly }]);
    expect(turns.started).toEqual([]);
  });
});

describe('CompanionLink: espejo (M18)', () => {
  it('lo escrito en Dot llega como «In Dot»; lo que vino de Telegram, no', () => {
    const { link, sent } = setup({ chats: [42, 9] });
    link.observe(ev('run.started', { run: run({ input: 'desde Dot' }) }));
    link.observe(ev('run.started', { run: run({ id: 'r2', input: 'desde tg', via: 'telegram' }) }));
    expect(sent).toEqual([
      { chatId: 42, text: fromDot('desde Dot') },
      { chatId: 9, text: fromDot('desde Dot') },
    ]);
    link.stop();
  });

  it('cada bloque del asistente, redactado; los de subagentes y otras sesiones, no', () => {
    const { link, sent, markdown } = setup();
    link.observe(ev('message.completed', { text: 'la clave es sk-secreto1' }));
    link.observe(ev('message.completed', { text: 'del hijo' }, { subagentId: 'sub1' }));
    link.observe({
      ...ev('message.completed', { text: 'de otra' }),
      sessionId: 'ses_otra',
    } as ProtocolEvent);
    link.observe(ev('message.completed', { text: '  ' }));
    // La respuesta del asistente va con formato (redactada); por `send`, nada.
    expect(markdown.map((s) => s.text)).toEqual(['la clave es [redacted]']);
    expect(sent).toEqual([]);
  });

  it('un turno que falla o se cancela se cuenta; uno que termina bien, no', () => {
    const { link, sent } = setup();
    link.observe(ev('run.completed', { run: run({ status: 'completed' }) }));
    link.observe(ev('run.failed', { run: run({ status: 'failed', error: 'sin red' }) }));
    link.observe(ev('run.cancelled', { run: run({ status: 'cancelled' }) }));
    expect(sent.map((s) => s.text)).toEqual([turnFailed('sin red'), TEXT.cancelled]);
  });

  it('«escribiendo…» mientras trabaja; no en pausa ni al terminar', async () => {
    const { link, typing } = setup();
    link.observe(ev('run.started', { run: run({ via: 'telegram' }) }));
    expect(typing).toEqual([42]);
    await new Promise((r) => setTimeout(r, 35));
    const working = typing.length;
    expect(working).toBeGreaterThan(1);
    link.observe(ev('run.updated', { run: run({ status: 'waiting_approval' }) }));
    await new Promise((r) => setTimeout(r, 35));
    const paused = typing.length;
    expect(paused).toBeLessThanOrEqual(working + 1);
    link.observe(ev('run.completed', { run: run({ status: 'completed' }) }));
    await new Promise((r) => setTimeout(r, 35));
    expect(typing.length).toBe(paused);
  });

  it('rutina terminada: nombre, estado y resumen', () => {
    const { link, sent } = setup();
    link.routineFinished('Resumen', 'completed', 'Tres correos.');
    expect(sent[0]!.text).toContain('Routine "Resumen" finished.');
    expect(sent[0]!.text).toContain('Tres correos.');
  });

  it('recordatorio: su texto, y la hora para la que era si llega tarde (M21)', () => {
    const { link, sent } = setup();
    const dueAt = new Date(2026, 10, 18, 9, 0).getTime();
    const reminder: ProtocolReminder = {
      id: 'rem_1',
      text: 'Llamar al médico',
      dueAt,
      createdAt: dueAt - 60_000,
      origin: 'agent',
      status: 'delivered',
      endedAt: dueAt,
    };
    link.reminderDue(reminder);
    link.reminderDue({ ...reminder, late: true });
    expect(sent.map((s) => s.text)).toEqual([
      '⏰ Recordatorio: Llamar al médico',
      '⏰ Recordatorio: Llamar al médico (llega tarde: era para 09:00)',
    ]);
  });

  it('vigilante: el texto compuesto por el daemon, tal cual (M22)', () => {
    const { link, sent } = setup();
    link.watchNotice({
      watchId: 'wat_1',
      name: 'Salón',
      kind: 'fired',
      text: '🔔 Vigilante «Salón»: el estado es «on». Ahora: «on».',
      at: 1_000,
    });
    expect(sent.map((s) => s.text)).toEqual([
      '🔔 Vigilante «Salón»: el estado es «on». Ahora: «on».',
    ]);
  });

  it('degradación: el texto compuesto por el daemon, tal cual (M23)', () => {
    const { link, sent } = setup();
    link.healthNotice({
      cause: 'connector:google:auth',
      kind: 'degraded',
      area: 'connectors',
      connector: 'google',
      text: '🔑 Google ha rechazado la autorización del asistente.',
      at: 1_000,
    });
    expect(sent.map((s) => s.text)).toEqual([
      '🔑 Google ha rechazado la autorización del asistente.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// M25 fase 3 — notas de voz
// ---------------------------------------------------------------------------

/** Una nota de voz de un chat privado, como la que arma `api.ts`. */
function voiceMessage(
  opts: { caption?: string; duration?: number; size?: number } = {},
): TelegramMessage {
  return {
    ...message(undefined, true),
    ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
    voice: {
      fileId: 'v1',
      duration: opts.duration ?? 4,
      size: opts.size ?? 1_000,
      mime: 'audio/ogg',
    },
  };
}

/** Lo que devuelve una transcripción buena: 4 s, un trozo, GPU. */
const VOICE_OK: VoiceNoteResult = {
  text: 'hola desde el chat',
  durationSec: 4,
  capped: false,
  device: 'gpu',
  ms: 1_200,
  decodeMs: 60,
  chunks: 1,
  skipped: 0,
};

/** Las notas de voz de mentira: contestan lo que el test diga, o lanzan. */
class FakeVoiceNotes implements VoiceNotesPort {
  readonly calls: { bytes: Uint8Array; hooks?: VoiceNoteHooks }[] = [];

  constructor(
    /** Lo que devuelve la nota. Una promesa pendiente deja la nota «en vuelo». */
    private readonly reply: VoiceNoteResult | Error | Promise<VoiceNoteResult> = VOICE_OK,
    private readonly notices: [VoiceModelPhase, VoiceModelHookInfo][] = [],
  ) {}

  async transcribe(
    getBytes: () => Promise<Uint8Array>,
    hooks?: VoiceNoteHooks,
  ): Promise<VoiceNoteResult> {
    // Como el de verdad: los bytes se piden cuando le toca a la nota.
    const bytes = await getBytes();
    this.calls.push({ bytes, ...(hooks ? { hooks } : {}) });
    for (const [phase, info] of this.notices) hooks?.onModelDownload?.(phase, info);
    const reply = await this.reply;
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

/** Una promesa que el test suelta a mano. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3]);

describe('CompanionLink: notas de voz (M25 fase 3)', () => {
  it('nota buena: primero el eco, luego el turno con la marca; y los metadatos a la traza', async () => {
    const notes = new FakeVoiceNotes();
    const { turns, link, sent, typing } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    // La nota va en su propia tarea: se espera a que llegue al turno.
    await vi.waitFor(() => expect(turns.started).toHaveLength(1));
    expect(sent).toEqual([{ chatId: 42, text: '🎙 «hola desde el chat»' }]);
    // Los bytes descargados son los de la nota, y llegan tal cual al transcriptor.
    expect(notes.calls).toHaveLength(1);
    expect(notes.calls[0]!.bytes).toEqual(OGG);
    // «Escribiendo…» en ese chat mientras transcribe.
    expect(typing).toContain(42);
    // A la traza, solo metadatos: ni el texto ni el audio.
    expect(turns.traced).toEqual([
      {
        durationSec: 4,
        device: 'gpu',
        ms: 1_200,
        decodeMs: 60,
        chunks: 1,
        skipped: 0,
        capped: false,
      },
    ]);
  });

  it('con pie de foto: el pie va debajo, separado por una línea en blanco', async () => {
    const { turns, link } = setup({
      voiceNotes: new FakeVoiceNotes(),
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage({ caption: ' para el informe ' }));
    await vi.waitFor(() =>
      expect(turns.started).toEqual(['[nota de voz, 0:04] hola desde el chat\n\npara el informe']),
    );
  });

  it('recortada: la marca lo dice y el eco también', async () => {
    const notes = new FakeVoiceNotes({ ...VOICE_OK, durationSec: 65, capped: true });
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(turns.started).toEqual(['[nota de voz, 1:05, recortada] hola desde el chat']),
    );
    expect(sent.map((s) => s.text)).toEqual(['🎙 «hola desde el chat» (cut off)']);
  });

  it('vacía: se dice y no se abre turno', async () => {
    const notes = new FakeVoiceNotes({ ...VOICE_OK, text: '   ' });
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(sent.map((s) => s.text)).toEqual([TEXT.voiceEmpty]));
    expect(turns.started).toEqual([]);
  });

  it('demasiado larga: se dice sin descargar ni transcribir', async () => {
    const notes = new FakeVoiceNotes();
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      // Sin bytes: si se intentara descargar, fallaría de otra forma.
      voiceFiles: new Map(),
    });
    await link.input(42, voiceMessage({ duration: 301 }));
    await link.input(42, voiceMessage({ size: 10 * 1024 * 1024 + 1 }));
    expect(sent.map((s) => s.text)).toEqual([TEXT.voiceTooLong, TEXT.voiceTooLong]);
    expect(notes.calls).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('un fallo de la transcripción: se dice y no se abre turno', async () => {
    const notes = new FakeVoiceNotes(
      Object.assign(new Error('boom'), { name: 'VoiceDecodeError' }),
    );
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(sent.map((s) => s.text)).toEqual([TEXT.voiceFailed('the audio could not be decoded')]),
    );
    expect(turns.started).toEqual([]);
  });

  it('cola llena y voz apagada tienen su propio aviso', async () => {
    const full = new FakeVoiceNotes(new VoiceQueueFullError('llena'));
    const off = new FakeVoiceNotes(
      Object.assign(new Error('apagada'), { name: 'VoiceNotesDisabledError' }),
    );
    const first = setup({ voiceNotes: full, voiceFiles: new Map([['v1', OGG]]) });
    await first.link.input(42, voiceMessage());
    await vi.waitFor(() => expect(first.sent.map((s) => s.text)).toEqual([TEXT.voiceQueueFull]));
    const second = setup({ voiceNotes: off, voiceFiles: new Map([['v1', OGG]]) });
    await second.link.input(42, voiceMessage());
    await vi.waitFor(() => expect(second.sent.map((s) => s.text)).toEqual([TEXT.voiceOff]));
    expect(first.turns.started).toEqual([]);
    expect(second.turns.started).toEqual([]);
  });

  it('una nota que no se puede descargar: se dice y no se transcribe', async () => {
    const notes = new FakeVoiceNotes();
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', new TelegramApiError('network', 'sin red')]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(sent.map((s) => s.text)).toEqual([
        TEXT.voiceFailed('it could not be downloaded from Telegram'),
      ]),
    );
    expect(notes.calls).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('la primera vez: los avisos de la descarga del modelo, en ese chat', async () => {
    const notes = new FakeVoiceNotes(VOICE_OK, [
      ['start', {}],
      ['progress', { percent: 25 }],
      ['progress', { percent: 50 }],
      ['done', {}],
    ]);
    const { link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(sent.map((s) => s.text)).toEqual([
        TEXT.voiceModelDownloading,
        TEXT.voiceModelProgress(25),
        TEXT.voiceModelProgress(50),
        TEXT.voiceModelReady,
        '🎙 «hola desde el chat»',
      ]),
    );
  });

  it('una descarga que falla se cuenta; la nota no entra', async () => {
    const notes = new FakeVoiceNotes(
      Object.assign(new Error('sin red'), { name: 'VoiceModelUnavailableError' }),
      [
        ['start', {}],
        ['failed', {}],
      ],
    );
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(sent.map((s) => s.text)).toEqual([
        TEXT.voiceModelDownloading,
        TEXT.voiceModelFailed,
        TEXT.voiceFailed('the speech model is not available'),
      ]),
    );
    expect(turns.started).toEqual([]);
  });

  it('con el turno en curso, es steering con la marca (y su eco)', async () => {
    const { turns, link, sent } = setup({
      voiceNotes: new FakeVoiceNotes(),
      voiceFiles: new Map([['v1', OGG]]),
    });
    turns.running = true;
    await link.input(42, voiceMessage());
    await vi.waitFor(() =>
      expect(turns.steered).toEqual(['[nota de voz, 0:04] hola desde el chat']),
    );
    expect(turns.started).toEqual([]);
    expect(sent.map((s) => s.text)).toEqual(['🎙 «hola desde el chat»']);
  });

  it('mientras una nota se transcribe, un texto del mismo chat se entrega igual', async () => {
    // La nota se queda en vuelo: el transcriptor no contesta todavía.
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(notes.calls).toHaveLength(1));
    // Un texto que llega detrás no espera a que la nota termine.
    await link.input(42, message('y esto por escrito'));
    await vi.waitFor(() => expect(turns.started).toContain('y esto por escrito'));
    // La nota sigue en el aire y no ha entregado nada suyo.
    expect(notes.calls).toHaveLength(1);
    expect(sent).toEqual([]);

    note.resolve(VOICE_OK);
    // El texto abrió turno, así que la nota llega como steering: el orden es el
    // que se aceptó (el texto después de la nota, aunque llegue antes).
    await vi.waitFor(() =>
      expect(turns.steered).toEqual(['[nota de voz, 0:04] hola desde el chat']),
    );
    expect(turns.started).toEqual(['y esto por escrito']);
    expect(sent.map((s) => s.text)).toEqual(['🎙 «hola desde el chat»']);
  });

  it('cerrada la voz (el daemon se apaga), no se contesta nada y el audio no entra', async () => {
    const closed = Object.assign(new Error('cerrado'), { name: 'VoiceNotesClosedError' });
    const { turns, link, sent } = setup({
      voiceNotes: new FakeVoiceNotes(closed),
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    // Ni un mensaje: el apagado no se cuenta en el chat.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('parado el canal con una nota en vuelo, no se contesta ni se entrega', async () => {
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(notes.calls).toHaveLength(1));
    link.stop();
    note.resolve(VOICE_OK);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('desemparejado el chat con la nota en vuelo, no se contesta ni se entrega', async () => {
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    const chats = [42];
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
      chats,
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(notes.calls).toHaveLength(1));
    chats.splice(0); // `unpair`
    note.resolve(VOICE_OK);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
    expect(turns.traced).toEqual([]);
  });

  it('desemparejado y vuelto a emparejar con la nota en vuelo: tampoco revive', async () => {
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    let key = 'u42:1';
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
      pairedKey: () => key,
    });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(notes.calls).toHaveLength(1));
    key = 'u42:2'; // `unpair` y otro `pair` del mismo chat
    note.resolve(VOICE_OK);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('una nota revocada mientras espera el punto seguro no abre turno', async () => {
    const safe = deferred<void>();
    const chats = [42];
    const { turns, link, sent } = setup({
      voiceNotes: new FakeVoiceNotes(VOICE_OK),
      voiceFiles: new Map([['v1', OGG]]),
      chats,
    });
    turns.waitAtSafePoint = () => safe.promise;
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(sent.map((s) => s.text)).toEqual(['🎙 «hola desde el chat»']));
    chats.splice(0);
    safe.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns.started).toEqual([]);
  });

  it('lo diferido conserva la vigencia de cada entrada: la nota revocada sale, el texto entra', async () => {
    let key = 'u42:1';
    const { turns, link, sent } = setup({
      voiceNotes: new FakeVoiceNotes(VOICE_OK),
      voiceFiles: new Map([['v1', OGG]]),
      pairedKey: () => key,
    });
    turns.running = true;
    turns.steerStatus = 'not-accepting';
    await link.input(42, message('texto escrito'));
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(sent.map((s) => s.text)).toContain('🎙 «hola desde el chat»'));
    // El turno acaba; la entrega de lo junto espera el punto seguro...
    const safe = deferred<void>();
    turns.waitAtSafePoint = () => safe.promise;
    turns.finish();
    await new Promise((r) => setTimeout(r, 5));
    // ...y mientras, el chat se desempareja y se vuelve a emparejar.
    key = 'u42:2';
    turns.waitAtSafePoint = async () => {};
    safe.resolve();
    await vi.waitFor(() => expect(turns.started).toEqual(['texto escrito']));
  });

  it('desemparejado antes de salir de la cola, ni siquiera se descarga', async () => {
    const chats = [42];
    let downloads = 0;
    const gate = deferred<void>();
    // Un transcriptor que hace esperar a la nota antes de pedir sus bytes.
    const notes: VoiceNotesPort = {
      transcribe: async (getBytes) => {
        await gate.promise;
        downloads++;
        await getBytes();
        return VOICE_OK;
      },
    };
    const { turns, link, sent } = setup({
      voiceNotes: notes,
      voiceFiles: new Map([['v1', OGG]]),
      chats,
    });
    await link.input(42, voiceMessage());
    chats.splice(0);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downloads).toBe(1); // se pidió, pero `getBytes` se negó antes de bajar
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('recargado el canal (`resetVoice`) con la nota en vuelo, se abandona', async () => {
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    const { turns, link, sent } = setup({ voiceNotes: notes, voiceFiles: new Map([['v1', OGG]]) });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(notes.calls).toHaveLength(1));
    link.resetVoice();
    note.resolve(VOICE_OK);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(turns.started).toEqual([]);
  });

  it('`stop` corta el «escribiendo…» de una nota en vuelo en el momento', async () => {
    const note = deferred<VoiceNoteResult>();
    const notes = new FakeVoiceNotes(note.promise);
    const { link, typing } = setup({ voiceNotes: notes, voiceFiles: new Map([['v1', OGG]]) });
    await link.input(42, voiceMessage());
    await vi.waitFor(() => expect(typing.length).toBeGreaterThan(1));
    link.stop();
    const seen = typing.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(typing.length).toBe(seen);
    note.resolve(VOICE_OK);
  });

  it('`stop` durante la espera del punto seguro: el turno ya no se abre', async () => {
    const safe = deferred<void>();
    const { turns, link } = setup();
    turns.waitAtSafePoint = () => safe.promise;
    const delivering = link.input(42, message('hola'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    link.stop();
    safe.resolve();
    await delivering;
    expect(turns.started).toEqual([]);
  });

  it('sin notas de voz montadas, se contesta como cualquier adjunto', async () => {
    const { turns, link, sent } = setup();
    await link.input(42, voiceMessage());
    expect(sent).toEqual([{ chatId: 42, text: TEXT.textOnly }]);
    expect(turns.started).toEqual([]);
  });
});

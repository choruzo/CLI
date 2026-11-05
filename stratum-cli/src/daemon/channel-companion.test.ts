import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import type { ProtocolEvent, ProtocolRun, SteerStatus } from '../protocol/index.js';
import type { UserImage } from '../agent/user-images.js';
import { TelegramApiError, type TelegramMessage } from '../channels/telegram/api.js';
import {
  TEXT,
  fromDot,
  imageRejected,
  turnFailed,
  warningLine,
} from '../channels/telegram/render.js';
import { CompanionLink, type CompanionTurns } from './channel-companion.js';

/** Una sesión del companion de mentira: registra lo que se le pide. */
class FakeTurns implements CompanionTurns {
  readonly sessionId = 'ses_companion';
  running = false;
  started: string[] = [];
  steered: string[] = [];
  /** Las imágenes de cada `startRun`/`steer`, en orden. */
  images: (readonly UserImage[])[] = [];
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
  } = {},
) {
  const turns = new FakeTurns();
  const sent: { chatId: number; text: string }[] = [];
  const markdown: { chatId: number; text: string }[] = [];
  const typing: number[] = [];
  const link = new CompanionLink({
    companion: { open: opts.open ?? (async () => turns), currentId: () => turns.sessionId },
    download: async (image, maxBytes) => {
      const file = opts.files?.get(image.fileId);
      if (!file) throw new TelegramApiError('api', 'not found');
      if (file instanceof Error) throw file;
      if (file.length > maxBytes) throw new TelegramApiError('too-large', 'too large');
      return file;
    },
    target: () => ({
      send: (chatId, text) => sent.push({ chatId, text }),
      sendMarkdown: (chatId, text) => markdown.push({ chatId, text }),
      typing: (chatId) => typing.push(chatId),
    }),
    chats: () => opts.chats ?? [42],
    redact: (text) => text.replaceAll('sk-secreto1', '[redacted]'),
    typingIntervalMs: 10,
  });
  return { turns, sent, markdown, typing, link };
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
});

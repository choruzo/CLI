import { describe, expect, it } from 'vitest';
import { HttpTelegramApi, TelegramApiError, isTelegramToken, parseUpdate } from './api.js';

const TOKEN = '123456789:AA' + 'x'.repeat(33);

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(answer: (call: Call) => { status?: number; json: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function api(answer: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(answer);
  return { api: new HttpTelegramApi({ token: TOKEN, fetch: f.impl }), calls: f.calls };
}

async function caught(p: Promise<unknown>): Promise<TelegramApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TelegramApiError);
    return err as TelegramApiError;
  }
  throw new Error('no lanzó');
}

describe('isTelegramToken', () => {
  it('acepta la forma de BotFather y nada más', () => {
    expect(isTelegramToken(TOKEN)).toBe(true);
    expect(isTelegramToken('123:abc')).toBe(false);
    expect(isTelegramToken(`${TOKEN}x`)).toBe(false);
    expect(isTelegramToken(` ${TOKEN}`)).toBe(false);
  });

  it('no construye un cliente con algo que no es un token', () => {
    expect(() => new HttpTelegramApi({ token: 'nope' })).toThrow(TelegramApiError);
  });
});

describe('HttpTelegramApi', () => {
  it('getMe llama a api.telegram.org con POST y convierte el usuario', async () => {
    const { api: a, calls } = api(() => ({
      json: { ok: true, result: { id: 42, is_bot: true, first_name: 'Dot', username: 'dot_bot' } },
    }));
    expect(await a.getMe()).toEqual({ id: 42, isBot: true, firstName: 'Dot', username: 'dot_bot' });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('un 401 es unauthorized y el mensaje no lleva el token', async () => {
    const { api: a } = api(() => ({
      status: 401,
      json: { ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` },
    }));
    const err = await caught(a.getMe());
    expect(err.kind).toBe('unauthorized');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('<token>');
  });

  it('un fallo de red no lleva el token', async () => {
    const { api: a } = api(
      () => new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}`),
    );
    const err = await caught(a.getMe());
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain(TOKEN);
  });

  it('un 429 trae retry_after y un 409 es conflict', async () => {
    const limited = api(() => ({
      status: 429,
      json: { ok: false, error_code: 429, description: 'Too Many', parameters: { retry_after: 7 } },
    }));
    const e1 = await caught(limited.api.sendMessage(1, 'hola'));
    expect(e1.kind).toBe('rate-limited');
    expect(e1.retryAfterSec).toBe(7);

    const conflict = api(() => ({
      status: 409,
      json: { ok: false, error_code: 409, description: 'Conflict' },
    }));
    expect((await caught(conflict.api.getUpdates({ timeoutSec: 0 }))).kind).toBe('conflict');
  });

  it('una respuesta sin JSON o con otra forma es bad-response', async () => {
    const f = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
    const a = new HttpTelegramApi({ token: TOKEN, fetch: f });
    expect((await caught(a.getMe())).kind).toBe('bad-response');
    const odd = api(() => ({ json: { ok: true, result: { nope: 1 } } }));
    expect((await caught(odd.api.getMe())).kind).toBe('bad-response');
  });

  it('getUpdates pide solo mensajes y botones, y salta lo que no entiende sin perder su id', async () => {
    const { api: a, calls } = api(() => ({
      json: {
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              message_id: 1,
              date: 1700000000,
              chat: { id: 5, type: 'private' },
              from: { id: 5, is_bot: false, first_name: 'Ana' },
              text: 'hola',
            },
          },
          { update_id: 11, message: { broken: true } },
          {
            update_id: 12,
            callback_query: {
              id: 'cb1',
              from: { id: 5, is_bot: false, first_name: 'Ana' },
              data: 'x1',
              message: { message_id: 3, chat: { id: 5 } },
            },
          },
        ],
      },
    }));
    const updates = await a.getUpdates({ offset: 10, timeoutSec: 30 });
    expect(calls[0]!.body).toMatchObject({
      offset: 10,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(updates.map((u) => u.updateId)).toEqual([10, 11, 12]);
    expect(updates[0]!.message).toMatchObject({ text: 'hola', hasMedia: false });
    expect(updates[1]!.message).toBeUndefined();
    expect(updates[2]!.callbackQuery).toEqual({
      id: 'cb1',
      from: { id: 5, isBot: false, firstName: 'Ana' },
      data: 'x1',
      message: { messageId: 3, chatId: 5 },
    });
  });

  it('sendMessage va en texto plano y con botones; editar sin botones los quita', async () => {
    const { api: a, calls } = api(() => ({ json: { ok: true, result: { message_id: 9 } } }));
    expect(
      await a.sendMessage(5, '*no* es formato', {
        keyboard: [[{ text: 'Aprobar', callbackData: 'a1' }]],
      }),
    ).toEqual({ messageId: 9 });
    expect(calls[0]!.body).not.toHaveProperty('parse_mode');
    expect(calls[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Aprobar', callback_data: 'a1' }]],
    });
    await a.editMessageText(5, 9, 'Aprobada en Dot');
    expect(calls[1]!.body.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe('parseUpdate', () => {
  it('marca lo que no es texto', () => {
    const u = parseUpdate({
      update_id: 1,
      message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, photo: [{}] },
    });
    expect(u?.message?.hasMedia).toBe(true);
    expect(u?.message?.text).toBeUndefined();
    expect(u?.message?.image).toBeUndefined();
  });

  it('6E: la foto más grande que cabe en 5 MB, el pie de foto y un fichero image/*', () => {
    const chat = { id: 1, type: 'private' };
    const u = parseUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat,
        caption: 'mira',
        photo: [
          { file_id: 'small', file_size: 1_000 },
          { file_id: 'mid', file_size: 900_000 },
          { file_id: 'huge', file_size: 9_000_000 },
        ],
      },
    });
    expect(u?.message).toMatchObject({ caption: 'mira', image: { fileId: 'mid', size: 900_000 } });
    const doc = (mime: string) =>
      parseUpdate({
        update_id: 2,
        message: { message_id: 2, date: 1, chat, document: { file_id: 'd', mime_type: mime } },
      })?.message?.image;
    expect(doc('image/png')).toEqual({ fileId: 'd' });
    expect(doc('application/pdf')).toBeUndefined();
  });
});

describe('downloadFile (6E)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function files(
    file: { path?: string; size?: number },
    body: Uint8Array | Error,
    headers: Record<string, string> = {},
  ) {
    const urls: string[] = [];
    const impl = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes('/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: 'x',
              ...(file.path ? { file_path: file.path } : {}),
              ...(file.size !== undefined ? { file_size: file.size } : {}),
            },
          }),
        );
      }
      if (body instanceof Error) throw body;
      return new Response(new Blob([new Uint8Array(body)]), { headers });
    }) as typeof fetch;
    return { api: new HttpTelegramApi({ token: TOKEN, fetch: impl }), urls };
  }

  it('getFile y luego la URL de ficheros, bajo api.telegram.org', async () => {
    const { api, urls } = files({ path: 'photos/file_1.png' }, PNG);
    expect(await api.downloadFile('x', 1_000)).toEqual(PNG);
    expect(urls[1]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.png`);
  });

  it('pasa del límite: too-large, por el tamaño declarado o al leer', async () => {
    expect((await caught(files({ path: 'a', size: 50 }, PNG).api.downloadFile('x', 10))).kind).toBe(
      'too-large',
    );
    expect((await caught(files({ path: 'a' }, PNG).api.downloadFile('x', 10))).kind).toBe(
      'too-large',
    );
  });

  it('sin ruta es bad-response; un fallo de red no lleva el token', async () => {
    expect((await caught(files({}, PNG).api.downloadFile('x', 10))).kind).toBe('bad-response');
    const err = await caught(
      files({ path: 'a' }, new Error(`boom bot${TOKEN}`)).api.downloadFile('x', 1_000),
    );
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain(TOKEN);
  });
});

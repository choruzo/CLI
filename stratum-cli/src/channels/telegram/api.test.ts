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
  });
});

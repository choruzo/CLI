import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramApiError, type TelegramMessage } from './api.js';
import { TelegramChannel, type TelegramChannelDeps } from './channel.js';
import { TEXT } from './render.js';
import type { TelegramPaired } from './store.js';
import { FakeTelegramApi } from './api.fixtures.js';

const ana: TelegramPaired = {
  userId: 42,
  chatId: 42,
  name: 'Ana',
  pairedAt: '2026-11-04T10:00:00.000Z',
};

let channels: TelegramChannel[] = [];

afterEach(async () => {
  await Promise.all(channels.map((c) => c.stop()));
  channels = [];
});

function setup(overrides: Partial<TelegramChannelDeps> = {}) {
  const api = new FakeTelegramApi();
  const paired = new Map<number, TelegramPaired>([[ana.userId, ana]]);
  const texts: { from: TelegramPaired; message: TelegramMessage }[] = [];
  const offers: { code: string; userId: number }[] = [];
  const deps: TelegramChannelDeps = {
    api,
    now: Date.now,
    pairedUser: (id) => paired.get(id) ?? null,
    offerCode: (code, who) => {
      offers.push({ code, userId: who.userId });
      return code === 'GOODCODE23' ? 'candidate' : 'rejected';
    },
    unpair: async (id) => paired.delete(id),
    onText: (from, message) => {
      texts.push({ from, message });
    },
    retry: { initialMs: 5, maxMs: 20 },
    ...overrides,
  };
  const channel = new TelegramChannel(deps);
  channels.push(channel);
  channel.start();
  return { api, channel, paired, texts, offers };
}

describe('TelegramChannel (M18)', () => {
  it('pasa el texto de un emparejado y confirma el offset', async () => {
    const { api, texts } = setup();
    api.push(api.text({ id: 42 }, 'hola'));
    await api.drained();
    expect(texts.map((t) => t.message.text)).toEqual(['hola']);
    expect(texts[0]!.from.userId).toBe(42);
    expect(api.polls.at(-1)).toEqual({ offset: 2 });
  });

  it('a un desconocido no le contesta nada, ni le pasa el texto', async () => {
    const { api, texts } = setup();
    api.push(api.text({ id: 9 }, 'hola'), api.text({ id: 9 }, '/start'));
    await api.drained();
    expect(texts).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  it('ignora grupos, bots y mensajes cuyo chat no es el del remitente', async () => {
    const { api, texts } = setup();
    const base = api.text({ id: 42 }, 'hola').message!;
    api.push(
      api.update({ message: { ...base, chat: { id: -100, type: 'group' } } }),
      api.update({ message: { ...base, from: { ...base.from!, isBot: true } } }),
      api.update({ message: { ...base, chat: { id: 43, type: 'private' } } }),
    );
    await api.drained();
    expect(texts).toEqual([]);
  });

  it('/start <código> bueno de un desconocido: candidato y «confírmalo en Dot»', async () => {
    const { api, offers } = setup();
    api.push(api.text({ id: 9, firstName: 'Bea', username: 'bea' }, '/start GOODCODE23'));
    const sent = await api.waitSent(1);
    expect(offers).toEqual([{ code: 'GOODCODE23', userId: 9 }]);
    expect(sent[0]).toEqual({ chatId: 9, text: TEXT.candidate });
  });

  it('un código falso no da pistas', async () => {
    const { api, offers } = setup();
    api.push(api.text({ id: 9 }, '/start WRONGCODE2'));
    await api.drained();
    expect(offers).toHaveLength(1);
    expect(api.sent).toEqual([]);
  });

  it('/unpair desempareja, también si llegó con el daemon apagado', async () => {
    const { api, paired, texts } = setup();
    api.push(api.text({ id: 42 }, '/unpair', 1));
    const sent = await api.waitSent(1);
    expect(paired.has(42)).toBe(false);
    expect(sent[0]).toEqual({ chatId: 42, text: TEXT.unpaired });
    expect(texts).toEqual([]);
  });

  it('lo fechado antes de arrancar no se pasa: se avisa', async () => {
    const { api, texts } = setup();
    api.push(api.text({ id: 42 }, 'de ayer', Math.floor(Date.now() / 1000) - 3600));
    const sent = await api.waitSent(1);
    expect(texts).toEqual([]);
    expect(sent[0]).toEqual({ chatId: 42, text: TEXT.stale });
  });

  it('un fallo de red se reintenta y queda en lastError hasta el siguiente sondeo bueno', async () => {
    const { api, channel, texts } = setup();
    api.fail(new TelegramApiError('network', 'Telegram getUpdates: ECONNRESET'));
    await vi.waitFor(() => expect(channel.lastError?.kind).toBe('network'));
    expect(channel.state).toBe('running');
    api.push(api.text({ id: 42 }, 'sigo aquí'));
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(channel.lastError).toBeNull();
    expect(channel.lastPollAt).not.toBeNull();
  });

  it('un 429 espera lo que dice Telegram', async () => {
    const { api, channel } = setup();
    api.fail(new TelegramApiError('rate-limited', 'Too Many Requests', 429, 1));
    await vi.waitFor(() => expect(channel.lastError?.kind).toBe('rate-limited'));
    const polls = api.polls.length;
    await new Promise((r) => setTimeout(r, 300));
    // Con `retry` de 5 ms habría vuelto ya; con `retry_after: 1` sigue esperando.
    expect(api.polls.length).toBe(polls);
  });

  it('un token rechazado para el sondeo: unauthorized', async () => {
    const { api, channel } = setup();
    api.fail(new TelegramApiError('unauthorized', 'Telegram getUpdates: Unauthorized', 401));
    await vi.waitFor(() => expect(channel.state).toBe('unauthorized'));
    const polls = api.polls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(api.polls.length).toBe(polls);
  });

  it('un update que rompe no atasca los siguientes', async () => {
    let n = 0;
    const { api, texts } = setup({
      onText: (_from, message) => {
        if (n++ === 0) throw new Error('boom');
        texts.push({ from: ana, message });
      },
    });
    api.push(api.text({ id: 42 }, 'uno'), api.text({ id: 42 }, 'dos'));
    await api.drained();
    expect(texts.map((t) => t.message.text)).toEqual(['dos']);
  });

  it('stop aborta el sondeo en curso', async () => {
    const { api, channel } = setup();
    await api.drained();
    await channel.stop();
    expect(channel.state).toBe('stopped');
  });
});

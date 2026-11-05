import { describe, expect, it } from 'vitest';
import { TelegramApiError } from './api.js';
import { FakeTelegramApi } from './api.fixtures.js';
import { TelegramOutbox } from './outbox.js';
import { chunkText } from './render.js';

describe('chunkText (M18)', () => {
  it('lo corto va entero; lo largo, en trozos que caben, por párrafos', () => {
    expect(chunkText('hola')).toEqual(['hola']);
    expect(chunkText('   ')).toEqual([]);
    const para = 'a'.repeat(30);
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const chunks = chunkText(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('sin espacios corta a la medida, sin partir un emoji', () => {
    const text = 'x'.repeat(9) + '😀' + 'y'.repeat(20);
    const chunks = chunkText(text, 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(c).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe('TelegramOutbox (M18)', () => {
  it('6E: una imagen va como foto con su pie; si no la acepta como foto, una vez como fichero', async () => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox({ api, minIntervalMs: 0 });
    const file = { data: new Uint8Array([1, 2]), mime: 'image/webp', name: 'image.webp' };
    outbox.send(1, { text: 'mira', photo: file });
    api.rejectPhotos = 1;
    outbox.send(1, { text: '', photo: file });
    await outbox.flush();
    expect(api.filesSent.map((f) => [f.as, f.caption])).toEqual([
      ['photo', 'mira'],
      ['document', ''],
    ]);
    expect(api.sent).toEqual([]);
  });

  it('espacia los mensajes de un chat y respeta el orden', async () => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox({ api, minIntervalMs: 60 });
    const started = Date.now();
    outbox.send(1, { text: 'uno' });
    outbox.send(1, { text: 'dos' });
    outbox.send(1, { text: 'tres' });
    await outbox.flush();
    expect(api.sent.map((m) => m.text)).toEqual(['uno', 'dos', 'tres']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('un 429 espera y reintenta el mismo; otro fallo lo descarta y sigue', async () => {
    const api = new FakeTelegramApi();
    const failures = [
      new TelegramApiError('rate-limited', 'Too Many Requests', 429, 0),
      new TelegramApiError('api', 'Bad Request', 400),
    ];
    const send = api.sendMessage.bind(api);
    api.sendMessage = async (chatId, text, opts) => {
      const err = failures.shift();
      if (err) throw err;
      return send(chatId, text, opts);
    };
    const waits: number[] = [];
    const outbox = new TelegramOutbox({
      api,
      minIntervalMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    outbox.send(1, { text: 'uno' });
    outbox.send(1, { text: 'dos' });
    outbox.send(1, { text: 'tres' });
    await outbox.flush();
    // «uno»: 429 y luego 400 → descartado. «dos» y «tres» salen.
    expect(api.sent.map((m) => m.text)).toEqual(['dos', 'tres']);
    expect(waits).toContain(1000);
  });

  it('un formato rechazado (api) se reenvía una vez en plano; 429 con formato sigue con formato; red no reenvía', async () => {
    const api = new FakeTelegramApi();
    api.rejectFormatting(1);
    const outbox = new TelegramOutbox({ api, minIntervalMs: 0, sleep: async () => {} });
    outbox.send(1, { text: '<b>hola</b>', parseMode: 'HTML', plain: '**hola**' });
    await outbox.flush();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ text: '**hola**' });
    expect(api.sent[0]!.parseMode).toBeUndefined();

    // 429 con formato: reintenta con el mismo formato.
    const failures = [new TelegramApiError('rate-limited', 'Too Many Requests', 429, 0)];
    const send = api.sendMessage.bind(api);
    api.sendMessage = async (chatId, text, opts) => {
      const err = failures.shift();
      if (err) throw err;
      return send(chatId, text, opts);
    };
    outbox.send(1, { text: '<i>x</i>', parseMode: 'HTML', plain: '*x*' });
    await outbox.flush();
    expect(api.sent[1]).toMatchObject({ text: '<i>x</i>', parseMode: 'HTML' });

    // Un error de red no se reenvía.
    let calls = 0;
    api.sendMessage = async () => {
      calls++;
      throw new TelegramApiError('network', 'down');
    };
    outbox.send(1, { text: '<b>y</b>', parseMode: 'HTML', plain: 'y' });
    await outbox.flush();
    expect(calls).toBe(1);
    expect(api.sent).toHaveLength(2);
  });

  it('con la cola llena se descartan los más antiguos; stop descarta lo pendiente', async () => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox({ api, minIntervalMs: 0, maxQueue: 2 });
    for (const text of ['a', 'b', 'c', 'd']) outbox.send(1, { text });
    await outbox.flush();
    // «a» ya había salido del cola al empezar; de b, c, d caben los dos últimos.
    expect(api.sent.map((m) => m.text)).toEqual(['a', 'c', 'd']);
    outbox.stop();
    outbox.send(1, { text: 'e' });
    await outbox.flush();
    expect(api.sent).toHaveLength(3);
  });
});

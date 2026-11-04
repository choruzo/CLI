/**
 * M18 — el canal de Telegram en el daemon y `channels.*` por el protocolo
 * (`docs/protocol.md` §24): estado sin token, emparejar en dos pasos (código →
 * candidato → `pairConfirm` con `approve`), desemparejar, recargar, y que un
 * canal con alguien emparejado no deja que el daemon se apague solo.
 */
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEXT } from '../channels/telegram/render.js';
import {
  TELEGRAM_SCHEMA_VERSION,
  readTelegramFile,
  writeTelegramFile,
  type TelegramPaired,
} from '../channels/telegram/store.js';
import { FakeTelegramApi } from '../channels/telegram/api.fixtures.js';
import type { StratumdOptions } from './daemon.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;

let running: TestDaemon | null = null;
let base: string | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  if (base) rmSync(base, { recursive: true, force: true });
  base = null;
});

async function start(
  opts: {
    paired?: TelegramPaired[];
    enabled?: { value: boolean };
    file?: boolean;
  } & Partial<StratumdOptions> = {},
): Promise<{ t: TestDaemon; api: FakeTelegramApi; dir: string }> {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-channels-')));
  const dir = join(base, 'daemon');
  if (opts.file !== false) {
    writeTelegramFile(dir, {
      schemaVersion: TELEGRAM_SCHEMA_VERSION,
      token: TOKEN,
      bot: { id: 777, username: 'test_bot' },
      paired: opts.paired ?? [],
      updatedAt: new Date().toISOString(),
    });
  }
  const api = new FakeTelegramApi();
  const enabled = opts.enabled ?? { value: true };
  const { paired: _p, enabled: _e, file: _f, ...rest } = opts;
  running = await startTestDaemon({
    base,
    dir,
    channels: { enabled: () => enabled.value, api: () => api, retry: { initialMs: 5, maxMs: 20 } },
    ...rest,
  });
  return { t: running, api, dir };
}

describe('channels.* (M18)', () => {
  it('channels.status: el bot y su estado, nunca el token', async () => {
    const { t } = await start();
    const observer = await t.connect(['observer']);
    const status = await observer.request('channels.status', {});
    expect(status.telegram).toMatchObject({
      state: 'running',
      bot: { id: 777, username: 'test_bot' },
      paired: [],
      pairing: null,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN.split(':')[1]);
  });

  it('emparejar: código → candidato → pairConfirm, que exige approve', async () => {
    const { t, api, dir } = await start();
    const operator = await t.connect(['operator']);
    const begin = await operator.request('channels.pairBegin', {});
    expect(begin.link).toBe(`https://t.me/test_bot?start=${begin.code}`);
    // El código no sale por `status`.
    expect(JSON.stringify(await operator.request('channels.status', {}))).not.toContain(begin.code);

    api.push(api.text({ id: 9, firstName: 'Bea', username: 'bea' }, `/start ${begin.code}`));
    await api.waitSent(1);
    expect(api.sent[0]).toEqual({ chatId: 9, text: TEXT.candidate });
    const { telegram } = await operator.request('channels.status', {});
    expect(telegram.pairing?.candidate).toEqual({ userId: 9, name: 'Bea', username: 'bea' });
    // Aún no habla con nadie.
    expect(telegram.paired).toEqual([]);

    // Con `control` no se empareja: da autoridad.
    await expect(operator.request('channels.pairConfirm', { userId: 9 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const approver = await t.connect(['approver']);
    await expect(approver.request('channels.pairConfirm', { userId: 8 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const { paired } = await approver.request('channels.pairConfirm', { userId: 9 });
    expect(paired).toMatchObject({ userId: 9, name: 'Bea', username: 'bea' });
    await api.waitSent(2);
    expect(api.sent[1]).toEqual({ chatId: 9, text: TEXT.paired });

    // En disco, y el candidato gastado.
    const file = readTelegramFile(dir);
    expect(file.state === 'ok' && file.file.paired.map((p) => p.userId)).toEqual([9]);
    expect(file.state === 'ok' && file.file.token).toBe(TOKEN);
    await expect(approver.request('channels.pairConfirm', { userId: 9 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await operator.request('channels.status', {})).telegram.pairing).toBeNull();
  });

  it('un emparejado habla; /unpair desde el chat y channels.unpair lo quitan', async () => {
    const bea: TelegramPaired = {
      userId: 9,
      chatId: 9,
      name: 'Bea',
      pairedAt: new Date().toISOString(),
    };
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const { t, api, dir } = await start({ paired: [bea, ana] });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.unpair', { userId: 9 })).removed).toBe(true);
    expect((await operator.request('channels.unpair', { userId: 9 })).removed).toBe(false);

    api.push(api.text({ id: 42 }, '/unpair'));
    await api.waitSent(1);
    expect(api.sent[0]).toEqual({ chatId: 42, text: TEXT.unpaired });
    const file = readTelegramFile(dir);
    expect(file.state === 'ok' && file.file.paired).toEqual([]);
    expect((await operator.request('channels.status', {})).telegram.paired).toEqual([]);
  });

  it('apagado en la config: disabled, sin emparejar; reload lo enciende', async () => {
    const enabled = { value: false };
    const { t } = await start({ enabled });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.status', {})).telegram.state).toBe('disabled');
    await expect(operator.request('channels.pairBegin', {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      data: { reason: 'channel-off' },
    });
    enabled.value = true;
    expect((await operator.request('channels.reload', {})).telegram.state).toBe('running');
  });

  it('sin telegram.json: not-configured; uno que no valida: invalid (apagado)', async () => {
    const { t, dir } = await start({ file: false });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.status', {})).telegram.state).toBe('not-configured');
    const { writeFileSync } = await import('fs');
    writeFileSync(join(dir, 'telegram.json'), '{"schemaVersion":1,"token":"nope"}');
    expect((await operator.request('channels.reload', {})).telegram).toMatchObject({
      state: 'invalid',
      bot: null,
    });
  });

  it('el daemon sin canales: UNAVAILABLE channels-disabled', async () => {
    const { t } = await start({ channels: null });
    const observer = await t.connect(['observer']);
    await expect(observer.request('channels.status', {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      data: { reason: 'channels-disabled' },
    });
  });

  it('con alguien emparejado el daemon no se apaga por inactividad; sin nadie, sí', async () => {
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const kept = await start({ paired: [ana], idleExitMs: 200 });
    let closed = false;
    void kept.t.daemon.closed.then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 700));
    expect(closed).toBe(false);
    await running!.stop();
    running = null;
    rmSync(base!, { recursive: true, force: true });
    base = null;

    const idle = await start({ idleExitMs: 200 });
    await vi.waitFor(() => expect(idle.t.daemon.closed).resolves.toBe('idle'), { timeout: 3_000 });
  });
});

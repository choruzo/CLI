import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_SCHEMA_VERSION,
  TelegramFileNewerError,
  publicTelegramState,
  readTelegramFile,
  saveTelegramBot,
  telegramFilePath,
  writeTelegramFile,
  type TelegramFile,
} from './store.js';

const TOKEN = '123456789:AA' + 'x'.repeat(33);
const OTHER = '987654321:BB' + 'y'.repeat(33);

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'stratum-tg-')), 'daemon');
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

function file(paired: TelegramFile['paired'] = []): TelegramFile {
  return {
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    token: TOKEN,
    bot: { id: 123456789, username: 'dot_bot' },
    paired,
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
}

const ana = { userId: 5, chatId: 5, name: 'Ana', pairedAt: '2026-11-04T00:00:00.000Z' };

describe('telegram.json', () => {
  it('sin fichero es absent', () => {
    expect(readTelegramFile(dir)).toEqual({ state: 'absent' });
  });

  it('escribe en la carpeta privada y lo lee igual', () => {
    writeTelegramFile(dir, file([ana]));
    expect(readTelegramFile(dir)).toEqual({ state: 'ok', file: file([ana]) });
  });

  it('un fichero roto o con otra forma es invalid (el canal queda apagado)', () => {
    writeTelegramFile(dir, file());
    writeFileSync(telegramFilePath(dir), '{nope');
    expect(readTelegramFile(dir)).toEqual({ state: 'invalid' });
    writeFileSync(telegramFilePath(dir), JSON.stringify({ ...file(), token: 'nope' }));
    expect(readTelegramFile(dir)).toEqual({ state: 'invalid' });
    writeFileSync(telegramFilePath(dir), JSON.stringify({ ...file(), extra: 1 }));
    expect(readTelegramFile(dir)).toEqual({ state: 'invalid' });
  });

  it('uno de un Stratum más nuevo no se lee ni se toca', () => {
    writeTelegramFile(dir, file());
    const newer = JSON.stringify({ schemaVersion: TELEGRAM_SCHEMA_VERSION + 1, whatever: true });
    writeFileSync(telegramFilePath(dir), newer);
    expect(readTelegramFile(dir)).toEqual({
      state: 'newer',
      schemaVersion: TELEGRAM_SCHEMA_VERSION + 1,
    });
    expect(() => saveTelegramBot(dir, TOKEN, { id: 1, username: 'x' })).toThrow(
      TelegramFileNewerError,
    );
    expect(readFileSync(telegramFilePath(dir), 'utf8')).toBe(newer);
  });

  it('no escribe algo que no valida', () => {
    expect(() => writeTelegramFile(dir, { ...file(), token: 'nope' })).toThrow();
    expect(readTelegramFile(dir)).toEqual({ state: 'absent' });
  });

  it('el estado público no lleva el token', () => {
    const pub = publicTelegramState(file([ana]));
    expect(JSON.stringify(pub)).not.toContain(TOKEN);
    expect(pub.paired).toEqual([ana]);
  });
});

describe('saveTelegramBot', () => {
  it('con el mismo bot conserva los emparejados', () => {
    writeTelegramFile(dir, file([ana]));
    const r = saveTelegramBot(dir, TOKEN, { id: 123456789, username: 'dot_bot' });
    expect(r).toMatchObject({ keptPaired: 1, droppedPaired: 0 });
    const s = readTelegramFile(dir);
    expect(s.state === 'ok' && s.file.paired).toEqual([ana]);
  });

  it('con otro bot los descarta: la autoridad se dio para el anterior', () => {
    writeTelegramFile(dir, file([ana]));
    const r = saveTelegramBot(dir, OTHER, { id: 987654321, username: 'otro_bot' });
    expect(r).toMatchObject({ keptPaired: 0, droppedPaired: 1 });
    const s = readTelegramFile(dir);
    expect(s.state === 'ok' && s.file).toMatchObject({
      token: OTHER,
      bot: { id: 987654321, username: 'otro_bot' },
      paired: [],
    });
  });

  it('sustituye un fichero inválido', () => {
    writeTelegramFile(dir, file());
    writeFileSync(telegramFilePath(dir), 'roto');
    saveTelegramBot(dir, TOKEN, { id: 123456789, username: 'dot_bot' });
    expect(readTelegramFile(dir).state).toBe('ok');
  });
});

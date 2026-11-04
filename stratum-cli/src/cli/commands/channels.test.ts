import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramApiError, type TelegramApi } from '../../channels/telegram/api.js';
import {
  readTelegramFile,
  TELEGRAM_SCHEMA_VERSION,
  writeTelegramFile,
} from '../../channels/telegram/store.js';
import {
  channelsCommand,
  formatTelegramStatus,
  runTelegramSetup,
  type SetupDeps,
} from './channels.js';

const TOKEN = '123456789:AA' + 'x'.repeat(33);

let root: string;
let out: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stratum-tg-cli-'));
  out = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeApi(getMe: TelegramApi['getMe']): TelegramApi {
  const never = () => Promise.reject(new Error('no se usa'));
  return {
    getMe,
    getUpdates: never,
    sendMessage: never,
    editMessageText: never,
    answerCallbackQuery: never,
    sendChatAction: never,
  };
}

function deps(over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    dir: join(root, 'daemon'),
    globalPath: join(root, '.stratumrc.json'),
    ask: async () => TOKEN,
    api: () =>
      fakeApi(async () => ({ id: 123456789, isBot: true, firstName: 'Dot', username: 'dot_bot' })),
    out: (t) => out.push(t),
    isTTY: true,
    ...over,
  };
}

function globalConfig(d: SetupDeps): Record<string, unknown> {
  return JSON.parse(readFileSync(d.globalPath, 'utf8'));
}

describe('runTelegramSetup', () => {
  it('guarda el token en la carpeta privada y enciende el canal en la config global', async () => {
    const d = deps();
    writeFileSync(d.globalPath, JSON.stringify({ tui: { verbosity: 'compact' } }));
    expect(await runTelegramSetup(d)).toBe(true);
    const s = readTelegramFile(d.dir);
    expect(s.state === 'ok' && s.file.bot).toEqual({ id: 123456789, username: 'dot_bot' });
    expect(globalConfig(d)).toEqual({
      tui: { verbosity: 'compact' },
      channels: { telegram: { enabled: true } },
    });
    // Ni el token en la config ni en lo que imprime.
    expect(readFileSync(d.globalPath, 'utf8')).not.toContain(TOKEN);
    expect(out.join('')).not.toContain(TOKEN);
  });

  it('sin terminal no pide nada ni guarda nada', async () => {
    let asked = false;
    const d = deps({ isTTY: false, ask: async () => ((asked = true), TOKEN) });
    expect(await runTelegramSetup(d)).toBe(false);
    expect(asked).toBe(false);
    expect(readTelegramFile(d.dir).state).toBe('absent');
  });

  it('cancelar, un token con otra forma o uno que Telegram rechaza no cambian nada', async () => {
    expect(await runTelegramSetup(deps({ ask: async () => null }))).toBe(false);
    expect(await runTelegramSetup(deps({ ask: async () => 'nope' }))).toBe(false);
    const rejected = deps({
      api: () =>
        fakeApi(async () => {
          throw new TelegramApiError('unauthorized', 'Telegram getMe: Unauthorized');
        }),
    });
    expect(await runTelegramSetup(rejected)).toBe(false);
    expect(out.join('')).toContain('Telegram rejected the token.');
    expect(readTelegramFile(rejected.dir).state).toBe('absent');
  });

  it('avisa de los emparejados que se pierden al cambiar de bot', async () => {
    const d = deps();
    writeTelegramFile(d.dir, {
      schemaVersion: TELEGRAM_SCHEMA_VERSION,
      token: '987654321:BB' + 'y'.repeat(33),
      bot: { id: 987654321, username: 'viejo_bot' },
      paired: [{ userId: 5, chatId: 5, name: 'Ana', pairedAt: '2026-11-04T00:00:00.000Z' }],
      updatedAt: '2026-11-04T00:00:00.000Z',
    });
    await runTelegramSetup(d);
    expect(out.join('')).toContain('1 paired chat(s) of the previous one were removed');
  });
});

describe('formatTelegramStatus', () => {
  it('enseña bot y emparejados, nunca el token', () => {
    const text = formatTelegramStatus(
      {
        state: 'ok',
        file: {
          schemaVersion: TELEGRAM_SCHEMA_VERSION,
          token: TOKEN,
          bot: { id: 1, username: 'dot_bot' },
          paired: [
            {
              userId: 5,
              chatId: 5,
              name: 'Ana',
              username: 'ana',
              pairedAt: '2026-11-04T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-11-04T00:00:00.000Z',
        },
      },
      true,
    );
    expect(text).toContain('@dot_bot — enabled');
    expect(text).toContain('Ana @ana (id 5)');
    expect(text).not.toContain(TOKEN);
  });

  it('explica cada estado sin fichero válido', () => {
    expect(formatTelegramStatus({ state: 'absent' }, false)).toContain('not set up');
    expect(formatTelegramStatus({ state: 'invalid' }, true)).toContain('off');
    expect(formatTelegramStatus({ state: 'newer', schemaVersion: 2 }, true)).toContain('newer');
  });
});

describe('stratum channels', () => {
  it('telegram tiene status (por defecto), setup y disable, y setup no admite el token por flag', () => {
    const telegram = channelsCommand.commands.find((c) => c.name() === 'telegram')!;
    expect(telegram.commands.map((c) => c.name())).toEqual(['status', 'setup', 'disable']);
    const setup = telegram.commands.find((c) => c.name() === 'setup')!;
    expect(setup.options).toEqual([]);
  });
});

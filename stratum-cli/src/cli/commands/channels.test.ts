import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramApiError, type TelegramApi } from '../../channels/telegram/api.js';
import { ProtocolError } from '../../ipc/codec.js';
import { METHODS } from '../../protocol/index.js';
import {
  readTelegramFile,
  TELEGRAM_SCHEMA_VERSION,
  writeTelegramFile,
} from '../../channels/telegram/store.js';
import {
  channelsCommand,
  formatTelegramStatus,
  resolvePaired,
  runTelegramPair,
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
  it('telegram tiene status (por defecto), setup, pair, unpair y disable; ni setup ni pair admiten un secreto por flag', () => {
    const telegram = channelsCommand.commands.find((c) => c.name() === 'telegram')!;
    expect(telegram.commands.map((c) => c.name())).toEqual([
      'status',
      'setup',
      'pair',
      'unpair',
      'disable',
    ]);
    for (const name of ['setup', 'pair']) {
      expect(telegram.commands.find((c) => c.name() === name)!.options).toEqual([]);
    }
  });
});

const bea = { userId: 9, name: 'Bea', username: 'bea' };

/**
 * Un daemon de mentira que contesta `channels.*` según un guion y, como el de
 * verdad, por capacidades: la conexión de operador no empareja y la de
 * aprobador no pide códigos ni mira el estado.
 */
function fakeClient(statuses: Array<{ expiresAt: number; candidate: typeof bea | null } | null>) {
  const calls: { method: string; params: unknown; via: string }[] = [];
  let polls = 0;
  const connection = (via: 'operator' | 'approver') => ({
    request: async (method: string, params: unknown) => {
      calls.push({ method, params, via });
      const needs = METHODS[method as keyof typeof METHODS].capability;
      const has = via === 'operator' ? ['observe', 'control'] : ['approve'];
      if (!has.includes(needs as string)) {
        throw new ProtocolError('FORBIDDEN', `Missing capability: ${needs}.`);
      }
      if (method === 'channels.pairBegin') {
        return {
          code: 'ABCDEFGHJK',
          link: 'https://t.me/test_bot?start=ABCDEFGHJK',
          expiresAt: 10_000,
        };
      }
      if (method === 'channels.status') {
        const pairing = statuses[Math.min(polls++, statuses.length - 1)] ?? null;
        return { telegram: { pairing } };
      }
      if (method === 'channels.pairConfirm') {
        return { paired: { ...bea, pairedAt: 1 } };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return {
    client: connection('operator') as never,
    approver: connection('approver') as never,
    calls,
  };
}

describe('runTelegramPair', () => {
  function deps(fake: { client: never; approver: never }, answer: boolean, clock = { t: 0 }) {
    const questions: string[] = [];
    return {
      questions,
      deps: {
        client: fake.client,
        approver: fake.approver,
        confirm: async (q: string) => {
          questions.push(q);
          return answer;
        },
        out: (text: string) => out.push(text),
        sleep: async (ms: number) => {
          clock.t += ms;
        },
        now: () => clock.t,
        pollMs: 1_000,
      },
    };
  }

  it('espera al candidato, pregunta con quién y para qué, y empareja ese id', async () => {
    const fake = fakeClient([
      { expiresAt: 10_000, candidate: null },
      { expiresAt: 10_000, candidate: bea },
    ]);
    const { calls } = fake;
    const { deps: d, questions } = deps(fake, true);
    expect(await runTelegramPair(d)).toBe(true);
    expect(out.join('')).toContain('https://t.me/test_bot?start=ABCDEFGHJK');
    expect(questions[0]).toContain('Bea @bea (Telegram id 9)');
    expect(questions[0]).toContain('approve');
    // El código y el estado por la de operador; emparejar, solo por la de aprobador.
    expect(calls.at(-1)).toEqual({
      method: 'channels.pairConfirm',
      params: { userId: 9 },
      via: 'approver',
    });
    expect(
      calls.filter((c) => c.method !== 'channels.pairConfirm').every((c) => c.via === 'operator'),
    ).toBe(true);
  });

  it('decir que no no empareja', async () => {
    const fake = fakeClient([{ expiresAt: 10_000, candidate: bea }]);
    const { calls } = fake;
    const { deps: d } = deps(fake, false);
    expect(await runTelegramPair(d)).toBe(false);
    expect(calls.map((c) => c.method)).not.toContain('channels.pairConfirm');
  });

  it('caducado o anulado: no empareja', async () => {
    const expired = fakeClient([{ expiresAt: 10_000, candidate: null }]);
    expect(await runTelegramPair(deps(expired, true).deps)).toBe(false);
    expect(out.join('')).toContain('expired');
    const cancelled = fakeClient([null]);
    expect(await runTelegramPair(deps(cancelled, true).deps)).toBe(false);
    expect(out.join('')).toContain('cancelled');
  });
});

describe('resolvePaired', () => {
  const paired = [
    { userId: 9, chatId: 9, name: 'Bea', username: 'Bea_T', pairedAt: 'x' },
    { userId: 42, chatId: 42, name: 'Ana', pairedAt: 'x' },
  ];

  it('por id o por @usuario (sin mayúsculas); el nombre no basta', () => {
    expect(resolvePaired(paired, '42')?.name).toBe('Ana');
    expect(resolvePaired(paired, '@bea_t')?.userId).toBe(9);
    expect(resolvePaired(paired, 'bea_t')?.userId).toBe(9);
    expect(resolvePaired(paired, 'Ana')).toBeNull();
    expect(resolvePaired(paired, '7')).toBeNull();
  });
});

import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { defaultEndpointDir, fileDiscovery } from '../../client/discovery.js';
import { GLOBAL_CONFIG_PATH, readConfigFile, validateConfigLayer } from '../../config/loader.js';
import { setByDotPath } from '../../config/dot-path.js';
import { writeConfigWithBackup } from '../../config/writer.js';
import {
  HttpTelegramApi,
  TelegramApiError,
  isTelegramToken,
  type TelegramApi,
} from '../../channels/telegram/api.js';
import {
  publicTelegramState,
  readTelegramFile,
  removeTelegramPaired,
  saveTelegramBot,
  telegramFilePath,
  type TelegramFileState,
  type TelegramPaired,
} from '../../channels/telegram/store.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { askLine } from '../readline-prompt.js';
import { cliVersion } from '../version.js';
import { approver, askSecret } from './approvals.js';
import { describeError } from './routines.js';

/**
 * M18 — `stratum channels telegram setup|status|pair|unpair|disable`
 * (`docs/PRD_STRATUM_DOT.md` §23.11, `docs/protocol.md` §24).
 *
 * `setup` pide el token del bot **sin eco y solo por terminal** (como la clave
 * de aprobador: no hay flag ni variable de entorno que lo sustituya, y un
 * comando lanzado por el agente no tiene terminal), lo comprueba con `getMe` y
 * lo guarda en `~/.stratum/daemon/telegram.json`. Después enciende
 * `channels.telegram.enabled` en la config **global**, la única que cuenta.
 *
 * Nada de lo que imprime lleva el token. Emparejar un chat da autoridad de
 * aprobar, así que `pair` se conecta como aprobador (la clave, por terminal)
 * y pregunta antes de confirmar al candidato. Desemparejar solo resta.
 */

/** `channels.telegram.enabled` de la config global. */
function telegramEnabled(globalPath: string = GLOBAL_CONFIG_PATH): boolean {
  if (!existsSync(globalPath)) return false;
  return validateConfigLayer(globalPath, readConfigFile(globalPath), globalPath).channels.telegram
    .enabled;
}

function setTelegramEnabled(enabled: boolean, globalPath: string = GLOBAL_CONFIG_PATH): void {
  const raw = existsSync(globalPath) ? readConfigFile(globalPath) : {};
  setByDotPath(raw, 'channels.telegram.enabled', enabled);
  writeConfigWithBackup(globalPath, raw);
}

/** Estado legible del canal. Pura: nunca recibe el token. */
export function formatTelegramStatus(state: TelegramFileState, enabled: boolean): string {
  const lines: string[] = [];
  switch (state.state) {
    case 'absent':
      lines.push('Telegram: not set up (run "stratum channels telegram setup").');
      break;
    case 'invalid':
      lines.push(
        'Telegram: off — telegram.json is not valid. Run "stratum channels telegram setup" again.',
      );
      break;
    case 'newer':
      lines.push(
        `Telegram: telegram.json is from a newer Stratum (schemaVersion ${state.schemaVersion}); not read.`,
      );
      break;
    case 'ok': {
      const pub = publicTelegramState(state.file);
      lines.push(`Telegram: bot @${pub.bot.username} — ${enabled ? 'enabled' : 'disabled'}`);
      if (pub.paired.length === 0) {
        lines.push(
          '  paired:  none yet (pair a chat from Dot → Assistant → Telegram, or "stratum channels telegram pair")',
        );
      } else {
        for (const p of pub.paired) {
          const user = p.username ? ` @${p.username}` : '';
          lines.push(`  paired:  ${p.name}${user} (id ${p.userId}) since ${p.pairedAt}`);
        }
      }
      if (!enabled) {
        lines.push('  "stratum channels telegram setup" enables it again.');
      }
      break;
    }
  }
  return lines.join('\n');
}

export interface SetupDeps {
  dir: string;
  globalPath: string;
  ask: (prompt: string) => Promise<string | null>;
  api: (token: string) => TelegramApi;
  out: (text: string) => void;
  isTTY: boolean;
}

/**
 * El cuerpo de `setup`, con sus dependencias inyectadas para los tests.
 * @returns `false` si no se guardó nada.
 */
export async function runTelegramSetup(deps: SetupDeps): Promise<boolean> {
  if (!deps.isTTY) {
    deps.out(
      'Setting up Telegram needs an interactive terminal: the token is never read from a pipe, a flag or the environment.\n',
    );
    return false;
  }
  deps.out(
    'Create a bot with @BotFather in Telegram (/newbot) and paste its token here.\n' +
      'It is stored only in the private daemon folder and never shown again.\n',
  );
  const token = (await deps.ask('Bot token: '))?.trim();
  if (!token) {
    deps.out('Cancelled.\n');
    return false;
  }
  if (!isTelegramToken(token)) {
    deps.out('That does not look like a bot token (<digits>:<35 characters>). Nothing changed.\n');
    return false;
  }
  let bot;
  try {
    bot = await deps.api(token).getMe();
  } catch (err) {
    const why =
      err instanceof TelegramApiError && err.kind === 'unauthorized'
        ? 'Telegram rejected the token.'
        : err instanceof Error
          ? err.message
          : String(err);
    deps.out(`Could not check the token: ${why} Nothing changed.\n`);
    return false;
  }
  if (!bot.isBot || !bot.username) {
    deps.out('That token does not belong to a bot. Nothing changed.\n');
    return false;
  }
  const saved = saveTelegramBot(deps.dir, token, { id: bot.id, username: bot.username });
  setTelegramEnabled(true, deps.globalPath);
  deps.out(`Bot @${bot.username} saved in ${saved.path} and enabled in ${deps.globalPath}.\n`);
  if (saved.droppedPaired > 0) {
    deps.out(
      `It is a different bot: ${saved.droppedPaired} paired chat(s) of the previous one were removed.\n`,
    );
  }
  deps.out(
    'Next: pair your chat from Dot → Assistant → Telegram, or with "stratum channels telegram pair".\n',
  );
  return true;
}

type Requester = Pick<StratumClient, 'request'>;

export interface PairDeps {
  /** Conexión de operador: pedir el código y mirar el estado (`control`/`observe`). */
  client: Requester;
  /** Conexión de aprobador: solo para confirmar (`approve`). */
  approver: Requester;
  /** Pregunta sí/no; `false` también si se cancela. */
  confirm: (question: string) => Promise<boolean>;
  out: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs?: number;
}

/**
 * El cuerpo de `pair`: pide un código, espera a que alguien lo mande al bot y
 * pregunta antes de emparejarlo. Como en Dot, son dos conexiones: la de
 * operador pide y mira, y la de aprobador solo confirma (`channels.pairConfirm`
 * exige `approve`, y una conexión de aprobador no tiene `control`).
 * @returns `true` si quedó emparejado.
 */
export async function runTelegramPair(deps: PairDeps): Promise<boolean> {
  const begin = await deps.client.request('channels.pairBegin', {});
  deps.out(
    `Open this link on the phone where you use Telegram:\n\n  ${begin.link}\n\n` +
      `or send "/start ${begin.code}" to the bot. The code works once and expires at ` +
      `${new Date(begin.expiresAt).toLocaleTimeString()}.\nWaiting for it… (Ctrl+C to stop)\n`,
  );
  while (deps.now() < begin.expiresAt) {
    const { telegram } = await deps.client.request('channels.status', {});
    const pairing = telegram.pairing;
    if (!pairing) {
      deps.out(
        'The pairing was cancelled (another one started, too many wrong codes, or the channel reloaded).\n',
      );
      return false;
    }
    const c = pairing.candidate;
    if (c) {
      const user = c.username ? ` @${c.username}` : '';
      const yes = await deps.confirm(
        `Pair ${c.name}${user} (Telegram id ${c.userId})? It will be able to talk to the ` +
          'assistant and approve its requests from Telegram. [y/N] ',
      );
      if (!yes) {
        deps.out('Not paired.\n');
        return false;
      }
      const { paired } = await deps.approver.request('channels.pairConfirm', { userId: c.userId });
      deps.out(`Paired with ${paired.name}. Send /unpair in that chat to stop.\n`);
      return true;
    }
    await deps.sleep(deps.pollMs ?? 2_000);
  }
  deps.out('The code expired. Run "stratum channels telegram pair" again.\n');
  return false;
}

/** `<user>` de `unpair`: el id numérico o el `@usuario` de un emparejado. */
export function resolvePaired(
  paired: readonly TelegramPaired[],
  ref: string,
): TelegramPaired | null {
  const key = ref.trim().replace(/^@/, '').toLowerCase();
  return (
    paired.find((p) => String(p.userId) === key) ??
    paired.find((p) => p.username?.toLowerCase() === key) ??
    null
  );
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** Una conexión de operador al daemon en marcha, o `null` si no lo hay. */
async function operator(): Promise<StratumClient | null> {
  const found = await locateLiveDaemon();
  if (found.status !== 'found') return null;
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum channels', version: cliVersion(), roles: ['operator'] },
    reconnect: false,
    requestTimeoutMs: 20_000,
  });
  await client.connect();
  return client;
}

/** Tras tocar el fichero o la config: que el daemon en marcha vuelva a leerlos. */
async function reloadDaemon(): Promise<void> {
  let client: StratumClient | null = null;
  try {
    client = await operator();
    if (!client) return;
    const { telegram } = await client.request('channels.reload', {});
    process.stderr.write(`The daemon reloaded the channel: ${telegram.state}.\n`);
  } catch (err) {
    process.stderr.write(
      `The running daemon could not reload the channel (${describeError(err)}); ` +
        'restart it with "stratum daemon stop" and "stratum daemon start".\n',
    );
  } finally {
    client?.close();
  }
}

const setup = new Command('setup')
  .description('Store the token of your Telegram bot (asked without echo) and enable the channel')
  .action(async () => {
    const ok = await runTelegramSetup({
      dir: defaultEndpointDir(),
      globalPath: GLOBAL_CONFIG_PATH,
      ask: askSecret,
      api: (token) => new HttpTelegramApi({ token }),
      out: (text) => process.stderr.write(text),
      isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    });
    if (!ok) {
      process.exitCode = 1;
      return;
    }
    await reloadDaemon();
  });

const pair = new Command('pair')
  .description('Pair your Telegram chat with the assistant (asks for the approver key)')
  .action(async () => {
    const found = await locateLiveDaemon();
    if (found.status !== 'found') {
      fail('stratumd is not running: start it with "stratum daemon start" first.');
      return;
    }
    // Emparejar da autoridad de aprobar: la clave se pide antes de nada, para
    // no pedir un código que luego no se pueda confirmar.
    const authority = await approver('stratum channels');
    if (!authority) return;
    let client: StratumClient | null = null;
    try {
      client = await operator();
      if (!client) {
        fail('stratumd is not running any more.');
        return;
      }
      const ok = await runTelegramPair({
        client,
        approver: authority,
        confirm: async (question) => {
          // El readline solo mientras se pregunta: abierto, se quedaría con el Ctrl+C.
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = (await askLine(rl, question))?.trim().toLowerCase() ?? '';
            return answer === 'y' || answer === 'yes';
          } finally {
            rl.close();
          }
        },
        out: (text) => process.stderr.write(text),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      });
      if (!ok) process.exitCode = 1;
    } catch (err) {
      fail(describeError(err));
    } finally {
      client?.close();
      authority.close();
    }
  });

const unpair = new Command('unpair')
  .description('Unpair a Telegram chat (by Telegram id or @username)')
  .argument('<user>', 'Telegram id or @username, as "status" shows it')
  .action(async (ref: string) => {
    const dir = defaultEndpointDir();
    const state = readTelegramFile(dir);
    const target = state.state === 'ok' ? resolvePaired(state.file.paired, ref) : null;
    if (!target) {
      fail(`No paired chat "${ref}". See "stratum channels telegram status".`);
      return;
    }
    let client: StratumClient | null = null;
    try {
      client = await operator();
      // Con el daemon en marcha va por él (sigue escuchando a quien está en su lista);
      // sin él, basta el fichero: quitar solo resta.
      const removed = client
        ? (await client.request('channels.unpair', { userId: target.userId })).removed
        : removeTelegramPaired(dir, target.userId);
      process.stdout.write(
        removed ? `Unpaired ${target.name}.\n` : `${target.name} was not paired any more.\n`,
      );
    } catch (err) {
      fail(describeError(err));
    } finally {
      client?.close();
    }
  });

const status = new Command('status')
  .description('Show the Telegram channel: bot, whether it is enabled and the paired chats')
  .option('--json', 'machine-readable output (never includes the token)')
  .action((opts: { json?: boolean }) => {
    const state = readTelegramFile(defaultEndpointDir());
    const enabled = telegramEnabled();
    if (opts.json) {
      const body =
        state.state === 'ok'
          ? { state: 'ok', enabled, ...publicTelegramState(state.file) }
          : { ...state, enabled };
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${formatTelegramStatus(state, enabled)}\n`);
  });

const disable = new Command('disable')
  .description('Turn the Telegram channel off (keeps the token and the paired chats)')
  .action(async () => {
    setTelegramEnabled(false);
    process.stdout.write(
      `Telegram disabled in ${GLOBAL_CONFIG_PATH}. The token stays in ${telegramFilePath(defaultEndpointDir())}.\n`,
    );
    await reloadDaemon();
  });

const telegram = new Command('telegram')
  .description('Talk to the Dot assistant from Telegram')
  .addCommand(status, { isDefault: true })
  .addCommand(setup)
  .addCommand(pair)
  .addCommand(unpair)
  .addCommand(disable);

export const channelsCommand = new Command('channels')
  .description('External channels to the Dot assistant (Telegram)')
  .addCommand(telegram);

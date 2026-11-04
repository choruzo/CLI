import { existsSync } from 'fs';
import { Command } from 'commander';
import { defaultEndpointDir } from '../../client/discovery.js';
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
  saveTelegramBot,
  telegramFilePath,
  type TelegramFileState,
} from '../../channels/telegram/store.js';
import { askSecret } from './approvals.js';

/**
 * M18 — `stratum channels telegram setup|status|disable`
 * (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * `setup` pide el token del bot **sin eco y solo por terminal** (como la clave
 * de aprobador: no hay flag ni variable de entorno que lo sustituya, y un
 * comando lanzado por el agente no tiene terminal), lo comprueba con `getMe` y
 * lo guarda en `~/.stratum/daemon/telegram.json`. Después enciende
 * `channels.telegram.enabled` en la config **global**, la única que cuenta.
 *
 * Nada de lo que imprime lleva el token. Emparejar un chat es aparte: da
 * autoridad de aprobar, así que se confirma en Dot (o con la clave de
 * aprobador) y llega con el canal del daemon.
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
        lines.push('  paired:  none yet (pair a chat from Dot → Settings → Telegram)');
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
  deps.out('Next: pair your chat from Dot → Settings → Telegram.\n');
  return true;
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
    if (!ok) process.exitCode = 1;
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
  .action(() => {
    setTelegramEnabled(false);
    process.stdout.write(
      `Telegram disabled in ${GLOBAL_CONFIG_PATH}. The token stays in ${telegramFilePath(defaultEndpointDir())}.\n`,
    );
  });

const telegram = new Command('telegram')
  .description('Talk to the Dot assistant from Telegram')
  .addCommand(status, { isDefault: true })
  .addCommand(setup)
  .addCommand(disable);

export const channelsCommand = new Command('channels')
  .description('External channels to the Dot assistant (Telegram)')
  .addCommand(telegram);

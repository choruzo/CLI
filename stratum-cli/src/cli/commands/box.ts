import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { Command } from 'commander';
import { connectorsFile, enabledConnectorIds } from '../../connectors/store.js';
import { companionDataDir } from '../../host/companion.js';
import { askLine } from '../readline-prompt.js';
import { GLOBAL_CONFIG_PATH, readConfigFile, validateConfigLayer } from '../../config/loader.js';
import { BoxConfigSchema, type BoxConfig } from '../../config/schema.js';
import {
  BoxBusyError,
  BoxCommandError,
  BoxManager,
  BoxUnavailableError,
  type BoxStatus,
  type ConnectorsBoxStatus,
} from '../../box/manager.js';
import { BOX_EXCHANGE } from '../../box/spec.js';

/**
 * M13 — `stratum box status|start|stop|reset`: el ciclo de vida de la caja
 * (`src/box/`). Habla con el runtime directamente, con las mismas órdenes fijas
 * que el daemon (`box.*`): la CLI no depende del daemon.
 */

/** La sección `box` de la config global: es la única que cuenta. */
function globalBoxConfig(): BoxConfig {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return BoxConfigSchema.parse({});
  return validateConfigLayer(GLOBAL_CONFIG_PATH, readConfigFile(GLOBAL_CONFIG_PATH)).box;
}

function manager(): BoxManager {
  return new BoxManager({
    config: globalBoxConfig(),
    onProgress: (line) => process.stderr.write(`  ${line}\n`),
    // M20: con algún conector activo, `start` arranca también la caja de conectores.
    connectorsWanted: () => enabledConnectorIds(connectorsFile(companionDataDir())).length > 0,
  });
}

const STATE_LABEL: Record<BoxStatus['state'], string> = {
  unavailable: 'unavailable',
  absent: 'not created',
  stopped: 'stopped',
  running: 'running',
};

export function formatBoxStatus(s: BoxStatus): string {
  const runtime = s.runtime ? ` (${s.runtime})` : '';
  const lines = [`Box "${s.name}": ${STATE_LABEL[s.state]}${runtime}`];
  if (s.reason) lines.push(`  ${s.reason}`);
  lines.push(`  image:    ${s.image}`);
  lines.push(`  network:  ${s.network ? 'on' : 'off'}`);
  lines.push(`  exchange: ${s.exchangeDir} <-> ${BOX_EXCHANGE}`);
  lines.push(
    s.enabled
      ? `  exec:     sessions can use target "container:${s.name}"`
      : '  exec:     off (set "box.enabled": true in the global config to let sessions use it)',
  );
  if (s.outdated) {
    lines.push(
      '  outdated: created with another image or settings; "stratum box start" recreates it (its home is kept)',
    );
  }
  return lines.join('\n');
}

/**
 * M20 — la línea de la caja de conectores en `status`. Solo aparece si esa caja
 * existe o hay algún conector activo (sin conectores no es ruido).
 */
export function formatConnectorsBoxLine(
  s: ConnectorsBoxStatus,
  anyEnabled: boolean,
): string | null {
  if (s.state === 'absent' && !anyEnabled) return null;
  const lines = [
    `  connectors box: ${STATE_LABEL[s.state]}${s.outdated ? ', outdated (recreated on next start)' : ''}`,
  ];
  if (s.reason) lines.push(`    ${s.reason}`);
  return lines.join('\n');
}

async function runOperation(
  opts: { json?: boolean },
  op: (m: BoxManager) => Promise<BoxStatus>,
): Promise<void> {
  try {
    const status = await op(manager());
    process.stdout.write(
      `${opts.json ? JSON.stringify(status, null, 2) : formatBoxStatus(status)}\n`,
    );
  } catch (err) {
    if (
      err instanceof BoxUnavailableError ||
      err instanceof BoxCommandError ||
      err instanceof BoxBusyError
    ) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function confirmReset(name: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await askLine(
      rl,
      `This deletes the box "${name}" and everything in its home. Type "${name}" to confirm: `,
    );
    return answer?.trim() === name;
  } finally {
    rl.close();
  }
}

const boxStatus = new Command('status')
  .description('Show the state of the box (and the connectors box, if there is one)')
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      const m = manager();
      const status = await m.status();
      const connectors = await m.connectorsStatus();
      const anyEnabled = enabledConnectorIds(connectorsFile(companionDataDir())).length > 0;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...status, connectors }, null, 2)}\n`);
        return;
      }
      const line = formatConnectorsBoxLine(connectors, anyEnabled);
      process.stdout.write(`${formatBoxStatus(status)}${line ? `\n${line}` : ''}\n`);
    } catch (err) {
      if (
        err instanceof BoxUnavailableError ||
        err instanceof BoxCommandError ||
        err instanceof BoxBusyError
      ) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

const boxStart = new Command('start')
  .description('Start the box, creating it (and building its image) if needed')
  .option('--json', 'output as JSON')
  .action((opts: { json?: boolean }) => runOperation(opts, (m) => m.start()));

const boxStop = new Command('stop')
  .description('Stop the box (its home is kept)')
  .option('--json', 'output as JSON')
  .action((opts: { json?: boolean }) => runOperation(opts, (m) => m.stop()));

const boxReset = new Command('reset')
  .description('Delete the box and its home volume')
  .option('--yes', 'do not ask for confirmation')
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean; yes?: boolean }) => {
    const name = globalBoxConfig().name;
    if (!opts.yes && !(await confirmReset(name))) {
      process.stderr.write(
        process.stdin.isTTY
          ? 'Cancelled.\n'
          : 'Refusing to reset without a terminal; pass --yes.\n',
      );
      process.exitCode = 1;
      return;
    }
    await runOperation(opts, (m) => m.reset());
  });

export const boxCommand = new Command('box')
  .description(
    'Manage the box: an isolated container sessions can run commands in (container:<box>)',
  )
  .addCommand(boxStatus)
  .addCommand(boxStart)
  .addCommand(boxStop)
  .addCommand(boxReset);

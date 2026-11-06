import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { existsSync, readFileSync } from 'fs';
import {
  GLOBAL_CONFIG_PATH,
  loadConfig,
  readConfigFile,
  validateConfigLayer,
} from '../../config/loader.js';
import {
  readGlobalConfigSnapshot,
  setConfigValue,
  setGlobalConfigValue,
} from '../../config/writer.js';
import { getByDotPath, formatConfigValue } from '../../config/dot-path.js';
import { ConfigMenu } from '../ui/ConfigMenu.js';

/** Config efectiva SOLO de la capa global (con defaults), sin mirar ningún proyecto. */
function loadGlobalOnly(): Record<string, unknown> {
  const raw = existsSync(GLOBAL_CONFIG_PATH) ? readConfigFile(GLOBAL_CONFIG_PATH) : {};
  return validateConfigLayer(GLOBAL_CONFIG_PATH, raw) as unknown as Record<string, unknown>;
}

/** Todo stdin como texto, sin el salto de línea final que añade un `echo`. */
function readStdinValue(): string {
  return readFileSync(0, 'utf-8').replace(/\r?\n$/, '');
}

const configGet = new Command('get')
  .description('Get a config value by dot-path key')
  .argument('<key>', 'dot-path key (e.g. provider.default)')
  .option('--global', 'read only ~/.stratum/.stratumrc.json, never a project file')
  .action((key: string, opts: { global?: boolean }) => {
    try {
      const config = opts.global ? loadGlobalOnly() : (loadConfig() as Record<string, unknown>);
      const value = getByDotPath(config, key);
      if (value === undefined) {
        process.stderr.write(`Key not found: ${key}\n`);
        process.exit(1);
      }
      process.stdout.write(formatConfigValue(value));
      process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(`Error loading config: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

const configSet = new Command('set')
  .description('Set a config value by dot-path key')
  .argument('<key>', 'dot-path key (e.g. provider.default)')
  .argument('[value]', 'value to set (or use --stdin)')
  .option('--global', 'write only ~/.stratum/.stratumrc.json, never a project file')
  .option('--json', 'the value is JSON and is stored as is (typed values, lists, objects)')
  .option('--stdin', 'read the value from stdin (keeps secrets out of the process list)')
  .action((key: string, value: string | undefined, opts: Record<string, boolean | undefined>) => {
    try {
      if (opts['stdin'] && value !== undefined) {
        throw new Error('Pass the value as an argument or with --stdin, not both.');
      }
      if (!opts['stdin'] && value === undefined) {
        throw new Error('Missing value: pass it as an argument or with --stdin.');
      }
      if (opts['json'] && !opts['global']) {
        throw new Error('--json needs --global.');
      }
      const text = opts['stdin'] ? readStdinValue() : (value as string);
      // Con --stdin el valor puede ser un secreto: no se repite en la salida.
      const shown = opts['stdin'] ? '(stdin)' : text;
      const configPath = opts['global']
        ? setGlobalConfigValue(key, text, { json: opts['json'] === true })
        : setConfigValue(key, text);
      process.stdout.write(`Set ${key} = ${shown} in ${configPath}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

const configList = new Command('list')
  .description('Print the global config (raw, plus the schema defaults) for tools that edit it')
  .option('--global', 'required: only ~/.stratum/.stratumrc.json is supported')
  .option('--json', 'machine-readable output (required)')
  .action((opts: { global?: boolean; json?: boolean }) => {
    try {
      if (!opts.global || !opts.json) {
        throw new Error('`config list` needs --global --json.');
      }
      process.stdout.write(JSON.stringify(readGlobalConfigSnapshot()) + '\n');
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

export const configCommand = new Command('config')
  .description('Edit .stratumrc.json in an interactive menu, or get/set a value by key')
  .addCommand(configGet)
  .addCommand(configSet)
  .addCommand(configList)
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        'The interactive menu needs a terminal. Use `stratum config get|set <key>` instead.\n',
      );
      process.exit(1);
    }
    const { unmount, waitUntilExit } = render(
      React.createElement(ConfigMenu, {
        cwd: process.cwd(),
        onExit: () => unmount(),
      }),
      { exitOnCtrlC: true },
    );
    await waitUntilExit();
    // Tras navegar entre pantallas el proceso seguía vivo al desmontar Ink
    // (en ConPTY, sin handles a la vista): el menú es lo último que hace.
    process.exit(0);
  });

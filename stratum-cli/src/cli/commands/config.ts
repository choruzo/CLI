import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { setConfigValue } from '../../config/writer.js';
import { getByDotPath, formatConfigValue } from '../../config/dot-path.js';
import { ConfigMenu } from '../ui/ConfigMenu.js';

const configGet = new Command('get')
  .description('Get a config value by dot-path key')
  .argument('<key>', 'dot-path key (e.g. provider.default)')
  .action((key: string) => {
    try {
      const config = loadConfig() as Record<string, unknown>;
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
  .argument('<value>', 'value to set')
  .action((key: string, value: string) => {
    try {
      const configPath = setConfigValue(key, value);
      process.stdout.write(`Set ${key} = ${value} in ${configPath}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

export const configCommand = new Command('config')
  .description('Edit .stratumrc.json in an interactive menu, or get/set a value by key')
  .addCommand(configGet)
  .addCommand(configSet)
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

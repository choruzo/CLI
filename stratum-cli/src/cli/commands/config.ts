import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { setConfigValue } from '../../config/writer.js';
import { getByDotPath, formatConfigValue } from '../../config/dot-path.js';

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
  .description('Get or set configuration values from .stratumrc.json')
  .addCommand(configGet)
  .addCommand(configSet);

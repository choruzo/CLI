import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { writeFileAtomic } from '../../config/writer.js';
import { StratumConfigSchema } from '../../config/schema.js';
import { getByDotPath, setByDotPath, formatConfigValue } from '../../config/dot-path.js';

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
    const configPath = findConfigFile(process.cwd()) ?? join(process.cwd(), '.stratumrc.json');
    let raw: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        process.stderr.write(`Failed to parse ${configPath}\n`);
        process.exit(1);
      }
    }

    setByDotPath(raw, key, value);

    try {
      StratumConfigSchema.parse(raw);
    } catch (err) {
      process.stderr.write(`Invalid config after update: ${(err as Error).message}\n`);
      process.exit(1);
    }

    writeFileAtomic(configPath, JSON.stringify(raw, null, 2) + '\n');
    process.stdout.write(`Set ${key} = ${value} in ${configPath}\n`);
  });

export const configCommand = new Command('config')
  .description('Get or set configuration values from .stratumrc.json')
  .addCommand(configGet)
  .addCommand(configSet);

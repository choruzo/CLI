import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { StratumConfigSchema } from '../../config/schema.js';

function getByDotPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current !== null && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setByDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  // Try to coerce common types
  if (value === 'true') current[lastKey] = true;
  else if (value === 'false') current[lastKey] = false;
  else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
    current[lastKey] = Number(value);
  } else {
    current[lastKey] = value;
  }
}

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
      process.stdout.write(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
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

    writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    process.stdout.write(`Set ${key} = ${value} in ${configPath}\n`);
  });

export const configCommand = new Command('config')
  .description('Get or set configuration values from .stratumrc.json')
  .addCommand(configGet)
  .addCommand(configSet);

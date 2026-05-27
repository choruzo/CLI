import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { StratumConfigSchema, type StratumConfig } from './schema.js';

const CONFIG_FILENAME = '.stratumrc.json';

export function findConfigFile(startDir: string): string | null {
  let current = startDir;

  while (true) {
    const candidate = join(current, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName: string) => process.env[varName] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(startDir?: string): StratumConfig {
  const searchDir = startDir ?? process.cwd();
  const configPath = findConfigFile(searchDir);

  if (!configPath) {
    return StratumConfigSchema.parse({});
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
  const expanded = expandEnvVars(raw);
  return StratumConfigSchema.parse(expanded);
}

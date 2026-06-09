import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { StratumConfigSchema, type StratumConfig } from './schema.js';

const CONFIG_FILENAME = '.stratumrc.json';
const GLOBAL_CONFIG_PATH = join(homedir(), '.stratum', CONFIG_FILENAME);

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

function readRawConfig(filePath: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  return expandEnvVars(raw) as Record<string, unknown>;
}

function mergeConfigs(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = base[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      // Para provider.providers hacemos merge de claves, no reemplazo
      result[key] = mergeConfigs(
        baseVal as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(startDir?: string): StratumConfig {
  const searchDir = startDir ?? process.cwd();

  // 1. Config global (~/.stratum/.stratumrc.json)
  let merged: Record<string, unknown> = {};
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    merged = readRawConfig(GLOBAL_CONFIG_PATH);
  }

  // 2. Config de proyecto (sube desde cwd hasta encontrar uno)
  const projectConfigPath = findConfigFile(searchDir);
  if (projectConfigPath) {
    const projectRaw = readRawConfig(projectConfigPath);
    merged = mergeConfigs(merged, projectRaw);
  }

  return StratumConfigSchema.parse(merged);
}

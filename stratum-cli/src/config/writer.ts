import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { findConfigFile, expandEnvVars, GLOBAL_CONFIG_PATH } from './loader.js';
import { StratumConfigSchema, type ProviderConfig } from './schema.js';

/**
 * Escritura de `.stratumrc.json` para el wizard de providers (Hito 3.5).
 *
 * Importante: aquí se lee y escribe el JSON **crudo**, sin expansión de
 * variables de entorno — los placeholders `${VAR}` deben preservarse tal cual
 * en disco y los secretos expandidos nunca deben persistirse.
 */

/**
 * Resuelve dónde escribir la config: el `.stratumrc.json` de proyecto si existe
 * (búsqueda ascendente desde `cwd`), o el global `~/.stratum/.stratumrc.json`.
 */
export function resolveWritableConfigPath(startDir?: string): string {
  return findConfigFile(startDir ?? process.cwd()) ?? GLOBAL_CONFIG_PATH;
}

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * Escribe la config validándola primero (con env vars expandidas, como hace el
 * loader) y haciendo backup `.bak` del archivo previo si existía.
 *
 * @returns ruta del backup creado, o `null` si no había archivo previo.
 */
export function writeConfigWithBackup(path: string, raw: Record<string, unknown>): string | null {
  // Validar el resultado final antes de tocar el disco
  StratumConfigSchema.parse(expandEnvVars(raw));

  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  return backupPath;
}

export interface UpsertProviderResult {
  configPath: string;
  backupPath: string | null;
  created: boolean; // true si el archivo no existía
}

/**
 * Añade o actualiza un provider en la config sin tocar los demás.
 * Si `makeDefault` es true, actualiza también `provider.default`.
 */
export function upsertProvider(
  name: string,
  providerCfg: ProviderConfig,
  makeDefault: boolean,
  configPath?: string,
): UpsertProviderResult {
  const path = configPath ?? resolveWritableConfigPath();
  const created = !existsSync(path);
  const raw = readRaw(path);

  const providerBlock = (raw['provider'] ?? {}) as Record<string, unknown>;
  const providers = (providerBlock['providers'] ?? {}) as Record<string, unknown>;

  providers[name] = providerCfg;
  providerBlock['providers'] = providers;
  if (makeDefault || !providerBlock['default']) {
    providerBlock['default'] = name;
  }
  raw['provider'] = providerBlock;

  const backupPath = writeConfigWithBackup(path, raw);
  return { configPath: path, backupPath, created };
}

export interface RemoveProviderResult {
  configPath: string;
  backupPath: string | null;
  /** Nuevo default si el eliminado era el default y quedaban otros. */
  newDefault: string | null;
}

/** Elimina un provider. Si era el default, promueve el primero restante. */
export function removeProvider(name: string, configPath?: string): RemoveProviderResult {
  const path = configPath ?? resolveWritableConfigPath();
  const raw = readRaw(path);

  const providerBlock = raw['provider'] as Record<string, unknown> | undefined;
  const providers = providerBlock?.['providers'] as Record<string, unknown> | undefined;
  if (!providerBlock || !providers || !(name in providers)) {
    throw new Error(`Provider "${name}" no existe en ${path}`);
  }

  delete providers[name];
  const remaining = Object.keys(providers);

  let newDefault: string | null = null;
  if (remaining.length === 0) {
    delete raw['provider'];
  } else if (providerBlock['default'] === name) {
    newDefault = remaining[0];
    providerBlock['default'] = newDefault;
  }

  const backupPath = writeConfigWithBackup(path, raw);
  return { configPath: path, backupPath, newDefault };
}

/** Cambia el provider default (comando `stratum provider use`). */
export function setDefaultProvider(
  name: string,
  configPath?: string,
): { configPath: string; backupPath: string | null } {
  const path = configPath ?? resolveWritableConfigPath();
  const raw = readRaw(path);

  const providerBlock = raw['provider'] as Record<string, unknown> | undefined;
  const providers = providerBlock?.['providers'] as Record<string, unknown> | undefined;
  if (!providerBlock || !providers || !(name in providers)) {
    throw new Error(`Provider "${name}" no existe en ${path}`);
  }

  providerBlock['default'] = name;
  const backupPath = writeConfigWithBackup(path, raw);
  return { configPath: path, backupPath };
}

/** Lee el bloque crudo de un provider (con `${VAR}` sin expandir), si existe. */
export function readRawProvider(name: string, configPath?: string): Record<string, unknown> | null {
  const path = configPath ?? resolveWritableConfigPath();
  const raw = readRaw(path);
  const providers = (raw['provider'] as Record<string, unknown> | undefined)?.['providers'] as
    | Record<string, unknown>
    | undefined;
  const entry = providers?.[name];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

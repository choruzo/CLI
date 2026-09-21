import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { StratumConfigSchema, type StratumConfig } from './schema.js';
import { assertSchemaVersion } from './schema-version.js';

export const CONFIG_FILENAME = '.stratumrc.json';
export const GLOBAL_CONFIG_PATH = join(homedir(), '.stratum', CONFIG_FILENAME);

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
  // 15.6 — antes de migrar o validar: un fichero de un Stratum más nuevo no se
  // interpreta a medias. Cada capa se comprueba por separado, así el error
  // nombra el fichero concreto.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    assertSchemaVersion((raw as Record<string, unknown>).schemaVersion, 'config', filePath);
  }
  return migrateLegacyKeys(expandEnvVars(raw) as Record<string, unknown>, filePath);
}

/** Avisos de claves obsoletas detectadas al cargar, pendientes de emitir. */
const pendingDeprecations: string[] = [];

/**
 * Hito 16 — migra claves obsoletas DENTRO de una capa de config, antes de
 * fusionarla con las demás. Hacerlo después del merge rompería la precedencia
 * proyecto > global: un `tools.auditLog` global ganaría a un `ssh.auditLog` del
 * proyecto. Si la capa trae ya la clave nueva, esa gana.
 */
export function migrateLegacyKeys(
  layer: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  const ssh = layer.ssh;
  if (ssh === null || typeof ssh !== 'object' || !('auditLog' in ssh)) return layer;

  const legacy = (ssh as Record<string, unknown>).auditLog;
  const { auditLog: _dropped, ...restSsh } = ssh as Record<string, unknown>;
  const tools =
    layer.tools !== null && typeof layer.tools === 'object'
      ? (layer.tools as Record<string, unknown>)
      : {};
  pendingDeprecations.push(
    `${source}: "ssh.auditLog" está obsoleto desde el Hito 16; usa "tools.auditLog" ` +
      '(la auditoría cubre ahora todos los comandos, locales y remotos).',
  );
  return {
    ...layer,
    ssh: restSsh,
    tools: 'auditLog' in tools ? tools : { ...tools, auditLog: legacy },
  };
}

/** Devuelve y vacía los avisos de claves obsoletas (se emiten tras configurar el logging). */
export function takeConfigDeprecations(): string[] {
  return pendingDeprecations.splice(0, pendingDeprecations.length);
}

export function mergeConfigs(
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

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { StratumConfigSchema, type StratumConfig } from './schema.js';
import { assertSchemaVersion } from './schema-version.js';
import { jsonErrorPosition, stripBom } from './json-text.js';

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

/**
 * Error de config legible: nombra el fichero y, si es de validación, la clave.
 * Sustituye al `SyntaxError`/`ZodError` crudo, que llegaba a la terminal como
 * un volcado JSON sin decir qué fichero (global o de proyecto) fallaba.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Variable `${VAR}` referenciada en la config que no está definida. */
export interface MissingEnvVar {
  name: string;
  /** Dot-path de la clave donde aparece. */
  path: string;
}

/**
 * Sustituye `${VAR}` por su valor de entorno. Una variable no definida se
 * sustituye por `''` (una key de un provider que no se usa no debe impedir
 * arrancar), pero se informa por `onMissing` para poder avisar.
 */
export function expandEnvVars(
  obj: unknown,
  onMissing?: (missing: MissingEnvVar) => void,
  path = '',
): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) onMissing?.({ name: varName, path });
      return value ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((v, i) => expandEnvVars(v, onMissing, path ? `${path}.${i}` : String(i)));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value, onMissing, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return obj;
}

/**
 * Parsea el texto de un `.stratumrc.json`: tolera el BOM y convierte un JSON
 * roto en un error que nombra el fichero, la línea y la columna.
 */
export function parseConfigText(text: string, source: string): Record<string, unknown> {
  const clean = stripBom(text);
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch (err) {
    const { line, column } = jsonErrorPosition(err, clean);
    const where = line ? ` (línea ${line}, columna ${column})` : '';
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${source} no es un JSON válido${where}: ${detail}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${source} tiene que ser un objeto JSON ({ … }).`);
  }
  return value as Record<string, unknown>;
}

/** Lee y parsea un `.stratumrc.json` crudo (sin expandir variables). */
export function readConfigFile(filePath: string): Record<string, unknown> {
  return parseConfigText(readFileSync(filePath, 'utf-8'), filePath);
}

interface ConfigLayer {
  path: string;
  /** JSON crudo del fichero (con `${VAR}` sin expandir). */
  raw: Record<string, unknown>;
}

function prepareLayer(layer: ConfigLayer, warn: boolean): Record<string, unknown> {
  // 15.6 — antes de migrar o validar: un fichero de un Stratum más nuevo no se
  // interpreta a medias. Cada capa se comprueba por separado, así el error
  // nombra el fichero concreto.
  assertSchemaVersion(layer.raw.schemaVersion, 'config', layer.path);
  const reported = new Set<string>();
  const expanded = expandEnvVars(layer.raw, ({ name, path }) => {
    if (!warn || reported.has(name)) return;
    reported.add(name);
    pushWarning(
      `${layer.path}: la variable de entorno ${name} (en "${path}") no está definida; ` +
        'se usa una cadena vacía.',
    );
  });
  return migrateLegacyKeys(expanded as Record<string, unknown>, layer.path);
}

/** Máximo de problemas de validación que se listan. */
const MAX_LISTED_ISSUES = 10;

/**
 * Fusiona y valida las capas (global primero, proyecto después). Un error de
 * validación lista cada clave con su motivo y el fichero que la define.
 */
function buildConfig(layers: ConfigLayer[], opts: { warn: boolean }): StratumConfig {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) merged = mergeConfigs(merged, prepareLayer(layer, opts.warn));
  const result = StratumConfigSchema.safeParse(merged);
  if (result.success) return result.data;

  const lines = result.error.issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const key = issue.path.join('.');
    const origin = layerDefining(layers, issue.path);
    return `  - ${key || '(raíz)'}: ${issue.message}${origin ? `  [${origin}]` : ''}`;
  });
  const extra = result.error.issues.length - MAX_LISTED_ISSUES;
  if (extra > 0) lines.push(`  … y ${extra} más`);
  throw new ConfigError(`La config no es válida:\n${lines.join('\n')}`);
}

/**
 * El fichero que define la clave (o su antecesor más cercano), mirando del
 * de más precedencia al de menos: es el que hay que editar.
 */
function layerDefining(layers: ConfigLayer[], path: (string | number)[]): string | null {
  for (let len = path.length; len > 0; len--) {
    const prefix = path.slice(0, len);
    for (let i = layers.length - 1; i >= 0; i--) {
      if (hasPath(layers[i]!.raw, prefix)) return layers[i]!.path;
    }
  }
  return null;
}

function hasPath(obj: unknown, path: (string | number)[]): boolean {
  let current = obj;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = (current as Record<string, unknown>)[key as string];
  }
  return true;
}

/** Avisos del loader (claves obsoletas, variables no definidas), pendientes de emitir. */
const pendingWarnings: string[] = [];
/** Tope de avisos acumulados sin emitir (un proceso que recarga sin consumirlos). */
const MAX_PENDING_WARNINGS = 50;

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
  pushWarning(
    `${source}: "ssh.auditLog" está obsoleto desde el Hito 16; usa "tools.auditLog" ` +
      '(la auditoría cubre ahora todos los comandos, locales y remotos).',
  );
  return {
    ...layer,
    ssh: restSsh,
    tools: 'auditLog' in tools ? tools : { ...tools, auditLog: legacy },
  };
}

function pushWarning(message: string): void {
  if (pendingWarnings.includes(message)) return;
  if (pendingWarnings.length >= MAX_PENDING_WARNINGS) pendingWarnings.shift();
  pendingWarnings.push(message);
}

/**
 * Devuelve y vacía los avisos del loader: claves obsoletas y variables de
 * entorno no definidas (se emiten tras configurar el logging).
 */
export function takeConfigDeprecations(): string[] {
  return pendingWarnings.splice(0, pendingWarnings.length);
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

function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  return norm(a) === norm(b);
}

export function loadConfig(startDir?: string): StratumConfig {
  const searchDir = startDir ?? process.cwd();
  const layers: ConfigLayer[] = [];

  // 1. Config global (~/.stratum/.stratumrc.json)
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    layers.push({ path: GLOBAL_CONFIG_PATH, raw: readConfigFile(GLOBAL_CONFIG_PATH) });
  }

  // 2. Config de proyecto (sube desde cwd hasta encontrar uno). Desde
  // ~/.stratum la búsqueda encuentra la global: no se carga dos veces.
  const projectConfigPath = findConfigFile(searchDir);
  if (projectConfigPath && !samePath(projectConfigPath, GLOBAL_CONFIG_PATH)) {
    layers.push({ path: projectConfigPath, raw: readConfigFile(projectConfigPath) });
  }

  return buildConfig(layers, { warn: true });
}

/**
 * Valida el contenido que se va a escribir en `path` tal como lo verá el
 * loader: una capa de proyecto se valida fusionada con la global (una clave
 * suya puede apoyarse en la global, p. ej. un `jumpHost` definido allí), y la
 * global sola, porque es la config de cualquier otro directorio. Lanza
 * `ConfigError` si no es válida.
 */
export function validateConfigLayer(
  path: string,
  raw: Record<string, unknown>,
  globalPath: string = GLOBAL_CONFIG_PATH,
): StratumConfig {
  const layers: ConfigLayer[] = [];
  if (!samePath(path, globalPath) && existsSync(globalPath)) {
    layers.push({ path: globalPath, raw: readConfigFile(globalPath) });
  }
  layers.push({ path, raw });
  return buildConfig(layers, { warn: false });
}

import { existsSync } from 'fs';
import { z } from 'zod';
import { GLOBAL_CONFIG_PATH, isGlobalOnlyKey, readConfigFile } from './loader.js';
import { StratumConfigSchema } from './schema.js';
import { assignByDotPath, coerceConfigText, getByDotPath, unsetByDotPath } from './dot-path.js';
import { writeConfigWithBackup } from './writer.js';
import { projectConfigTarget } from './project-preset.js';

/**
 * Lógica de `stratum config` interactivo (sin React): qué tipo de editor lleva
 * cada clave (sale del schema de Zod), de qué capa viene su valor y cómo se
 * escribe. Se lee siempre el JSON **crudo** de cada capa: un `${VAR}` se
 * enseña y se guarda tal cual, nunca expandido.
 */

export type ConfigScope = 'project' | 'global';

export type FieldKind =
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'number'; int: boolean; min?: number; max?: number }
  | { kind: 'string' }
  /** Unión de tipos simples (`'auto' | número`, `booleano | ruta`): texto con coerción. */
  | { kind: 'mixed' }
  | { kind: 'object'; keys: string[] }
  /** Listas, mapas y demás: se enseñan, se editan en el fichero. */
  | { kind: 'complex' };

type AnyZod = z.ZodTypeAny;

/** Quita los envoltorios que no cambian el tipo editable (default, opcional, refine). */
function unwrap(schema: AnyZod): AnyZod {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodDefault) s = s._def.innerType;
    else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodEffects) s = s._def.schema;
    else return s;
  }
}

/** El schema de una clave dot-path, o `undefined` si no existe. */
export function schemaAt(key: string, root: AnyZod = StratumConfigSchema): AnyZod | undefined {
  let current: AnyZod = root;
  if (key === '') return current;
  for (const part of key.split('.')) {
    const s = unwrap(current);
    if (!(s instanceof z.ZodObject)) return undefined;
    const next = (s.shape as Record<string, AnyZod>)[part];
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function literalOptions(schema: AnyZod): string[] | null {
  const s = unwrap(schema);
  if (s instanceof z.ZodEnum) return [...(s.options as string[])];
  if (s instanceof z.ZodLiteral && typeof s.value === 'string') return [s.value];
  return null;
}

export function fieldKind(schema: AnyZod): FieldKind {
  const s = unwrap(schema);
  if (s instanceof z.ZodBoolean) return { kind: 'boolean' };
  if (s instanceof z.ZodString) return { kind: 'string' };
  if (s instanceof z.ZodNumber) {
    const kind: FieldKind = { kind: 'number', int: false };
    for (const check of s._def.checks) {
      if (check.kind === 'int') kind.int = true;
      if (check.kind === 'min') kind.min = check.value;
      if (check.kind === 'max') kind.max = check.value;
    }
    return kind;
  }
  const options = literalOptions(s);
  if (options) return { kind: 'enum', options };
  if (s instanceof z.ZodUnion) {
    const members = s.options as AnyZod[];
    const all = members.map(literalOptions);
    if (all.every((o) => o !== null)) return { kind: 'enum', options: all.flat() as string[] };
    const simple = members.every((m) => {
      const u = unwrap(m);
      return (
        u instanceof z.ZodBoolean ||
        u instanceof z.ZodString ||
        u instanceof z.ZodNumber ||
        u instanceof z.ZodLiteral
      );
    });
    return simple ? { kind: 'mixed' } : { kind: 'complex' };
  }
  if (s instanceof z.ZodObject) return { kind: 'object', keys: Object.keys(s.shape) };
  return { kind: 'complex' };
}

// ---------------------------------------------------------------------------
// Catálogo de secciones
// ---------------------------------------------------------------------------

export interface FieldInfo {
  key: string;
  label: string;
  help?: string;
}

export interface SectionInfo {
  id: string;
  label: string;
  fields: FieldInfo[];
  /** Solo cuenta en la config global (sus claves están en `GLOBAL_ONLY_KEYS`). */
  globalOnly?: boolean;
}

export const CONFIG_SECTIONS: readonly SectionInfo[] = [
  {
    id: 'agent',
    label: 'Agente',
    fields: [
      { key: 'agent.maxIterations', label: 'Turnos máximos por tarea' },
      { key: 'agent.maxToolRetries', label: 'Reintentos de una tool que falla' },
      {
        key: 'agent.compressionThreshold',
        label: 'Comprimir el historial al llenar (0–1)',
        help: 'Fracción de la ventana de contexto a partir de la que se resume lo antiguo.',
      },
      { key: 'agent.compressionKeepRounds', label: 'Rondas recientes que no se comprimen' },
      {
        key: 'tools.testCommand',
        label: 'Comando de tests (activa TDD estricto)',
        help: 'Vacío = sin `test_evidence` ni disciplina de tests en el prompt.',
      },
      {
        key: 'prompt.guides',
        label: 'Guías del prompt',
        help: '`inline` las manda en cada petición; `pointers` las deja en ficheros (modelos capaces).',
      },
    ],
  },
  {
    id: 'agents',
    label: 'Subagentes',
    fields: [
      { key: 'agents.defaultProfile', label: 'Perfil por defecto de delegate_task' },
      { key: 'agents.maxConcurrency', label: 'Subagentes a la vez' },
      { key: 'agents.subagentMaxIterations', label: 'Turnos máximos de un subagente' },
      {
        key: 'agents.subagentTimeoutMs',
        label: 'Tiempo máximo de un subagente (ms)',
        help: '0 = sin límite.',
      },
      { key: 'agents.subagentRetentionDays', label: 'Días que se guardan sus registros' },
    ],
  },
  {
    id: 'memory',
    label: 'Memoria',
    fields: [
      { key: 'memory.projectFile', label: 'STRATUM.md del proyecto' },
      {
        key: 'memory.decisionsFile',
        label: 'Decisiones del proyecto',
        help: 'Relativa = desde la raíz del repo.',
      },
      {
        key: 'memory.vectorDb',
        label: 'Índice vectorial del proyecto',
        help: 'Relativa = desde la raíz del repo.',
      },
      { key: 'memory.autoExtract', label: 'Extraer decisiones tras cada respuesta' },
      { key: 'memory.retrievalTopK', label: 'Decisiones que se recuperan por consulta' },
      { key: 'memory.similarityThreshold', label: 'Umbral de duplicado (0–1)' },
      { key: 'memory.session.enabled', label: 'Memoria de sesión (daemon)' },
      {
        key: 'memory.session.allowRemote',
        label: 'Permitir un provider remoto para la memoria de sesión',
      },
    ],
  },
  {
    id: 'tools',
    label: 'Herramientas y seguridad',
    fields: [
      { key: 'tools.confirmDestructive', label: 'Confirmar operaciones destructivas' },
      { key: 'tools.bashTimeout', label: 'Plazo de un comando (ms)' },
      {
        key: 'tools.auditLog',
        label: 'Auditoría de comandos',
        help: '`true` = ~/.stratum/logs/exec-audit.jsonl, una ruta, o `false`.',
      },
      { key: 'tools.jobs.enabled', label: 'Jobs en segundo plano' },
      { key: 'tools.jobs.maxRunning', label: 'Jobs a la vez' },
      { key: 'tools.webSearch.backend', label: 'Buscador web' },
      { key: 'tools.webSearch.maxResults', label: 'Resultados por búsqueda' },
      { key: 'tools.browser.enabled', label: 'Navegador del agente' },
      { key: 'tools.browser.idleMinutes', label: 'Minutos sin uso antes de cerrar el navegador' },
    ],
  },
  {
    id: 'snapshots',
    label: 'Deshacer (/undo, /rewind)',
    fields: [
      { key: 'snapshots.enabled', label: 'Guardar una copia por turno' },
      { key: 'snapshots.retentionDays', label: 'Días que se conservan' },
    ],
  },
  {
    id: 'lsp',
    label: 'Diagnósticos LSP',
    fields: [
      { key: 'lsp.enabled', label: 'Diagnósticos tras editar' },
      { key: 'lsp.severity', label: 'Nivel mínimo que se informa' },
    ],
  },
  {
    id: 'ui',
    label: 'Interfaz, logs y traza',
    fields: [
      { key: 'tui.verbosity', label: 'Detalle de los turnos cerrados' },
      {
        key: 'tui.background',
        label: 'Fondo del terminal',
        help: '`#rrggbb`, o `terminal` para dejar el tuyo.',
      },
      { key: 'logging.level', label: 'Nivel de log' },
      { key: 'logging.file.enabled', label: 'Guardar logs en fichero' },
      { key: 'trace.enabled', label: 'Grabar la traza de cada sesión' },
      { key: 'trace.retentionDays', label: 'Días que se guardan las trazas' },
    ],
  },
  {
    id: 'box',
    label: 'Caja y asistente',
    globalOnly: true,
    fields: [
      { key: 'box.enabled', label: 'Caja (contenedor del asistente)' },
      { key: 'box.runtime', label: 'Runtime de contenedores' },
      { key: 'box.network', label: 'Red de salida en la caja' },
      {
        key: 'trace.screenshots',
        label: 'Guardar capturas de la caja en la traza',
        help: 'Imágenes sin redactar.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Capas y valores
// ---------------------------------------------------------------------------

export interface ConfigLayers {
  globalPath: string;
  global: Record<string, unknown>;
  projectPath: string;
  /** `{}` si el fichero de proyecto aún no existe. */
  project: Record<string, unknown>;
  projectExists: boolean;
}

export function readConfigLayers(
  cwd: string,
  globalPath: string = GLOBAL_CONFIG_PATH,
): ConfigLayers {
  const target = projectConfigTarget(cwd, globalPath);
  return {
    globalPath,
    global: existsSync(globalPath) ? readConfigFile(globalPath) : {},
    projectPath: target.path,
    project: target.exists ? readConfigFile(target.path) : {},
    projectExists: target.exists,
  };
}

export type ValueOrigin = 'project' | 'global' | 'default' | 'unset';

export interface FieldValue {
  value: unknown;
  origin: ValueOrigin;
  /** Lo que hay en el fichero que se está editando (`undefined` = no lo declara). */
  inScope: unknown;
  /** El valor que quedaría al quitarlo del fichero que se está editando. */
  inherited: unknown;
  inheritedOrigin: ValueOrigin;
}

let defaultsCache: Record<string, unknown> | null = null;
function defaults(): Record<string, unknown> {
  defaultsCache ??= StratumConfigSchema.parse({}) as Record<string, unknown>;
  return defaultsCache;
}

export function fieldValue(layers: ConfigLayers, key: string, scope: ConfigScope): FieldValue {
  const fromProject = isGlobalOnlyKey(key) ? undefined : getByDotPath(layers.project, key);
  const fromGlobal = getByDotPath(layers.global, key);
  const fromDefault = getByDotPath(defaults(), key);

  const pick = (candidates: [unknown, ValueOrigin][]): [unknown, ValueOrigin] =>
    candidates.find(([v]) => v !== undefined) ?? [undefined, 'unset'];

  const [value, origin] = pick([
    [fromProject, 'project'],
    [fromGlobal, 'global'],
    [fromDefault, 'default'],
  ]);
  const [inherited, inheritedOrigin] =
    scope === 'project'
      ? pick([
          [fromGlobal, 'global'],
          [fromDefault, 'default'],
        ])
      : pick([[fromDefault, 'default']]);
  return {
    value,
    origin,
    inScope: scope === 'project' ? fromProject : fromGlobal,
    inherited,
    inheritedOrigin,
  };
}

const SECRET_KEY = /(apikey|token|password|passphrase|secret)$/i;

/** El valor para enseñarlo: los secretos literales se tapan, un `${VAR}` se enseña. */
export function displayValue(key: string, value: unknown): string {
  if (value === undefined) return '(sin definir)';
  if (typeof value === 'string') {
    if (value === '') return '""';
    if (SECRET_KEY.test(key) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return '••••••';
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const json = JSON.stringify(value);
    return json.length > 60 ? json.slice(0, 57) + '…' : json;
  }
  return String(value);
}

export const ORIGIN_LABEL: Record<ValueOrigin, string> = {
  project: 'proyecto',
  global: 'global',
  default: 'por defecto',
  unset: 'sin definir',
};

/**
 * Convierte el texto tecleado al valor de la clave y lo valida contra su
 * schema. Devuelve el valor o un mensaje de error legible.
 */
export function parseFieldInput(
  key: string,
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = schemaAt(key);
  if (!schema) return { ok: false, error: `La clave ${key} no existe.` };
  const kind = fieldKind(schema);
  let value: unknown;
  switch (kind.kind) {
    case 'number':
      if (text.trim() === '' || isNaN(Number(text)))
        return { ok: false, error: 'Tiene que ser un número.' };
      value = Number(text);
      break;
    case 'string':
      value = text;
      break;
    case 'mixed':
      value = coerceConfigText(text);
      break;
    case 'boolean':
      if (text !== 'true' && text !== 'false') return { ok: false, error: 'true o false.' };
      value = text === 'true';
      break;
    case 'enum':
      if (!kind.options.includes(text))
        return { ok: false, error: `Uno de: ${kind.options.join(', ')}.` };
      value = text;
      break;
    default:
      return { ok: false, error: 'Esta clave se edita en el fichero.' };
  }
  const result = unwrap(schema).safeParse(value);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value };
}

export interface WriteFieldResult {
  path: string;
  backupPath: string | null;
}

/**
 * Fija (o, con `undefined`, quita para que se herede) una clave en el fichero
 * del ámbito. Valida el resultado como lo verá el loader antes de tocar el
 * disco y deja un `.bak` del anterior. Una clave solo global no se escribe en
 * un proyecto: ahí el loader la ignoraría.
 */
export function writeField(
  layers: ConfigLayers,
  scope: ConfigScope,
  key: string,
  value: unknown,
): WriteFieldResult {
  if (scope === 'project' && isGlobalOnlyKey(key)) {
    throw new Error(`${key} solo cuenta en la config global (${layers.globalPath}).`);
  }
  const path = scope === 'project' ? layers.projectPath : layers.globalPath;
  const raw = structuredClone(scope === 'project' ? layers.project : layers.global);
  if (value === undefined) unsetByDotPath(raw, key);
  else assignByDotPath(raw, key, value);
  const backupPath = writeConfigWithBackup(path, raw, layers.globalPath);
  return { path, backupPath };
}

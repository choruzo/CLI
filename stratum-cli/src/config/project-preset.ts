import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from 'path';
import { z } from 'zod';
import {
  CONFIG_FILENAME,
  findConfigFile,
  GLOBAL_CONFIG_PATH,
  readConfigFile,
  samePath,
  validateConfigLayer,
} from './loader.js';
import { findWorktreeRoot } from './paths.js';
import { StratumConfigSchema, type StratumConfig } from './schema.js';
import { stripBom } from './json-text.js';
import { writeFileAtomic } from './writer.js';

/**
 * Config de proyecto mínima: lo que `stratum init` escribe y lo que `chat`
 * ofrece crear la primera vez que se abre en una carpeta sin config propia.
 *
 * Sin provider ni nada más: todo lo demás sigue saliendo de la global. Los
 * turnos del agente y de los subagentes se copian de la config efectiva en el
 * momento de crearla (crear el fichero no cambia cómo se comporta Stratum,
 * solo los deja a mano para ajustarlos por proyecto). La memoria va siempre a
 * las rutas relativas del proyecto, aunque la global la apunte a otro sitio:
 * `loadConfig` las ancla a la raíz del repo (`anchorMemoryPaths`).
 */
export function buildProjectPreset(effective: StratumConfig): Record<string, unknown> {
  return {
    agent: { maxIterations: effective.agent.maxIterations },
    agents: {
      maxConcurrency: effective.agents.maxConcurrency,
      subagentMaxIterations: effective.agents.subagentMaxIterations,
    },
    memory: {
      projectFile: './STRATUM.md',
      decisionsFile: './.stratum/memory/decisions.json',
      vectorDb: './.stratum/memory/vectors.db',
    },
  };
}

/** La config global validada sola, o los defaults si no hay. */
export function effectiveGlobalConfig(globalPath: string = GLOBAL_CONFIG_PATH): StratumConfig {
  if (!existsSync(globalPath)) return StratumConfigSchema.parse({});
  return validateConfigLayer(globalPath, readConfigFile(globalPath), globalPath);
}

export interface ProjectConfigTarget {
  path: string;
  /** Ya hay un `.stratumrc.json` de proyecto (en `cwd` o más arriba). */
  exists: boolean;
}

/**
 * El `.stratumrc.json` de proyecto que corresponde a `cwd`: el más cercano
 * hacia arriba que no sea el global, o uno nuevo en la raíz del repo (o en
 * `cwd` si no hay repo), donde vive también su memoria.
 */
export function projectConfigTarget(
  cwd: string,
  globalPath: string = GLOBAL_CONFIG_PATH,
): ProjectConfigTarget {
  const found = findConfigFile(cwd);
  if (found && !samePath(found, globalPath)) return { path: found, exists: true };
  return { path: join(findWorktreeRoot(cwd).worktree, CONFIG_FILENAME), exists: false };
}

/**
 * Escribe el preset en `path` si no existe. Se valida fusionado con la global,
 * como lo verá el loader. Devuelve `false` si ya había fichero (no se toca).
 */
export function writeProjectPreset(path: string, globalPath: string = GLOBAL_CONFIG_PATH): boolean {
  if (existsSync(path)) return false;
  const preset = buildProjectPreset(effectiveGlobalConfig(globalPath));
  validateConfigLayer(path, preset, globalPath);
  writeFileAtomic(path, JSON.stringify(preset, null, 2) + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// Carpetas en las que se dijo que no
// ---------------------------------------------------------------------------

const PROMPT_STATE_VERSION = 1;

const PromptStateSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  declined: z.array(z.string()).default([]),
});

export const PROJECT_PROMPT_STATE_PATH = join(
  dirname(GLOBAL_CONFIG_PATH),
  'state',
  'project-config.json',
);

/** `null` = fichero ilegible o de un Stratum más nuevo: ni se pregunta ni se reescribe. */
function readPromptState(statePath: string): { declined: string[] } | null {
  if (!existsSync(statePath)) return { declined: [] };
  try {
    const parsed = PromptStateSchema.safeParse(
      JSON.parse(stripBom(readFileSync(statePath, 'utf-8'))),
    );
    if (!parsed.success) return null;
    if ((parsed.data.schemaVersion ?? 1) > PROMPT_STATE_VERSION) return null;
    return { declined: parsed.data.declined };
  } catch {
    return null;
  }
}

function dirKey(dir: string): string {
  const abs = resolve(dir);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Recuerda que en `dir` no se quiere config de proyecto: `chat` no vuelve a preguntar. */
export function declineProjectPreset(
  dir: string,
  statePath: string = PROJECT_PROMPT_STATE_PATH,
): void {
  const state = readPromptState(statePath);
  if (!state) return;
  const key = dirKey(dir);
  if (state.declined.includes(key)) return;
  writeFileAtomic(
    statePath,
    JSON.stringify(
      { schemaVersion: PROMPT_STATE_VERSION, declined: [...state.declined, key] },
      null,
      2,
    ) + '\n',
  );
}

export interface PresetOfferOptions {
  globalPath?: string;
  statePath?: string;
  home?: string;
}

/**
 * Si `chat` debe ofrecer crear la config de proyecto: devuelve dónde, o `null`.
 * No se ofrece si ya hay una (aquí o más arriba), si ya se dijo que no en esa
 * carpeta, ni en el home, la raíz del disco o `~/.stratum`, que no son proyectos.
 */
export function projectPresetOffer(cwd: string, opts: PresetOfferOptions = {}): string | null {
  const globalPath = opts.globalPath ?? GLOBAL_CONFIG_PATH;
  const target = projectConfigTarget(cwd, globalPath);
  if (target.exists) return null;

  const dir = dirname(target.path);
  if (samePath(dir, opts.home ?? homedir())) return null;
  if (samePath(dir, parsePath(resolve(dir)).root)) return null;
  const fromStratumDir = relative(dirname(globalPath), dir);
  if (!fromStratumDir.startsWith('..') && !isAbsolute(fromStratumDir)) return null;

  const state = readPromptState(opts.statePath ?? PROJECT_PROMPT_STATE_PATH);
  if (!state || state.declined.includes(dirKey(dir))) return null;
  return target.path;
}

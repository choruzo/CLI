import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, parse, resolve, sep } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { writeFileAtomic } from '../config/writer.js';
import type { WorkspaceConfinement } from '../agent/types.js';
import { ASSISTANT_FILE_TOOLS, ASSISTANT_TOOLS } from '../agent/presets.js';
import { ToolRegistry } from '../tools/registry.js';
import { webSearchTool } from '../tools/web/search.js';
import { webFetchTool } from '../tools/web/fetch.js';
import { storeDecisionTool } from '../tools/memory/store-decision.js';
import { recallDecisionsTool } from '../tools/memory/recall-decisions.js';
import { questionTool } from '../tools/question.js';
import { todoTool } from '../tools/todo.js';
import { readFileTool } from '../tools/fs/read.js';
import { writeFileTool } from '../tools/fs/write.js';
import { editFileTool } from '../tools/fs/edit.js';
import { globTool } from '../tools/fs/glob.js';
import { grepTool } from '../tools/fs/grep.js';
import { listDirectoryTool } from '../tools/fs/list.js';
import { getLogger } from '../logging/index.js';

/**
 * El agente embebido `assistant` (M12): el modo Chat que nació en Stratum
 * Desktop (D1–D2), ahora como una sesión Stratum normal que cualquier cliente
 * abre con `sessions.open { agent: 'assistant', cwd }`. Lo monta
 * `SessionHost.create` (`preset: 'assistant'`), nunca otro cableado.
 *
 * Qué cambia respecto a una sesión de código: el prompt (`promptPreset`), las
 * tools (solo `ASSISTANT_TOOLS` + `ASSISTANT_FILE_TOOLS`; `exec` nunca), los
 * ficheros confinados al directorio de la sesión (`inputs/` de solo lectura,
 * escritura solo en `outputs/` y `scratch/`), sin skills, MCP ni perfiles, y
 * una memoria de decisiones propia del asistente, separada de la de cualquier
 * proyecto.
 */

const log = getLogger('host').child('assistant');

/** Dónde guarda el asistente lo suyo y de dónde lo migra (ver `SessionHostOptions`). */
export interface AssistantData {
  dir: string;
  legacyMemoryDir?: string | null;
}

/** Subcarpetas del directorio de una sesión del asistente. */
export const ASSISTANT_DIRS = { inputs: 'inputs', outputs: 'outputs', scratch: 'scratch' } as const;

/** Datos del asistente (su memoria de decisiones): `~/.stratum/assistant/`. */
export function assistantDataDir(home: string = homedir()): string {
  return join(home, '.stratum', 'assistant');
}

/** Dónde guardaba Stratum Desktop esa memoria antes de M12. */
export function legacyAssistantMemoryDir(home: string = homedir()): string {
  return join(home, '.stratum', 'desktop', 'memory');
}

/** Versión de la migración de la memoria del asistente (fichero marca). */
export const ASSISTANT_MEMORY_MIGRATION = 1;
const MIGRATION_MARK = '.migrated-from-desktop';
const MEMORY_FILES = ['decisions.json', 'vectors.db'] as const;

/**
 * Migración **única** de la memoria del asistente desde `~/.stratum/desktop/memory/`
 * (D1–D7). Copia, nunca mueve: lo de Desktop queda donde estaba y no se vuelve
 * a leer. Solo si el destino aún no existe: después, la única fuente es la
 * nueva. Se copia en una carpeta aparte que se renombra al final, así que un
 * corte a mitad no deja una memoria a medias como si fuera la buena. Un fallo
 * no impide abrir la sesión (empieza con memoria vacía y se reintenta la
 * próxima vez).
 */
export function migrateLegacyAssistantMemory(dataDir: string, legacyDir: string): void {
  const target = join(dataDir, 'memory');
  if (existsSync(target)) return;
  const staging = join(dataDir, `.memory-migrating-${process.pid}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    let copied = 0;
    for (const name of MEMORY_FILES) {
      const from = join(legacyDir, name);
      if (existsSync(from)) {
        copyFileSync(from, join(staging, name));
        copied++;
      }
    }
    writeFileAtomic(
      join(staging, MIGRATION_MARK),
      JSON.stringify({ version: ASSISTANT_MEMORY_MIGRATION, from: legacyDir, copied }) + '\n',
    );
    renameSync(staging, target);
    if (copied > 0) log.info('assistant memory migrated from Stratum Desktop', { copied });
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    log.warn('assistant memory migration failed', { err });
  }
}

/**
 * Config de una sesión del asistente a partir de la de su directorio. La
 * memoria de decisiones es **del asistente**: lo que se le cuenta no aparece
 * en un `recall_decisions` de un repositorio, ni al revés.
 */
export function buildAssistantConfig(base: StratumConfig, dataDir: string): StratumConfig {
  return {
    ...base,
    memory: {
      ...base.memory,
      decisionsFile: join(dataDir, 'memory', 'decisions.json'),
      vectorDb: join(dataDir, 'memory', 'vectors.db'),
    },
    // Sin skills ni guías materializadas: presuponen un proyecto y escribirían
    // ficheros en el directorio de la sesión.
    skills: { ...base.skills, enabled: false },
    prompt: { ...base.prompt, guides: 'inline' },
  };
}

/**
 * Registry del asistente: solo sus tools. El filtro del preset ya las
 * restringe en el loop; no registrar el resto es defensa en profundidad.
 * `exec` no se registra nunca (16.1: un directorio no confina un shell).
 */
export function buildAssistantRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webFetchTool,
    storeDecisionTool,
    recallDecisionsTool,
    questionTool,
    todoTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    listDirectoryTool,
  ]) {
    registry.register(tool);
  }
  const missing = [...ASSISTANT_TOOLS, ...ASSISTANT_FILE_TOOLS].filter(
    (name) => !registry.get(name),
  );
  if (missing.length > 0) throw new Error(`faltan tools del asistente: ${missing.join(', ')}`);
  return registry;
}

/**
 * Confinamiento de los ficheros de una sesión del asistente: su directorio.
 * Crea `outputs/` y `scratch/` si faltan (son donde puede escribir).
 */
export function assistantWorkspace(cwd: string): WorkspaceConfinement {
  for (const dir of [ASSISTANT_DIRS.outputs, ASSISTANT_DIRS.scratch]) {
    mkdirSync(join(cwd, dir), { recursive: true });
  }
  return {
    root: cwd,
    readOnly: [ASSISTANT_DIRS.inputs],
    writable: [ASSISTANT_DIRS.outputs, ASSISTANT_DIRS.scratch],
  };
}

/**
 * Por qué un directorio no vale para una sesión del asistente, o `null`. El
 * asistente lee todo lo que hay bajo su directorio: tiene que ser uno elegido
 * para él (Desktop crea una carpeta por conversación), nunca el home, un
 * ancestro suyo ni la raíz de una unidad. Falla cerrado.
 */
export function assistantCwdProblem(cwd: string, home: string = homedir()): string | null {
  const abs = resolve(cwd);
  if (parse(abs).root === abs || parse(abs).root === `${abs}${sep}`) {
    return 'the assistant cannot work at the root of a drive';
  }
  const norm = (p: string): string => {
    const r = resolve(p) + sep;
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  if (norm(home).startsWith(norm(abs))) {
    return 'the assistant needs its own directory, not the home directory or one that contains it';
  }
  return null;
}

import { homedir } from 'os';
import { join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { ToolRegistry } from '../tools/registry.js';
import { webSearchTool } from '../tools/web/search.js';
import { webFetchTool } from '../tools/web/fetch.js';
import { storeDecisionTool } from '../tools/memory/store-decision.js';
import { recallDecisionsTool } from '../tools/memory/recall-decisions.js';
import { questionTool } from '../tools/question.js';
import { todoTool } from '../tools/todo.js';
import { ASSISTANT_FILE_TOOLS, ASSISTANT_TOOLS } from '../agent/presets.js';
import { readFileTool } from '../tools/fs/read.js';
import { writeFileTool } from '../tools/fs/write.js';
import { editFileTool } from '../tools/fs/edit.js';
import { globTool } from '../tools/fs/glob.js';
import { grepTool } from '../tools/fs/grep.js';
import { listDirectoryTool } from '../tools/fs/list.js';

/**
 * Piezas del modo Chat de Stratum Desktop que no son del core (D1): dónde viven
 * los datos del asistente y qué tools se registran.
 */

/** Datos de Stratum Desktop: `~/.stratum/desktop/`. */
export function desktopDataDir(home: string = homedir()): string {
  return join(home, '.stratum', 'desktop');
}

/**
 * Config del asistente a partir de la compartida con la CLI. La memoria de
 * largo plazo (decisiones + índice vectorial) es **del asistente**, separada de
 * la de cualquier proyecto: lo que el usuario le cuenta al asistente no aparece
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
    // El asistente no tiene skills ni guías: presuponen un proyecto, y
    // materializarlas escribiría ficheros en el cwd del sidecar.
    skills: { ...base.skills, enabled: false },
    prompt: { ...base.prompt, guides: 'inline' },
  };
}

/**
 * Registry del modo Chat: solo las tools de `ASSISTANT_TOOLS`. El filtro del
 * preset ya las restringe en el loop; no registrar el resto es defensa en
 * profundidad. Uno por conversación: las tools deshabilitadas por reintentos
 * viven en el registry y no pueden contagiarse entre conversaciones.
 *
 * `files` (D2) añade las tools de fichero: solo para una conversación con
 * workspace, que es lo que las confina. `exec` no se registra nunca (16.1).
 */
export function buildAssistantRegistry(opts: { files?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webFetchTool,
    storeDecisionTool,
    recallDecisionsTool,
    questionTool,
    todoTool,
  ]) {
    registry.register(tool);
  }
  if (opts.files) {
    for (const tool of [
      readFileTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      listDirectoryTool,
    ]) {
      registry.register(tool);
    }
  }
  const expected = opts.files ? [...ASSISTANT_TOOLS, ...ASSISTANT_FILE_TOOLS] : ASSISTANT_TOOLS;
  const missing = expected.filter((name) => !registry.get(name));
  if (missing.length > 0) throw new Error(`faltan tools del asistente: ${missing.join(', ')}`);
  return registry;
}

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { boxHasDesktop, type StratumConfig } from '../config/schema.js';
import { createScreenTools } from '../tools/screen/screen.js';
import { isScreenTool } from '../tools/screen/names.js';
import { COMPANION_TOOLS } from '../agent/presets.js';
import { ToolRegistry } from '../tools/registry.js';
import { webSearchTool } from '../tools/web/search.js';
import { webFetchTool } from '../tools/web/fetch.js';
import { storeDecisionTool } from '../tools/memory/store-decision.js';
import { recallDecisionsTool } from '../tools/memory/recall-decisions.js';
import { readSkillTool } from '../tools/skills/read-skill.js';
import { questionTool } from '../tools/question.js';
import { todoTool } from '../tools/todo.js';
import { createExecTool, EXEC_TOOL } from '../tools/exec/exec.js';
import { createSendImageTool, SEND_IMAGE_TOOL } from '../tools/share/send-image.js';
import { sharedImagesDir } from '../images/shared.js';
import type { ExecutionTarget } from '../tools/exec/target.js';
import {
  createProposeRoutineTool,
  PROPOSE_ROUTINE_TOOL,
  type RoutineProposals,
} from '../tools/routines/propose.js';

/**
 * El agente embebido `companion` (M14, PRD de Stratum Dot §23): el asistente
 * de Dot. Una sesión Stratum normal que se abre con `sessions.open { agent:
 * 'companion' }` y monta `SessionHost.create` (`preset: 'companion'`), nunca
 * otro cableado.
 *
 * Frente al `assistant` de Desktop: no toca ningún fichero del anfitrión (no
 * tiene carpeta de conversación), tiene `exec` **solo** contra su caja
 * (`container:<caja>`, el radio de daños de M13) y su memoria es la suya
 * (`~/.stratum/companion/`), que no ve ni el asistente ni ningún proyecto.
 * Sin caja habilitada, no hay `exec`: trabaja como el asistente sin carpeta.
 */

/** Datos del `companion`: `~/.stratum/companion/` (memoria, `STRATUM.md`, intercambio). */
export function companionDataDir(home: string = homedir()): string {
  return join(home, '.stratum', 'companion');
}

/**
 * Directorio de trabajo de una sesión del `companion`: dentro de sus datos,
 * nunca el del proceso que lo aloja. No hay nada que leer ahí (no tiene tools
 * de fichero); ancla lo que cuelga del `cwd` de una sesión (planes, traza,
 * config de proyecto, que aquí no existe).
 */
export function companionWorkspaceDir(dataDir: string = companionDataDir()): string {
  return join(dataDir, 'workspace');
}

/** Crea el directorio de trabajo del `companion` si falta y lo devuelve. */
export function ensureCompanionWorkspace(dataDir: string = companionDataDir()): string {
  const dir = companionWorkspaceDir(dataDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** El único target de `exec` del `companion`, o `null` sin caja habilitada. */
export function companionExecTarget(config: StratumConfig): ExecutionTarget | null {
  return config.box?.enabled ? { kind: 'container', name: config.box.name } : null;
}

/**
 * Config de una sesión del `companion`. Su memoria es la suya: decisiones,
 * índice y `STRATUM.md` bajo `dataDir`. Sin inventario SSH. M17: sus servers
 * MCP son **solo** sus conectores (`companion.mcp.servers`, de la config
 * global), nunca los de `mcp.servers`; lo que declaran de solo lectura pasa a
 * `mcp.readOnlyTools` (y sustituye al global: no hereda declaraciones ajenas).
 */
export function buildCompanionConfig(base: StratumConfig, dataDir: string): StratumConfig {
  return {
    ...base,
    memory: {
      ...base.memory,
      decisionsFile: join(dataDir, 'memory', 'decisions.json'),
      vectorDb: join(dataDir, 'memory', 'vectors.db'),
      globalFile: join(dataDir, 'STRATUM.md'),
    },
    ...(base.ssh ? { ssh: { ...base.ssh, hosts: {} } } : {}),
    mcp: {
      ...base.mcp,
      servers: base.companion.mcp.servers.map(({ readOnlyTools: _ro, ...server }) => server),
      readOnlyTools: Object.fromEntries(
        base.companion.mcp.servers
          .filter((s) => s.readOnlyTools.length > 0)
          .map((s) => [s.name, [...s.readOnlyTools]]),
      ),
    },
    // Como el asistente: sin guías materializadas (presuponen un proyecto).
    prompt: { ...base.prompt, guides: 'inline' },
  };
}

/**
 * Registry del `companion`: solo sus tools. `exec` va atado a su caja
 * (`onlyTarget`: cualquier otro target se veta en `preflight`) y solo existe
 * con la caja habilitada. M16: `propose_routine` solo con `routines` (la
 * sesión principal en el daemon; nunca una sesión de rutina).
 */
export function buildCompanionRegistry(
  config: StratumConfig,
  opts: { routines?: RoutineProposals; dataDir?: string } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webFetchTool,
    storeDecisionTool,
    recallDecisionsTool,
    readSkillTool,
    questionTool,
    todoTool,
  ]) {
    registry.register(tool);
  }
  const box = companionExecTarget(config);
  if (box) registry.register(createExecTool(config, { onlyTarget: box }));
  // M15 — la pantalla de su caja, si la caja tiene escritorio. Que el modelo
  // tenga visión se decide por turno (`makeLoop`): el modelo puede cambiar.
  const screen = box !== null && box.kind === 'container' && boxHasDesktop(config.box);
  if (screen) for (const tool of createScreenTools(box)) registry.register(tool);
  // M18 parte 6E — enseñar una imagen en el chat: de `/exchange` o de la pantalla.
  if (box && box.kind === 'container') {
    const dataDir = opts.dataDir ?? companionDataDir();
    registry.register(
      createSendImageTool({
        exchangeDir: join(dataDir, 'exchange'),
        sharedDir: sharedImagesDir(dataDir),
        screen: screen ? box : null,
      }),
    );
  }
  if (opts.routines) registry.register(createProposeRoutineTool(opts.routines));
  const expected = COMPANION_TOOLS.filter(
    (name) =>
      (box !== null || (name !== EXEC_TOOL && name !== SEND_IMAGE_TOOL)) &&
      (screen || !isScreenTool(name)) &&
      (opts.routines !== undefined || name !== PROPOSE_ROUTINE_TOOL),
  );
  const missing = expected.filter((name) => !registry.get(name));
  if (missing.length > 0) throw new Error(`faltan tools del companion: ${missing.join(', ')}`);
  return registry;
}

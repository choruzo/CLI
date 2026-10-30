import type { ToolsetFilter } from '../tools/registry.js';
import type { ProtocolAgent } from '../protocol/index.js';
import { SCREEN_TOOLS } from '../tools/screen/names.js';

/**
 * Presets de prompt (Stratum Desktop D1, punto ciego 16.6).
 *
 * - `coding` (default): el agente de código de la CLI, sin ningún cambio.
 * - `assistant`: el asistente conversacional del modo Chat de Stratum Desktop.
 *   Sin repositorio de por medio: ni shell, ni ficheros del usuario, ni
 *   delegación, ni plan, ni TDD, ni `STRATUM.md` de proyecto.
 *
 * - `companion` (M14): el asistente de Stratum Dot. Como `assistant`, pero sin
 *   ficheros del usuario y con `exec` **solo** contra su caja (`container:<caja>`),
 *   y con su propia memoria (`~/.stratum/companion/`).
 *
 * El preset se resuelve en `StratumAgent.promptEnv()` (prompt) y en
 * `makeLoop()` (toolset), nunca en otro sitio: un segundo punto de decisión
 * acabaría filtrando el prompt de un modo al otro.
 */
export type PromptPreset = 'coding' | 'assistant' | 'companion';

/** Presets de un agente embebido (no de código): sin perfiles, guías ni proyecto. */
export function isEmbeddedPreset(preset: PromptPreset): boolean {
  return preset !== 'coding';
}

/**
 * M12 — nombre con el que una sesión pide el preset `assistant` al abrirse
 * (`sessions.open { agent: 'assistant' }`) y con el que se publica
 * (`ProtocolSession.agent`). No es un perfil de `ProfileLoader`: el preset se
 * fija al montar la sesión (`SessionHost`, `presetOf`) y no se cambia después.
 */
export const ASSISTANT_AGENT = 'assistant';

/**
 * Toolset del modo Chat. Se lista entero y sin `controlTools: 'keep'`: ese modo
 * dejaría pasar `present_plan`, `delegate_task` o `test_evidence`, que también
 * son tools de control.
 */
export const ASSISTANT_TOOLS: readonly string[] = [
  'web_search',
  'web_fetch',
  'question',
  'todo',
  'store_decision',
  'recall_decisions',
  'read_skill',
];

/**
 * Tools de fichero del modo Chat (D2). Solo se ofrecen con un workspace
 * confinado: sin él, leerían y escribirían el disco del usuario. `exec` no
 * está ni estará aquí mientras no haya aislamiento del SO (16.1): un directorio
 * no confina un shell.
 */
export const ASSISTANT_FILE_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'list_directory',
];

export function assistantToolsetFilter(opts: { workspace?: boolean } = {}): ToolsetFilter {
  return {
    allowedTools: opts.workspace ? [...ASSISTANT_TOOLS, ...ASSISTANT_FILE_TOOLS] : ASSISTANT_TOOLS,
  };
}

/**
 * M14 — nombre del agente embebido de Stratum Dot (`sessions.open { agent:
 * 'companion' }`, `ProtocolSession.agent`). Como `assistant`, no es un perfil.
 */
export const COMPANION_AGENT = 'companion';

/** Nombres de los agentes embebidos: un perfil con uno de ellos no se abre como perfil. */
export const EMBEDDED_AGENTS: readonly string[] = [ASSISTANT_AGENT, COMPANION_AGENT];

/** Preset de un agente embebido por su nombre, o `null` si es un perfil (o ninguno). */
export function embeddedPresetOf(
  agent: string | null | undefined,
): 'assistant' | 'companion' | null {
  if (agent === ASSISTANT_AGENT) return 'assistant';
  if (agent === COMPANION_AGENT) return 'companion';
  return null;
}

/** Nombre con el que se publica una sesión de un agente embebido, o `null` (coding). */
export function embeddedAgentName(preset: PromptPreset): string | null {
  return preset === 'assistant' ? ASSISTANT_AGENT : preset === 'companion' ? COMPANION_AGENT : null;
}

/**
 * Toolset del `companion`: el del asistente sin ficheros del anfitrión, más
 * `exec`, que su registry solo deja apuntar a su caja (`host/companion.ts`).
 * `exec` solo existe si la caja está habilitada: sin ella, el `companion`
 * trabaja como el asistente sin carpeta. M15: las `screen_*`, con una caja con
 * escritorio, y solo se ofrecen a un modelo con visión (`makeLoop`).
 */
export const COMPANION_TOOLS: readonly string[] = [...ASSISTANT_TOOLS, 'exec', ...SCREEN_TOOLS];

export function companionToolsetFilter(): ToolsetFilter {
  return { allowedTools: COMPANION_TOOLS };
}

/** M14 — cómo aparece el `companion` en `agents.list`. */
export function companionAgentInfo(): ProtocolAgent {
  return {
    name: COMPANION_AGENT,
    description:
      "Stratum Dot's assistant: web, its own memory and a shell and a screen only inside its own box. " +
      'It never runs commands on this machine.',
    mode: 'primary',
    origin: 'builtin',
    allowedTools: [...COMPANION_TOOLS],
  };
}

/** M12 — cómo aparece el asistente en `agents.list`. */
export function assistantAgentInfo(): ProtocolAgent {
  return {
    name: ASSISTANT_AGENT,
    description:
      'Conversational assistant: web, its own decisions memory and files confined to the session directory. No shell.',
    mode: 'primary',
    origin: 'builtin',
    allowedTools: [...ASSISTANT_TOOLS, ...ASSISTANT_FILE_TOOLS],
  };
}

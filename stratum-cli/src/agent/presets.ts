import type { ToolsetFilter } from '../tools/registry.js';

/**
 * Presets de prompt (Stratum Desktop D1, punto ciego 16.6).
 *
 * - `coding` (default): el agente de código de la CLI, sin ningún cambio.
 * - `assistant`: el asistente conversacional del modo Chat de Stratum Desktop.
 *   Sin repositorio de por medio: ni shell, ni ficheros del usuario, ni
 *   delegación, ni plan, ni TDD, ni `STRATUM.md` de proyecto.
 *
 * El preset se resuelve en `StratumAgent.promptEnv()` (prompt) y en
 * `makeLoop()` (toolset), nunca en otro sitio: un segundo punto de decisión
 * acabaría filtrando el prompt de un modo al otro.
 */
export type PromptPreset = 'coding' | 'assistant';

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
];

export function assistantToolsetFilter(): ToolsetFilter {
  return { allowedTools: ASSISTANT_TOOLS };
}

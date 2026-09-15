import type { StratumConfig } from '../config/schema.js';
import type { ToolRegistry } from './registry.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { editFileTool } from './fs/edit.js';
import { globTool } from './fs/glob.js';
import { listDirectoryTool } from './fs/list.js';
import { grepTool } from './fs/grep.js';
import { createExecTool } from './exec/exec.js';
import { webSearchTool } from './web/search.js';
import { webFetchTool } from './web/fetch.js';
import { storeDecisionTool } from './memory/store-decision.js';
import { recallDecisionsTool } from './memory/recall-decisions.js';
import { presentPlanTool } from './plan/present-plan.js';
import { updatePlanTool } from './plan/update-plan.js';
import { delegateTaskTool } from './agent/delegate.js';
import { questionTool } from './question.js';
import { todoTool } from './todo.js';
import { registerSshTools } from './ssh/index.js';
import { registerTddTools } from './tdd.js';

export function registerBuiltinTools(registry: ToolRegistry, config: StratumConfig): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(listDirectoryTool);
  registry.register(grepTool);
  // Hito 16 — ejecución unificada: `local` siempre, `ssh:<alias>` si hay inventario.
  // La descripción se genera con los targets de esta config.
  registry.register(createExecTool(config));
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(storeDecisionTool);
  registry.register(recallDecisionsTool);
  // Hito 2.5 (F7) — tanda única de preguntas: control, interceptada por el loop.
  registry.register(questionTool);
  // Hito 11 — lista de tareas del turno: control, interceptada por el loop.
  registry.register(todoTool);
  // Hito 7 — Plan & Execute: tools de control interceptadas por el ReactLoop.
  registry.register(presentPlanTool);
  registry.register(updatePlanTool);
  // Hito 8 — Multi-agente: tool de control de delegación interceptada por el loop.
  registry.register(delegateTaskTool);
  // Hito 9 — SSH nativo: solo si hay inventario configurado (§12.14).
  registerSshTools(registry, config);
  // Hito 13 — evidencia TDD: solo si hay `tools.testCommand` configurado.
  registerTddTools(registry, config);
}

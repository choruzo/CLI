import type { StratumConfig } from '../config/schema.js';
import type { ToolRegistry } from './registry.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { editFileTool } from './fs/edit.js';
import { globTool } from './fs/glob.js';
import { listDirectoryTool } from './fs/list.js';
import { grepTool } from './fs/grep.js';
import { bashTool } from './shell/bash.js';
import { webSearchTool } from './web/search.js';
import { webFetchTool } from './web/fetch.js';
import { storeDecisionTool } from './memory/store-decision.js';
import { recallDecisionsTool } from './memory/recall-decisions.js';
import { presentPlanTool } from './plan/present-plan.js';
import { updatePlanTool } from './plan/update-plan.js';

export function registerBuiltinTools(registry: ToolRegistry, _config: StratumConfig): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(listDirectoryTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(storeDecisionTool);
  registry.register(recallDecisionsTool);
  // Hito 7 — Plan & Execute: tools de control interceptadas por el ReactLoop.
  registry.register(presentPlanTool);
  registry.register(updatePlanTool);
}

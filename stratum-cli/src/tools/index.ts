import type { StratumConfig } from '../config/schema.js';
import type { ToolRegistry } from './registry.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { bashTool } from './shell/bash.js';

export function registerBuiltinTools(registry: ToolRegistry, _config: StratumConfig): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(bashTool);
}

import type { StratumConfig } from '../config/schema.js';
import type { ToolRegistry } from './registry.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { globTool } from './fs/glob.js';
import { listDirectoryTool } from './fs/list.js';
import { grepTool } from './fs/grep.js';
import { bashTool } from './shell/bash.js';

export function registerBuiltinTools(registry: ToolRegistry, _config: StratumConfig): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(globTool);
  registry.register(listDirectoryTool);
  registry.register(grepTool);
  registry.register(bashTool);
}

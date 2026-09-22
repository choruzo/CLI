import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { sensitivePathPreflight, sensitivePathNeedsConfirm } from './sensitive.js';
import { stringParam, workspaceExecuteGuard, workspacePathPreflight } from './confine.js';

const schema = z.object({
  path: z.string().describe('Absolute or relative path to write'),
  content: z.string().describe('Content to write to the file'),
});

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the given content. Parent directories are created automatically.',
  schema,
  destructive: false,

  preflight(params: unknown, ctx: ToolContext): ToolResult | null {
    return (
      workspacePathPreflight(stringParam(params, 'path'), ctx, 'write') ??
      sensitivePathPreflight(params, ctx)
    );
  },

  isDestructive(params: unknown, ctx: ToolContext): boolean {
    return sensitivePathNeedsConfirm(params, ctx);
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = schema.parse(params);
    const vetoed = workspaceExecuteGuard(path, ctx, 'write');
    if (vetoed) return vetoed;
    const target = resolve(ctx.cwd, path);
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
      return { ok: true, output: `File written: ${path} (${content.length} bytes)` };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write "${path}": ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

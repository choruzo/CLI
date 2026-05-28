import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

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

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = schema.parse(params);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf-8');
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

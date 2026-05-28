import { readFileSync } from 'fs';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

const schema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Starting line number (1-based, inclusive)'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to read'),
});

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Use offset and limit to read specific line ranges.',
  schema,
  destructive: false,

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { path, offset, limit } = schema.parse(params);
    try {
      const content = readFileSync(path, 'utf-8');
      if (offset === undefined && limit === undefined) {
        return { ok: true, output: content };
      }
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const end = limit !== undefined ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const header = `Lines ${start + 1}–${Math.min(end, lines.length)} of ${lines.length} (${path})\n`;
      return { ok: true, output: header + slice.join('\n') };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read "${path}": ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

import { readFileSync } from 'fs';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

// Mismo contrato que la tool `read` de OpenCode (ver opencode-init-implementacion.md §5.1):
// tope de 2000 líneas por llamada, líneas prefijadas con su número, líneas largas truncadas.
const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

const schema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Line number to start reading from (1-indexed, inclusive)'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of lines to read (default and cap: ${MAX_LINES})`),
});

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a file from the local filesystem. If the path does not exist, an error is returned.\n' +
    '\n' +
    'Usage:\n' +
    `- By default, this tool returns up to ${MAX_LINES} lines from the start of the file.\n` +
    '- The offset parameter is the line number to start from (1-indexed).\n' +
    '- To read later sections, call this tool again with a larger offset.\n' +
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".\n' +
    `- Any line longer than ${MAX_LINE_LEN} characters is truncated.\n` +
    '- Use the grep tool to find specific content in large files or files with long lines.\n' +
    '- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n' +
    '- Call this tool in parallel when you know there are multiple files you want to read.\n' +
    '- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.',
  schema,
  destructive: false,

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { path, offset, limit } = schema.parse(params);
    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const cap = limit !== undefined ? Math.min(limit, MAX_LINES) : MAX_LINES;
      const end = Math.min(start + cap, lines.length);

      if (start >= lines.length) {
        return {
          ok: false,
          error: `Offset ${offset} is beyond the end of the file (${lines.length} lines)`,
          recoverable: true,
        };
      }

      const body = lines
        .slice(start, end)
        .map(
          (l, i) =>
            `${start + i + 1}: ${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`,
        )
        .join('\n');
      const suffix =
        end < lines.length
          ? `\n(File has more lines. Use 'offset' to read beyond line ${end})`
          : '';
      return { ok: true, output: body + suffix };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read "${path}": ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

import { readFileSync, writeFileSync } from 'fs';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { generateUnifiedDiff } from './diff.js';

const schema = z.object({
  path: z.string().describe('Path to the file to edit'),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace. Must match the file contents exactly, including whitespace and indentation. Must be unique in the file unless replace_all is true.',
    ),
  new_string: z.string().describe('Replacement text. Must differ from old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence of old_string (default: false)'),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Performs exact string replacement in a file.\n' +
    '- old_string must match the file contents EXACTLY, including indentation and line breaks. ' +
    'When copying from read_file output, strip the "N: " line-number prefix first.\n' +
    '- old_string must be unique in the file; include surrounding lines to disambiguate, ' +
    'or set replace_all: true to replace every occurrence.\n' +
    '- Returns a unified diff of the change for review.',
  schema,
  destructive: false,

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { path, old_string, new_string, replace_all } = schema.parse(params);

    if (old_string === new_string) {
      return {
        ok: false,
        error: 'old_string and new_string are identical — nothing to change.',
        recoverable: true,
      };
    }

    let original: string;
    try {
      original = readFileSync(path, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: `Cannot read "${path}": ${(err as Error).message}`,
        recoverable: true,
      };
    }

    const occurrences = countOccurrences(original, old_string);

    if (occurrences === 0) {
      return {
        ok: false,
        error:
          `old_string not found in "${path}". Ensure it matches the file exactly ` +
          '(whitespace, indentation, line breaks) and does not include read_file line-number prefixes.',
        recoverable: true,
      };
    }

    if (occurrences > 1 && !replace_all) {
      return {
        ok: false,
        error:
          `old_string appears ${occurrences} times in "${path}". ` +
          'Add surrounding context to make it unique, or set replace_all: true.',
        recoverable: true,
      };
    }

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);

    try {
      writeFileSync(path, updated, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write "${path}": ${(err as Error).message}`,
        recoverable: true,
      };
    }

    const diff = generateUnifiedDiff(path, original, updated);
    const replacedNote = replace_all ? ` (${occurrences} occurrences replaced)` : '';
    return { ok: true, output: `File edited: ${path}${replacedNote}\n\n${diff}` };
  },
};

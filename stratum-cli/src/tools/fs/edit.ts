import { resolve } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { sensitivePathPreflight, sensitivePathNeedsConfirm } from './sensitive.js';
import { stringParam, workspaceExecuteGuard, workspacePathPreflight } from './confine.js';
import { generateUnifiedDiff } from './diff.js';
import {
  FileChangedError,
  UnsupportedEncodingError,
  readTextFile,
  toCrlf,
  writeTextFileAtomic,
  type TextFile,
} from './file-io.js';

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

/**
 * Reemplazo literal. `String.prototype.replace` con un string de reemplazo
 * interpreta `$&`, `$1`, `$$`…: un `new_string` con código de shell, PHP o
 * plantillas JS salía corrompido.
 */
function replaceLiteral(text: string, search: string, replacement: string, all: boolean): string {
  if (all) return text.split(search).join(replacement);
  const idx = text.indexOf(search);
  return text.slice(0, idx) + replacement + text.slice(idx + search.length);
}

/**
 * En un fichero CRLF el modelo casi siempre escribe `old_string` con `\n`
 * (read_file no le enseña los `\r`), así que la búsqueda exacta no casaba nunca
 * con más de una línea. Se prueba primero tal cual y, si no aparece, con los
 * saltos convertidos a CRLF. El reemplazo siempre se adapta a CRLF, para no
 * dejar líneas LF sueltas en medio del fichero.
 */
function matchInFile(
  file: TextFile,
  oldString: string,
  newString: string,
): { search: string; replacement: string; occurrences: number } {
  if (file.eol !== 'crlf') {
    return {
      search: oldString,
      replacement: newString,
      occurrences: countOccurrences(file.text, oldString),
    };
  }
  const replacement = toCrlf(newString);
  const exact = countOccurrences(file.text, oldString);
  if (exact > 0) return { search: oldString, replacement, occurrences: exact };
  const search = toCrlf(oldString);
  return {
    search,
    replacement,
    occurrences: search === oldString ? 0 : countOccurrences(file.text, search),
  };
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Performs exact string replacement in a file.\n' +
    '- old_string must match the file contents EXACTLY, including indentation and line breaks. ' +
    'When copying from read_file output, strip the "N: " line-number prefix first.\n' +
    '- old_string must be unique in the file; include surrounding lines to disambiguate, ' +
    'or set replace_all: true to replace every occurrence.\n' +
    '- Only UTF-8 text files can be edited; the file keeps its BOM and line endings.\n' +
    '- Returns a unified diff of the change for review.',
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
    const { path, old_string, new_string, replace_all } = schema.parse(params);
    const vetoed = workspaceExecuteGuard(path, ctx, 'write');
    if (vetoed) return vetoed;
    const target = resolve(ctx.cwd, path);

    if (old_string === new_string) {
      return {
        ok: false,
        error: 'old_string and new_string are identical — nothing to change.',
        recoverable: true,
      };
    }

    let file: TextFile;
    try {
      file = readTextFile(target);
    } catch (err) {
      const reason =
        err instanceof UnsupportedEncodingError
          ? `${err.message}. The file was not modified; edit_file only handles UTF-8 text.`
          : (err as Error).message;
      return {
        ok: false,
        error: `Cannot edit "${path}": ${reason}`,
        recoverable: true,
      };
    }

    const { search, replacement, occurrences } = matchInFile(file, old_string, new_string);

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

    const updated = replaceLiteral(file.text, search, replacement, replace_all === true);

    try {
      // `expected`: si el fichero cambió desde la lectura de arriba (un editor
      // guardó justo ahora), no se pisa esa versión.
      const written = writeTextFileAtomic(target, updated, {
        bom: file.bom,
        expected: file.signature,
      });
      ctx.fileState?.record(target, written);
    } catch (err) {
      const msg =
        err instanceof FileChangedError
          ? `${err.message}; nothing was written. Read the file again and retry.`
          : (err as Error).message;
      return {
        ok: false,
        error: `Failed to write "${path}": ${msg}`,
        recoverable: true,
      };
    }

    // El diff se calcula sin `\r`: con CRLF cada línea llevaría un `^M` visible.
    const diff = generateUnifiedDiff(
      path,
      file.text.replace(/\r\n/g, '\n'),
      updated.replace(/\r\n/g, '\n'),
    );
    const replacedNote = replace_all ? ` (${occurrences} occurrences replaced)` : '';
    return { ok: true, output: `File edited: ${path}${replacedNote}\n\n${diff}` };
  },
};

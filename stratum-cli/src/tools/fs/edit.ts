import { resolve } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { sensitivePathPreflight, sensitivePathNeedsConfirm } from './sensitive.js';
import { stringParam, workspaceExecuteGuard, workspacePathPreflight } from './confine.js';
import { withDiagnostics } from './attach-diagnostics.js';
import { generateUnifiedDiff } from './diff.js';
import { MATCH_LEVELS, findSpans, replaceSpans, type MatchLevel, type Span } from './match.js';
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

const levelLabels: Record<MatchLevel, string> = {
  exact: 'exact match',
  unicode: 'after normalizing unicode punctuation/spaces',
  'trailing-whitespace': 'ignoring trailing whitespace',
};

/**
 * Escalera de búsqueda: exacto, luego normalizando unicode, luego por líneas
 * ignorando espacios finales. Se para en el primer nivel que encuentra algo.
 *
 * En un fichero CRLF el modelo casi siempre escribe `old_string` con `\n`
 * (read_file no le enseña los `\r`), así que el nivel exacto prueba primero tal
 * cual y, si no aparece, con los saltos convertidos a CRLF. Los otros niveles
 * trabajan sobre el texto tal cual.
 */
function locateInFile(
  file: TextFile,
  oldString: string,
): { level: MatchLevel; spans: Span[] } | null {
  for (const level of MATCH_LEVELS) {
    const needles =
      level === 'exact' && file.eol === 'crlf' ? [oldString, toCrlf(oldString)] : [oldString];
    for (const needle of needles) {
      const spans = findSpans(file.text, needle, level);
      if (spans.length > 0) return { level, spans };
    }
  }
  return null;
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Performs exact string replacement in a file.\n' +
    '- old_string must match the file contents EXACTLY, including indentation and line breaks. ' +
    'When copying from read_file output, strip the "N: " line-number prefix first.\n' +
    '- As a last resort the match tolerates typographic quotes/dashes/spaces and trailing ' +
    'whitespace; this is a safety net for small slips, not a reason to be sloppy.\n' +
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

    // Un `old_string` que empieza por BOM no casa nunca: el BOM no está en
    // `file.text` (se conserva aparte y se reescribe al guardar).
    const needle = old_string.startsWith('\ufeff') ? old_string.slice(1) : old_string;
    const located = locateInFile(file, needle);

    if (!located) {
      return {
        ok: false,
        error:
          `old_string not found in "${path}", even after normalizing typographic ` +
          'punctuation/spaces and ignoring trailing whitespace. Ensure it matches the file ' +
          'exactly (whitespace, indentation, line breaks) and does not include read_file ' +
          'line-number prefixes.',
        recoverable: true,
      };
    }

    const { level, spans } = located;
    const occurrences = spans.length;

    if (occurrences > 1 && !replace_all) {
      return {
        ok: false,
        error:
          `old_string appears ${occurrences} times in "${path}" (${levelLabels[level]}). ` +
          'Add surrounding context to make it unique, or set replace_all: true.',
        recoverable: true,
      };
    }

    // El reemplazo siempre se adapta a CRLF, para no dejar líneas LF sueltas en
    // medio del fichero. `new_string` no se normaliza de ninguna otra forma: lo
    // que escribe el modelo es lo que queda.
    const replacement = file.eol === 'crlf' ? toCrlf(new_string) : new_string;
    const updated = replaceSpans(file.text, replace_all ? spans : [spans[0]], replacement);

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
    const levelNote =
      level === 'unicode'
        ? ' (matched after normalizing unicode punctuation/spaces)'
        : level === 'trailing-whitespace'
          ? ' (matched ignoring trailing whitespace)'
          : '';
    // UX-2b: los diagnósticos del language server van detrás del diff, ya
    // formateados. Un `null` o un fallo del LSP dejan el resultado intacto.
    const output = await withDiagnostics(
      `File edited: ${path}${levelNote}${replacedNote}\n\n${diff}`,
      target,
      updated,
      ctx,
    );
    return { ok: true, output };
  },
};

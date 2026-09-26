import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { sensitivePathPreflight, sensitivePathNeedsConfirm } from './sensitive.js';
import { stringParam, workspaceExecuteGuard, workspacePathPreflight } from './confine.js';
import {
  FileChangedError,
  currentSignature,
  decodeText,
  detectEol,
  toCrlf,
  writeTextFileAtomic,
} from './file-io.js';

const BOM_CHAR = String.fromCharCode(0xfeff);

const schema = z.object({
  path: z.string().describe('Absolute or relative path to write'),
  content: z.string().describe('Content to write to the file'),
});

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the given content. Parent directories are created automatically.\n' +
    '- To change part of an existing file, prefer edit_file.\n' +
    '- Overwriting a file that changed on disk since you last read it is refused: read it again first.',
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
      const before = currentSignature(target);
      if (ctx.fileState?.check(target, before) === 'stale') {
        return {
          ok: false,
          error:
            `"${path}" changed on disk since you last read it (edited by the user or another ` +
            'process). Read it again with read_file and apply your change on top of the ' +
            'current version, or use edit_file.',
          recoverable: true,
        };
      }

      // Sobrescribir conserva BOM y CRLF del original: el modelo casi nunca los
      // reproduce, y cambiarlos reescribiría cada línea en el diff de git.
      let text = content;
      let bom = false;
      if (text.startsWith(BOM_CHAR)) {
        text = text.slice(1);
        bom = true;
      }
      if (before) {
        const original = originalShape(target);
        if (original) {
          bom ||= original.bom;
          if (original.eol === 'crlf') text = toCrlf(text);
        }
      }

      const written = writeTextFileAtomic(target, text, { bom, expected: before ?? undefined });
      ctx.fileState?.record(target, written);
      return {
        ok: true,
        output: `File ${before ? 'overwritten' : 'created'}: ${path} (${written.size} bytes)`,
      };
    } catch (err) {
      const msg =
        err instanceof FileChangedError
          ? `${err.message}; nothing was written. Read the file again before retrying.`
          : (err as Error).message;
      return {
        ok: false,
        error: `Failed to write "${path}": ${msg}`,
        recoverable: true,
      };
    }
  },
};

/**
 * BOM y final de línea del fichero que se va a sobrescribir. `null` si no es
 * texto UTF-8: entonces no hay forma que conservar y se escribe tal cual.
 */
function originalShape(target: string): { bom: boolean; eol: 'lf' | 'crlf' } | null {
  try {
    const { text, bom } = decodeText(readFileSync(target));
    return { bom, eol: detectEol(text) };
  } catch {
    return null;
  }
}

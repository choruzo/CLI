import { readdirSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

// Directorios que siempre se excluyen (mismo set que init-agent.ts)
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.next',
  'build',
  'coverage',
  '.turbo',
]);

const MAX_ENTRIES = 500;

function listDirRecursive(
  dir: string,
  depth: number,
  maxDepth: number,
  lines: string[],
  indent: string,
): void {
  if (depth > maxDepth || lines.length >= MAX_ENTRIES) return;

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Directorios primero, luego archivos (más legible para el LLM)
  const sorted = [...entries].sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (lines.length >= MAX_ENTRIES) {
      lines.push(`${indent}… (demasiadas entradas, usa depth menor)`);
      return;
    }

    const isDir = entry.isDirectory();
    lines.push(`${indent}${entry.name}${isDir ? '/' : ''}`);

    if (isDir && depth < maxDepth) {
      listDirRecursive(join(dir, entry.name), depth + 1, maxDepth, lines, indent + '  ');
    }
  }
}

const schema = z.object({
  path: z.string().default('.').describe('Directory to list (default: current directory)'),
  depth: z
    .number()
    .int()
    .nonnegative()
    .default(1)
    .describe('How many levels deep to list (default: 1, 0 = only top level)'),
});

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description:
    'List files and directories. Marks directories with /. ' +
    'Excludes common build artifacts (node_modules, dist, .git, etc.).',
  schema,
  destructive: false,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: dirPath, depth } = schema.parse(params);
    const base = resolve(ctx.cwd, dirPath);

    try {
      const lines: string[] = [];
      listDirRecursive(base, 0, depth, lines, '');

      if (lines.length === 0) {
        return { ok: true, output: '(directorio vacío)' };
      }

      return { ok: true, output: lines.join('\n') };
    } catch (err) {
      return {
        ok: false,
        error: `list_directory failed: ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

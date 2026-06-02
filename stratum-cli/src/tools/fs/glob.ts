import { readdirSync, statSync } from 'fs';
import { join } from 'path';
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

const MAX_RESULTS = 200;

/**
 * Convierte un patrón glob minimal a RegExp.
 * Soporta: ** (cualquier secuencia de segmentos), * (cualquier secuencia en un segmento), ? (un char).
 */
function globToRegExp(pattern: string): RegExp {
  let regStr = '';
  let i = 0;
  // Normalizar separadores de ruta
  const p = pattern.replace(/\\/g, '/');

  while (i < p.length) {
    const ch = p[i]!;

    if (ch === '*' && p[i + 1] === '*') {
      // "**/" → match cero o más segmentos de directorio
      if (p[i + 2] === '/') {
        regStr += '(?:.+/)?';
        i += 3;
      } else {
        // "**" al final o sin / → match cualquier cosa
        regStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regStr += '\\' + ch;
      i++;
    } else {
      regStr += ch;
      i++;
    }
  }

  return new RegExp('^' + regStr + '$');
}

function walkGlob(dir: string, relDir: string, re: RegExp, results: string[]): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;

    const relPath = relDir ? `${relDir}/${entry}` : entry;
    const fullPath = join(dir, entry);

    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      walkGlob(fullPath, relPath, re, results);
    } else {
      if (re.test(relPath)) {
        results.push(relPath);
        if (results.length >= MAX_RESULTS) return;
      }
    }
  }
}

const schema = z.object({
  pattern: z.string().describe('Glob pattern (supports **, *, ?). Examples: **/*.ts, src/*.json'),
  cwd: z.string().optional().describe('Base directory to search from (default: process.cwd())'),
});

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Supports **, *, ?. ' +
    'Returns up to 200 matching relative paths. Excludes node_modules, .git, dist, etc.',
  schema,
  destructive: false,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, cwd } = schema.parse(params);
    const base = cwd ?? ctx.cwd;

    try {
      const re = globToRegExp(pattern);
      const results: string[] = [];
      walkGlob(base, '', re, results);

      if (results.length === 0) {
        return { ok: true, output: '(no matches)' };
      }

      const overflow =
        results.length >= MAX_RESULTS ? `\n… (limitado a ${MAX_RESULTS} resultados)` : '';
      return { ok: true, output: results.join('\n') + overflow };
    } catch (err) {
      return {
        ok: false,
        error: `glob failed: ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

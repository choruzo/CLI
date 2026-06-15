import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { execa } from 'execa';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

// Directorios que siempre se excluyen (mismo set que glob.ts / list.ts)
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

const MAX_MATCHES = 200;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB: saltar binarios/ficheros enormes en el fallback

let ripgrepAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    await execa('rg', ['--version']);
    ripgrepAvailable = true;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

async function searchWithRipgrep(
  pattern: string,
  include: string | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const args = ['--line-number', '--no-heading', '--max-count', '50'];
  for (const dir of EXCLUDED_DIRS) args.push('--glob', `!${dir}/**`);
  if (include) args.push('--glob', include);
  args.push('--regexp', pattern, '.');

  const result = await execa('rg', args, { cwd, cancelSignal: signal, reject: false });
  // rg exit codes: 0 = matches, 1 = no matches, 2 = error
  if (result.exitCode === 2) {
    throw new Error(result.stderr || 'ripgrep failed');
  }
  if (!result.stdout) return [];
  return result.stdout.split('\n').filter(Boolean).slice(0, MAX_MATCHES);
}

/** Convierte un patrón include estilo glob ("*.ts", "*.{ts,tsx}") a RegExp sobre el nombre de archivo. */
function includeToRegExp(include: string): RegExp {
  let regStr = '';
  let i = 0;
  while (i < include.length) {
    const ch = include[i]!;
    if (ch === '*') {
      regStr += i + 1 < include.length && include[i + 1] === '*' ? '.*' : '[^/]*';
      i += include[i + 1] === '*' ? 2 : 1;
    } else if (ch === '?') {
      regStr += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = include.indexOf('}', i);
      if (end === -1) {
        regStr += '\\{';
        i++;
      } else {
        const alternatives = include
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        regStr += `(?:${alternatives.join('|')})`;
        i = end + 1;
      }
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

function searchWithNode(pattern: string, include: string | undefined, baseDir: string): string[] {
  const re = new RegExp(pattern);
  const includeRe = include ? includeToRegExp(include) : null;
  const matches: string[] = [];

  const walk = (dir: string, relDir: string): void => {
    if (matches.length >= MAX_MATCHES) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (EXCLUDED_DIRS.has(entry)) continue;

      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, relPath);
        continue;
      }

      if (includeRe && !includeRe.test(entry) && !includeRe.test(relPath)) continue;
      if (stat.size > MAX_FILE_SIZE) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue; // binario

      const lines = content.split('\n');
      for (let n = 0; n < lines.length; n++) {
        if (re.test(lines[n]!)) {
          matches.push(`${relPath}:${n + 1}: ${lines[n]!.slice(0, 500)}`);
          if (matches.length >= MAX_MATCHES) return;
        }
      }
    }
  };

  walk(baseDir, '');
  return matches;
}

const schema = z.object({
  pattern: z
    .string()
    .describe(
      'Regular expression to search for in file contents (eg. "log.*Error", "function\\s+\\w+")',
    ),
  include: z
    .string()
    .optional()
    .describe('Filter files by glob pattern (eg. "*.ts", "*.{ts,tsx}")'),
  cwd: z.string().optional().describe('Base directory to search from (default: current directory)'),
});

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    '- Fast content search tool that works with any codebase size\n' +
    '- Searches file contents using regular expressions (eg. "log.*Error", "function\\s+\\w+")\n' +
    '- Filter files by pattern with the include parameter (eg. "*.ts", "*.{ts,tsx}")\n' +
    '- Returns file paths and line numbers with matching lines\n' +
    '- Use this tool when you need to find files containing specific patterns\n' +
    '- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.',
  schema,
  destructive: false,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, include, cwd } = schema.parse(params);
    const base = cwd ?? ctx.cwd;

    try {
      let matches: string[];
      if (await hasRipgrep()) {
        matches = await searchWithRipgrep(pattern, include, base, ctx.signal);
      } else {
        matches = searchWithNode(pattern, include, base);
      }

      if (matches.length === 0) {
        return { ok: true, output: '(no matches)' };
      }

      const overflow =
        matches.length >= MAX_MATCHES ? `\n… (capped at ${MAX_MATCHES} matches)` : '';
      return { ok: true, output: matches.join('\n') + overflow };
    } catch (err) {
      return {
        ok: false,
        error: `grep failed: ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};

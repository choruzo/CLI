import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { editFileTool } from './fs/edit.js';
import { generateUnifiedDiff } from './fs/diff.js';
import type { ToolContext } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});
const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  config,
};

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `stratum-edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('edit_file', () => {
  it('replaces a unique string and returns a diff', async () => {
    const path = join(testDir, 'a.ts');
    writeFileSync(path, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const result = await editFileTool.execute(
      { path, old_string: 'const b = 2;', new_string: 'const b = 42;' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('const b = 42;');
    if (result.ok) {
      expect(result.output).toContain('-const b = 2;');
      expect(result.output).toContain('+const b = 42;');
      expect(result.output).toContain('@@');
    }
  });

  it('fails when old_string is not found', async () => {
    const path = join(testDir, 'b.txt');
    writeFileSync(path, 'hello world\n');

    const result = await editFileTool.execute(
      { path, old_string: 'goodbye', new_string: 'farewell' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recoverable).toBe(true);
      expect(result.error).toContain('not found');
    }
  });

  it('fails when old_string is ambiguous without replace_all', async () => {
    const path = join(testDir, 'c.txt');
    writeFileSync(path, 'foo\nfoo\n');

    const result = await editFileTool.execute({ path, old_string: 'foo', new_string: 'bar' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('2 times');
  });

  it('replaces every occurrence with replace_all', async () => {
    const path = join(testDir, 'd.txt');
    writeFileSync(path, 'foo x foo y foo\n');

    const result = await editFileTool.execute(
      { path, old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('bar x bar y bar\n');
    if (result.ok) expect(result.output).toContain('3 occurrences');
  });

  it('rejects identical old_string and new_string', async () => {
    const path = join(testDir, 'e.txt');
    writeFileSync(path, 'same\n');

    const result = await editFileTool.execute(
      { path, old_string: 'same', new_string: 'same' },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('fails recoverably on missing file', async () => {
    const result = await editFileTool.execute(
      { path: join(testDir, 'nope.txt'), old_string: 'a', new_string: 'b' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });
});

describe('generateUnifiedDiff', () => {
  it('returns (no changes) for identical content', () => {
    expect(generateUnifiedDiff('f', 'a\nb', 'a\nb')).toBe('(no changes)');
  });

  it('produces hunk headers and context lines', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n');
    const after = ['l1', 'l2', 'l3', 'l4', 'CHANGED', 'l6', 'l7', 'l8'].join('\n');
    const diff = generateUnifiedDiff('file.txt', before, after);

    expect(diff).toContain('--- file.txt');
    expect(diff).toContain('+++ file.txt');
    expect(diff).toContain('-l5');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' l4'); // contexto
    expect(diff).not.toContain('-l1'); // fuera del hunk
  });

  it('handles pure additions', () => {
    const diff = generateUnifiedDiff('f', 'a\nb', 'a\nnew\nb');
    expect(diff).toContain('+new');
    expect(diff).not.toContain('-a');
  });
});

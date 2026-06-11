import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
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
  testDir = join(tmpdir(), `stratum-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('read_file', () => {
  it('reads a file', async () => {
    const path = join(testDir, 'hello.txt');
    writeFileSync(path, 'line1\nline2\nline3\n');

    const result = await readFileTool.execute({ path }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('line1');
  });

  it('applies offset and limit', async () => {
    const path = join(testDir, 'multi.txt');
    writeFileSync(path, 'L1\nL2\nL3\nL4\nL5\n');

    const result = await readFileTool.execute({ path, offset: 2, limit: 2 }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('L2');
      expect(result.output).toContain('L3');
      expect(result.output).not.toContain('L4');
    }
  });

  it('returns error for missing file', async () => {
    const result = await readFileTool.execute({ path: join(testDir, 'nonexistent.txt') }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });

  it('prefixes each line with its 1-indexed line number', async () => {
    const path = join(testDir, 'numbered.txt');
    writeFileSync(path, 'foo\nbar\nbaz');

    const result = await readFileTool.execute({ path }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('1: foo\n2: bar\n3: baz');
    }
  });

  it('numbers respect the offset', async () => {
    const path = join(testDir, 'offset.txt');
    writeFileSync(path, 'L1\nL2\nL3\nL4\nL5');

    const result = await readFileTool.execute({ path, offset: 3, limit: 2 }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('3: L3');
      expect(result.output).toContain('4: L4');
      expect(result.output).toContain("(File has more lines. Use 'offset' to read beyond line 4)");
    }
  });

  it('caps output at 2000 lines and appends the continuation hint', async () => {
    const path = join(testDir, 'big.txt');
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
    writeFileSync(path, lines.join('\n'));

    const result = await readFileTool.execute({ path }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('2000: line-2000');
      expect(result.output).not.toContain('2001: line-2001');
      expect(result.output).toContain("Use 'offset' to read beyond line 2000");
    }
  });

  it('truncates lines longer than 2000 characters', async () => {
    const path = join(testDir, 'long-line.txt');
    writeFileSync(path, 'x'.repeat(3000));

    const result = await readFileTool.execute({ path }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.startsWith('1: ')).toBe(true);
      expect(result.output.length).toBeLessThan(2100);
      expect(result.output.endsWith('…')).toBe(true);
    }
  });

  it('returns error when offset is beyond end of file', async () => {
    const path = join(testDir, 'short.txt');
    writeFileSync(path, 'one\ntwo');

    const result = await readFileTool.execute({ path, offset: 100 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });
});

describe('write_file', () => {
  it('creates a new file', async () => {
    const path = join(testDir, 'new.txt');
    const result = await writeFileTool.execute({ path, content: 'hello' }, ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('overwrites an existing file', async () => {
    const path = join(testDir, 'existing.txt');
    writeFileSync(path, 'old content');

    const result = await writeFileTool.execute({ path, content: 'new content' }, ctx);
    expect(result.ok).toBe(true);

    const check = await readFileTool.execute({ path }, ctx);
    if (check.ok) expect(check.output).toBe('1: new content');
  });

  it('creates parent directories recursively', async () => {
    const path = join(testDir, 'deep', 'nested', 'file.txt');
    const result = await writeFileTool.execute({ path, content: 'data' }, ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

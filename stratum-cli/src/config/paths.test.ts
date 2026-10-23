import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { anchorMemoryPaths, findWorktreeRoot } from './paths.js';
import { StratumConfigSchema } from './schema.js';

describe('anchorMemoryPaths', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stratum-paths-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('ancla las rutas relativas a la raíz del worktree desde una subcarpeta', () => {
    const repo = join(base, 'repo');
    const sub = join(repo, 'src', 'deep');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });

    const out = anchorMemoryPaths(StratumConfigSchema.parse({}), sub);
    expect(out.memory.decisionsFile).toBe(resolve(repo, '.stratum', 'memory', 'decisions.json'));
    expect(out.memory.vectorDb).toBe(resolve(repo, '.stratum', 'memory', 'vectors.db'));
  });

  it('sin repo ancla al startDir', () => {
    const dir = join(base, 'plain');
    mkdirSync(dir, { recursive: true });
    expect(findWorktreeRoot(dir).isGitRepo).toBe(false);

    const out = anchorMemoryPaths(StratumConfigSchema.parse({}), dir);
    expect(out.memory.decisionsFile).toBe(resolve(dir, '.stratum', 'memory', 'decisions.json'));
  });

  it('respeta las rutas absolutas y las que empiezan por ~', () => {
    const dir = join(base, 'plain');
    mkdirSync(dir, { recursive: true });
    const abs = join(base, 'elsewhere', 'decisions.json');
    const config = StratumConfigSchema.parse({
      memory: { decisionsFile: abs, vectorDb: '~/.stratum/memory/vectors.db' },
    });
    const out = anchorMemoryPaths(config, dir);
    expect(out.memory.decisionsFile).toBe(abs);
    expect(out.memory.vectorDb).toBe('~/.stratum/memory/vectors.db');
  });
});

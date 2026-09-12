import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import { scrubGitEnv, isGitRoutingVar, inheritedGitRoutingVars, GIT_ROUTING_VARS } from './env.js';
import { collectWorkingTreeChanges } from './changes.js';

describe('isGitRoutingVar', () => {
  it('reconoce las variables de enrutado', () => {
    for (const name of GIT_ROUTING_VARS) expect(isGitRoutingVar(name)).toBe(true);
  });

  it('reconoce la familia indexada GIT_CONFIG_*', () => {
    expect(isGitRoutingVar('GIT_CONFIG_COUNT')).toBe(true);
    expect(isGitRoutingVar('GIT_CONFIG_KEY_0')).toBe(true);
    expect(isGitRoutingVar('GIT_CONFIG_VALUE_12')).toBe(true);
    expect(isGitRoutingVar('GIT_CONFIG_KEY')).toBe(false);
  });

  it('deja en paz lo que no enruta', () => {
    // Desviación deliberada del original, que borra todas las GIT_*: estas son
    // configuración legítima del usuario y borrarlas rompe `git push`.
    for (const name of ['GIT_SSH_COMMAND', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_ASKPASS']) {
      expect(isGitRoutingVar(name)).toBe(false);
    }
    expect(isGitRoutingVar('PATH')).toBe(false);
    expect(isGitRoutingVar('GITHUB_TOKEN')).toBe(false);
  });
});

describe('scrubGitEnv', () => {
  it('quita el enrutado y conserva el resto', () => {
    const out = scrubGitEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/otro/repo/.git',
      GIT_WORK_TREE: '/otro/repo',
      GIT_CONFIG_COUNT: '1',
      GIT_SSH_COMMAND: 'ssh -i key',
    });
    expect(out).toEqual({ PATH: '/usr/bin', GIT_SSH_COMMAND: 'ssh -i key' });
  });

  it('no muta la entrada', () => {
    const input = { GIT_DIR: '/x/.git', PATH: '/usr/bin' };
    scrubGitEnv(input);
    expect(input.GIT_DIR).toBe('/x/.git');
  });

  it('lista las heredadas, ordenadas, para diagnóstico', () => {
    expect(inheritedGitRoutingVars({ GIT_WORK_TREE: '/a', PATH: '/b', GIT_DIR: '/c' })).toEqual([
      'GIT_DIR',
      'GIT_WORK_TREE',
    ]);
    expect(inheritedGitRoutingVars({ PATH: '/b' })).toEqual([]);
  });
});

describe('enrutado heredado de git (integración)', () => {
  it('collectWorkingTreeChanges ignora el enrutado del entorno', async () => {
    // Dos repos reales, cada uno con su propio fichero sin commitear. Con
    // GIT_DIR/GIT_WORK_TREE apuntando al segundo, medir el primero debe seguir
    // dando el fichero del primero: `cwd` es la única fuente de verdad.
    const base = mkdtempSync(join(tmpdir(), 'stratum-gitenv-'));
    const target = join(base, 'target');
    const decoy = join(base, 'decoy');
    for (const dir of [target, decoy]) {
      mkdirSync(dir, { recursive: true });
      await execa('git', ['init', '-q'], { cwd: dir });
      await execa('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
      await execa('git', ['config', 'user.name', 'T'], { cwd: dir });
    }
    writeFileSync(join(target, 'nuevo.txt'), 'una linea\n', 'utf-8');
    writeFileSync(join(decoy, 'ajeno.txt'), 'otra linea\n', 'utf-8');

    const previous = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    try {
      const summary = await collectWorkingTreeChanges(target);
      expect(summary.isRepo).toBe(true);
      expect(summary.changes.map((c) => c.path)).toEqual(['nuevo.txt']);
    } finally {
      for (const [key, value] of [
        ['GIT_DIR', previous.dir],
        ['GIT_WORK_TREE', previous.work],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);
});

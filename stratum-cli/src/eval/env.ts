/**
 * Dónde y sobre qué código corre una ejecución de `stratum eval`: el commit, el
 * sistema y la versión. Es lo que permite fiarse de una comparación —o saber
 * por qué no hay que fiarse— semanas después.
 */
import { arch, release } from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { scrubGitEnv } from '../git/env.js';
import type { RunEnvironment } from './result.js';

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await execa('git', args, {
      cwd,
      reject: false,
      timeout: 10_000,
      stdin: 'ignore',
      env: scrubGitEnv(),
      extendEnv: false,
    });
    return r.exitCode === 0 ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

type GitInfo = NonNullable<RunEnvironment['git']>;

async function gitInfo(dir: string, repo: GitInfo['repo']): Promise<GitInfo | null> {
  const commit = await git(dir, ['rev-parse', '--short=12', 'HEAD']);
  if (!commit) return null;
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await git(dir, ['status', '--porcelain']);
  return {
    repo,
    commit,
    branch: branch && branch !== 'HEAD' ? branch : null,
    dirty: status !== null && status.length > 0,
  };
}

/** Carpeta de este módulo: el checkout de Stratum cuando se ejecuta desde el código. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * El commit que importa es el del Stratum que se evalúa: si la CLI corre desde
 * un checkout (desarrollo), el suyo; instalada como paquete —donde la versión
 * ya la identifica—, el del proyecto desde el que se lanza. Nunca lanza: sin
 * git o fuera de un repositorio, `git` es null.
 */
export async function collectRunEnvironment(
  cwd: string,
  selfDir: string | null = SELF_DIR,
): Promise<RunEnvironment> {
  const os = { platform: process.platform, release: release(), arch: arch() };
  // Instalada como dependencia no es un checkout, aunque cuelgue de un repositorio.
  const installed = selfDir === null || selfDir.split(/[\\/]/).includes('node_modules');
  const own = installed ? null : await gitInfo(selfDir, 'stratum');
  return { os, git: own ?? (await gitInfo(cwd, 'cwd')) };
}

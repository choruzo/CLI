import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from './manager.js';
import { MAIN_JOB_SCOPE } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';
import { resetExecRuntime } from '../tools/exec/runtime.js';

/**
 * Regresión: un job cancelado nada más arrancar. En Windows el cierre del árbol
 * (`taskkill /T`) puede recorrerlo cuando el shell todavía está lanzando a su
 * hijo: mataba al shell y el hijo quedaba huérfano y vivo para siempre. El hijo
 * de estos jobs apunta su pid en cuanto arranca; si llega a nacer, tiene que
 * estar muerto cuando `cancel()` / `shutdown()` vuelven.
 */

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });
const main = { scope: MAIN_JOB_SCOPE };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let dir: string;
let jobs: JobManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobs-race-'));
  jobs = new JobManager(config, { killGraceMs: 300 });
  writeFileSync(
    join(dir, 'child.js'),
    "require('fs').writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n",
  );
});

afterEach(async () => {
  await jobs.shutdown();
  resetExecRuntime();
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});

/** Pids que los hijos llegaron a apuntar. */
function recordedPids(count: number): number[] {
  const pids: number[] = [];
  for (let i = 0; i < count; i++) {
    const file = join(dir, `pid-${i}.txt`);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

const command = (i: number): string =>
  `node "${join(dir, 'child.js')}" "${join(dir, `pid-${i}.txt`)}"`;

describe('cancelar un job que aún está arrancando no deja huérfanos', () => {
  it('cancel() inmediato, varias veces seguidas', async () => {
    const rounds = 6;
    for (let i = 0; i < rounds; i++) {
      const job = await jobs.start({ command: command(i), cwd: dir, owner: main });
      const cancelled = await jobs.cancel(job.id);
      expect(cancelled.status).toBe('cancelled');
      expect(alive(job.pid!)).toBe(false);
    }
    // Margen para que un hijo que hubiese sobrevivido llegue a apuntarse.
    await new Promise((r) => setTimeout(r, 1500));
    expect(recordedPids(rounds).filter(alive)).toEqual([]);
  }, 120_000);

  it('shutdown() con varios jobs recién lanzados a la vez', async () => {
    const count = 6;
    const started = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        jobs.start({ command: command(i), cwd: dir, owner: main }),
      ),
    );
    await jobs.shutdown();

    expect(started.filter((j) => alive(j.pid!))).toEqual([]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(recordedPids(count).filter(alive)).toEqual([]);
  }, 120_000);

  it('killAllSync (gancho de exit) tampoco los deja', async () => {
    const count = 3;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        jobs.start({ command: command(i), cwd: dir, owner: main }),
      ),
    );
    jobs.killAllSync();
    await new Promise((r) => setTimeout(r, 1500));
    expect(recordedPids(count).filter(alive)).toEqual([]);
  }, 120_000);
});

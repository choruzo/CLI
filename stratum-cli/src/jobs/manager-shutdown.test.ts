import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager, JobManagerClosedError } from './manager.js';
import { liveJobManagers } from './registry.js';
import { MAIN_JOB_SCOPE } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';
import { ToolDispatcher, ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { closeExecRuntime, resetExecRuntime } from '../tools/exec/runtime.js';

/**
 * `shutdown()` es terminal: un manager cerrado no vuelve a lanzar jobs ni a
 * entrar en el registro del proceso. Si se pudiera reabrir, un `exec` que
 * llegase tarde dejaría un proceso vivo después del teardown, que es justo lo
 * que el cierre existe para impedir.
 */

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });
const node = (script: string): string => `node -e "${script}"`;
const FOREVER = node('setInterval(() => {}, 1000)');
const main = { scope: MAIN_JOB_SCOPE };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

let dir: string;
let managers: JobManager[];

function manager(): JobManager {
  const m = new JobManager(config, { killGraceMs: 300 });
  managers.push(m);
  return m;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobs-close-'));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  resetExecRuntime();
  // En Windows el directorio de trabajo de un proceso recién terminado tarda
  // un instante en liberarse, aunque el proceso ya no exista.
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});

describe('JobManager.shutdown es terminal', () => {
  it('tras shutdown, start() falla y no deja rastro', async () => {
    const jobs = manager();
    const first = await jobs.start({ command: FOREVER, cwd: dir, owner: main });
    expect(jobs.isClosed).toBe(false);

    await jobs.shutdown();
    expect(jobs.isClosed).toBe(true);
    // Sin esperas: cuando shutdown vuelve, el proceso ya no existe.
    expect(alive(first.pid!)).toBe(false);
    const registered = liveJobManagers();

    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobManagerClosedError,
    );

    // Ni un job nuevo, ni un evento, ni vuelta al registro del proceso.
    expect(jobs.list().map((j) => j.id)).toEqual([first.id]);
    expect(jobs.runningCount).toBe(0);
    expect(liveJobManagers()).toBe(registered);
  });

  it('no se reabre con el tiempo ni con una segunda llamada a shutdown', async () => {
    const jobs = manager();
    await jobs.start({ command: FOREVER, cwd: dir, owner: main });

    const closing = jobs.shutdown();
    // Idempotente: es el mismo cierre, no uno nuevo.
    expect(jobs.shutdown()).toBe(closing);
    await closing;
    await jobs.shutdown();
    await new Promise((r) => setTimeout(r, 50));

    expect(jobs.isClosed).toBe(true);
    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobManagerClosedError,
    );
  });

  it('un manager que nunca lanzó nada también queda cerrado, y nunca llega a registrarse', async () => {
    const before = liveJobManagers();
    const jobs = manager();
    await jobs.shutdown();

    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobManagerClosedError,
    );
    expect(liveJobManagers()).toBe(before);
    expect(jobs.list()).toEqual([]);
  });

  it('start() rechaza mientras el cierre aún está en curso', async () => {
    const jobs = manager();
    await jobs.start({ command: FOREVER, cwd: dir, owner: main });

    const closing = jobs.shutdown();
    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobManagerClosedError,
    );
    await closing;
    expect(jobs.list()).toHaveLength(1);
  });

  it('un start() en vuelo cuando llega el cierre no deja su proceso vivo', async () => {
    const jobs = manager();
    // Sin `await`: el cierre llega con el job a medio nacer.
    const starting = jobs.start({ command: FOREVER, cwd: dir, owner: main });
    const closing = jobs.shutdown();

    const job = await starting;
    await closing;

    expect(jobs.get(job.id)).toMatchObject({ status: 'cancelled', endReason: 'session-closed' });
    expect(job.pid).toBeTypeOf('number');
    expect(await waitUntil(() => !alive(job.pid!))).toBe(true);
    expect(jobs.runningCount).toBe(0);
  });

  it('lo ya terminado sigue consultable después del cierre', async () => {
    const jobs = manager();
    const done = await jobs.start({
      command: node("console.log('resultado')"),
      cwd: dir,
      owner: main,
    });
    await jobs.waitFor(done.id, { until: 'end', timeoutMs: 20_000 });
    const live = await jobs.start({ command: FOREVER, cwd: dir, owner: main });

    await jobs.shutdown();

    expect(jobs.get(done.id)!.status).toBe('completed');
    expect(jobs.get(live.id)!.status).toBe('cancelled');
    expect(jobs.readOutput(done.id, MAIN_JOB_SCOPE, { maxChars: 100 }).slice.stdout).toContain(
      'resultado',
    );
    // Cancelar algo ya cerrado sigue siendo inocuo.
    expect((await jobs.cancel(live.id)).status).toBe('cancelled');
  });

  it('closeExecRuntime (teardown de chat/run) deja cerrados los managers con jobs', async () => {
    const jobs = manager();
    await jobs.start({ command: FOREVER, cwd: dir, owner: main });

    await closeExecRuntime();

    expect(jobs.isClosed).toBe(true);
    expect(liveJobManagers()).toBe(0);
    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobManagerClosedError,
    );
    expect(liveJobManagers()).toBe(0);
  });

  it('exec con background tras el cierre: error no recuperable que no cuenta como fallo de la tool', async () => {
    const jobs = manager();
    await jobs.shutdown();

    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);
    const [res] = await new ToolDispatcher(registry).dispatch(
      [{ id: 'c1', name: 'exec', input: { command: node('1'), background: true } }],
      { signal: new AbortController().signal, cwd: dir, config, jobs, jobScope: MAIN_JOB_SCOPE },
    );

    expect(res!.result).toMatchObject({ ok: false, recoverable: false, countsAsFailure: false });
    expect(res!.result.ok ? '' : res!.result.error).toContain('session has been closed');
    expect(jobs.list()).toEqual([]);
  });
});

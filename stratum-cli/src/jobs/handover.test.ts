import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from './manager.js';
import { MAIN_JOB_SCOPE } from './types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { createExecTool } from '../tools/exec/exec.js';
import { getExecAuditLog, resetExecRuntime } from '../tools/exec/runtime.js';
import type { ToolContext, ToolResult } from '../agent/types.js';

// UX-4: pasar a segundo plano un `exec` local en curso. Procesos reales.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let managers: JobManager[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-handover-'));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  resetExecRuntime();
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});

function makeConfig(jobs: Record<string, unknown> = {}, auditLog: string | false = false) {
  return StratumConfigSchema.parse({ tools: { auditLog, jobs } });
}

function manager(config: StratumConfig): JobManager {
  const m = new JobManager(config, { killGraceMs: 300 });
  managers.push(m);
  return m;
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Escribe `first`, deja `ready` y espera a que exista `go` para escribir
 * `second` y salir con 0. Así el test decide cuándo termina el comando.
 */
function gatedCommand(
  first: string,
  second = 'after',
): {
  command: string;
  ready: string;
  go: string;
} {
  const script = join(dir, 'gated.js');
  const ready = join(dir, 'ready');
  const go = join(dir, 'go');
  writeFileSync(
    script,
    [
      "const fs = require('fs');",
      'const [first, second, ready, go] = process.argv.slice(2);',
      "process.stdout.write(first + '\\n');",
      "fs.writeFileSync(ready, 'x');",
      'const t = setInterval(() => {',
      '  if (fs.existsSync(go)) { console.log(second); clearInterval(t); }',
      '}, 50);',
    ].join('\n'),
  );
  return { command: `node "${script}" "${first}" "${second}" "${ready}" "${go}"`, ready, go };
}

function ctxFor(config: StratumConfig, jobs: JobManager, signal = new AbortController().signal) {
  return {
    signal,
    cwd: dir,
    config,
    jobs,
    jobScope: MAIN_JOB_SCOPE,
    sessionId: 'sess-1',
  } satisfies ToolContext;
}

function text(result: ToolResult): string {
  return result.ok ? result.output : result.error;
}

describe('exec en curso → job (UX-4)', () => {
  it('cede el proceso vivo: la llamada vuelve con el job y la salida sigue entera en él', async () => {
    const config = makeConfig();
    const jobs = manager(config);
    const tool = createExecTool(config);
    const abort = new AbortController();
    const gated = gatedCommand('before');

    const call = tool.execute({ command: gated.command }, ctxFor(config, jobs, abort.signal));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    await sleep(300); // que la primera línea llegue por el pipe
    expect(jobs.foregroundCount).toBe(1);

    const { jobs: adopted, errors } = jobs.backgroundForeground();
    expect(errors).toEqual([]);
    expect(adopted).toHaveLength(1);
    const job = adopted[0]!;

    const result = await call;
    expect(result.ok).toBe(true);
    expect(text(result)).toContain(`jobId="${job.id}"`);
    expect(text(result)).toContain('handedOver="true"');
    expect(jobs.foregroundCount).toBe(0);

    // Cancelar la llamada original ya no toca al job.
    abort.abort();
    await sleep(200);
    expect(jobs.get(job.id)?.status).toBe('running');

    writeFileSync(gated.go, 'x');
    expect(await waitUntil(() => jobs.get(job.id)?.status !== 'running')).toBe(true);
    const ended = jobs.get(job.id)!;
    expect(ended.status).toBe('completed');
    expect(ended.exitCode).toBe(0);
    const { slice } = jobs.readOutput(job.id, MAIN_JOB_SCOPE, { offset: 0, maxChars: 10_000 });
    expect(slice.stdout).toContain('before');
    expect(slice.stdout).toContain('after');
  });

  it('un job adoptado se cancela como cualquier otro: su proceso muere', async () => {
    const config = makeConfig();
    const jobs = manager(config);
    const tool = createExecTool(config);
    const gated = gatedCommand('before');
    const call = tool.execute({ command: gated.command }, ctxFor(config, jobs));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    const [job] = jobs.backgroundForeground().jobs;
    await call;
    const pid = job!.pid!;
    expect(pid).toBeGreaterThan(0);

    const cancelled = await jobs.cancel(job!.id);
    expect(cancelled.status).toBe('cancelled');
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(await waitUntil(() => !alive())).toBe(true);
  });

  it('sin hueco que ceder no hace nada: la llamada terminada ya no se anuncia', async () => {
    const config = makeConfig();
    const jobs = manager(config);
    const tool = createExecTool(config);
    const result = await tool.execute(
      { command: `node -e "console.log('done')"` },
      ctxFor(config, jobs),
    );
    expect(text(result)).toContain('<exec_result');
    expect(jobs.foregroundCount).toBe(0);
    expect(jobs.backgroundForeground()).toEqual({ jobs: [], errors: [] });
  });

  it('con el límite de jobs lleno no cede: el comando sigue y termina en primer plano', async () => {
    const config = makeConfig({ maxRunning: 1 });
    const jobs = manager(config);
    const busy = await jobs.start({
      command: `node -e "setInterval(() => {}, 1000)"`,
      cwd: dir,
      owner: { scope: MAIN_JOB_SCOPE },
    });
    const tool = createExecTool(config);
    const gated = gatedCommand('fg');

    const call = tool.execute({ command: gated.command }, ctxFor(config, jobs));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    const { jobs: adopted, errors } = jobs.backgroundForeground();
    expect(adopted).toEqual([]);
    expect(errors[0]).toMatch(/maxRunning/);
    expect(jobs.foregroundCount).toBe(1);

    writeFileSync(gated.go, 'x');
    const result = await call;
    expect(result.ok).toBe(true);
    expect(text(result)).toContain('<exec_result');
    expect(text(result)).toContain('after');
    expect(jobs.list().map((j) => j.id)).toEqual([busy.id]);
  });

  it('con la sesión cerrada no cede', async () => {
    const config = makeConfig();
    const jobs = manager(config);
    const tool = createExecTool(config);
    const gated = gatedCommand('fg');
    const call = tool.execute({ command: gated.command }, ctxFor(config, jobs));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    await jobs.shutdown();

    const { jobs: adopted, errors } = jobs.backgroundForeground();
    expect(adopted).toEqual([]);
    expect(errors[0]).toMatch(/closed/);
    writeFileSync(gated.go, 'x');
    expect(text(await call)).toContain('<exec_result');
  });

  it('lo que maxBytes ya había descartado queda señalado en la salida del job', async () => {
    const config = makeConfig();
    const jobs = manager(config);
    const tool = createExecTool(config);
    const gated = gatedCommand('x'.repeat(200));
    const call = tool.execute({ command: gated.command, maxBytes: 50 }, ctxFor(config, jobs));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    await sleep(300);

    const [job] = jobs.backgroundForeground().jobs;
    expect(job).toBeDefined();
    await call;
    writeFileSync(gated.go, 'x');
    expect(await waitUntil(() => jobs.get(job!.id)?.status !== 'running')).toBe(true);
    const { slice } = jobs.readOutput(job!.id, MAIN_JOB_SCOPE, { offset: 0, maxChars: 10_000 });
    expect(slice.stdout.startsWith('x'.repeat(50))).toBe(true);
    expect(slice.stdout).toMatch(/\d+ bytes of output were discarded \(maxBytes\)/);
    expect(slice.stdout).toContain('after');
  });

  it('auditoría: el registro es el del job (background_started + cierre), no el de primer plano', async () => {
    const auditPath = join(dir, 'audit.jsonl');
    const config = makeConfig({}, auditPath);
    const jobs = manager(config);
    const tool = createExecTool(config);
    const gated = gatedCommand('before');

    const call = tool.execute({ command: gated.command }, ctxFor(config, jobs));
    expect(await waitUntil(() => existsSync(gated.ready))).toBe(true);
    const [job] = jobs.backgroundForeground().jobs;
    await call;
    writeFileSync(gated.go, 'x');
    expect(await waitUntil(() => jobs.get(job!.id)?.status !== 'running')).toBe(true);
    await getExecAuditLog(config).flush();

    const records = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((r) => r['status'])).toEqual(['background_started', 'exited']);
    expect(records[0]).toMatchObject({ background: true, handedOver: true, jobId: job!.id });
    expect(records[1]).toMatchObject({ background: true, jobId: job!.id, exitCode: 0 });
  });
});

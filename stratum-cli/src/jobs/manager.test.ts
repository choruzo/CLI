import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobLimitError, JobManager, JobNotFoundError } from './manager.js';
import { liveJobManagers, shutdownAllJobs } from './registry.js';
import { MAIN_JOB_SCOPE } from './types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { closeExecRuntime, resetExecRuntime } from '../tools/exec/runtime.js';
import type { TraceScope } from '../trace/recorder.js';
import type { TraceRuntimeEvent } from '../trace/records.js';

function makeConfig(jobs: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse({ tools: { auditLog: false, jobs } });
}

/** `node -e` es portable entre pwsh (Windows) y /bin/sh. */
const node = (script: string): string => `node -e "${script}"`;

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

function fakeTrace(): { scope: TraceScope; events: TraceRuntimeEvent[] } {
  const events: TraceRuntimeEvent[] = [];
  const scope = {
    runtime: (ev: TraceRuntimeEvent) => void events.push(ev),
  } as unknown as TraceScope;
  return { scope, events };
}

let dir: string;
let managers: JobManager[];

function manager(jobs: Record<string, unknown> = {}): JobManager {
  const m = new JobManager(makeConfig(jobs), { killGraceMs: 300 });
  managers.push(m);
  return m;
}

/**
 * Script que lanza un hijo, apunta los dos pids en `pids.json` y se queda vivo:
 * un árbol de dos niveles bajo el shell del job.
 */
function treeCommand(): { command: string; pidFile: string } {
  const script = join(dir, 'tree.js');
  const pidFile = join(dir, 'pids.json');
  writeFileSync(
    script,
    [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      'fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));',
      "console.log('ready');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  return { command: `node "${script}" "${pidFile}"`, pidFile };
}

async function readPids(pidFile: string): Promise<{ parent: number; child: number }> {
  expect(
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 2),
  ).toBe(true);
  return JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobs-'));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  resetExecRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe('JobManager — ciclo de vida', () => {
  it('un job que sale con 0 queda completed, con su salida y su traza', async () => {
    const jobs = manager();
    const trace = fakeTrace();
    const job = await jobs.start({
      command: node("console.log('hola'); console.error('aviso')"),
      cwd: dir,
      owner: main,
      trace: trace.scope,
    });
    expect(job.id).toBe('1');
    expect(job.status).toBe('running');
    expect(job.pid).toBeTypeOf('number');

    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    const done = jobs.get(job.id)!;
    expect(done.status).toBe('completed');
    expect(done.exitCode).toBe(0);
    expect(done.endReason).toBe('exit');
    expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);
    expect(done.stdoutBytes).toBeGreaterThan(0);
    expect(done.stderrBytes).toBeGreaterThan(0);

    const { slice } = jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 1000 });
    expect(slice.stdout).toContain('hola');
    expect(slice.stderr).toContain('aviso');

    const phases = trace.events.flatMap((e) => (e.event === 'job' ? [e.phase] : []));
    expect(phases).toEqual(['created', 'started', 'ended', 'read']);
    const ended = trace.events.find((e) => e.event === 'job' && e.phase === 'ended');
    expect(ended).toMatchObject({ status: 'completed', exitCode: 0, outputRead: false });
  });

  it('un exit distinto de 0 queda failed con el código real', async () => {
    const jobs = manager();
    const job = await jobs.start({
      command: node("console.error('roto'); process.exit(3)"),
      cwd: dir,
      owner: main,
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    const done = jobs.get(job.id)!;
    expect(done.status).toBe('failed');
    expect(done.exitCode).toBe(3);
    expect(jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 1000 }).slice.stderr).toContain(
      'roto',
    );
  });

  it('la salida se lee de forma incremental mientras el job sigue vivo', async () => {
    const jobs = manager();
    const job = await jobs.start({
      command: node(
        "let i = 0; const t = setInterval(() => { console.log('linea ' + i); if (++i === 4) clearInterval(t); }, 250)",
      ),
      cwd: dir,
      owner: main,
    });

    await jobs.waitFor(job.id, { until: 'output', offset: 0, timeoutMs: 20_000 });
    const first = jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 1000 });
    expect(first.slice.stdout).toContain('linea 0');
    expect(first.slice.stdout).not.toContain('linea 3');

    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    // Sin offset: sigue donde este scope lo dejó, sin repetir nada.
    const rest = jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 1000 });
    expect(rest.slice.offset).toBe(first.slice.nextOffset);
    expect(rest.slice.stdout).not.toContain('linea 0');
    expect(rest.slice.stdout).toContain('linea 3');
    expect(rest.job.status).toBe('completed');
    expect(rest.job.outputRead).toBe(true);
  });

  it('redacta el comando y la salida', async () => {
    const jobs = manager();
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const job = await jobs.start({
      command: node(`console.log('${token}')`),
      cwd: dir,
      owner: main,
    });
    expect(job.command).not.toContain(token);
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    const text = jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 1000 }).slice.stdout;
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted:');
  });

  it('un job que supera su tiempo máximo se mata y queda failed por timeout', async () => {
    const jobs = manager();
    const job = await jobs.start({
      command: node('setInterval(() => {}, 1000)'),
      cwd: dir,
      owner: main,
      timeoutMs: 400,
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    const done = jobs.get(job.id)!;
    expect(done.status).toBe('failed');
    expect(done.endReason).toBe('timeout');
    expect(done.exitCode).toBeNull();
    expect(alive(job.pid!)).toBe(false);
  });

  it('waitFor vuelve al vencer su plazo si el job sigue vivo, y con la señal', async () => {
    const jobs = manager();
    const job = await jobs.start({
      command: node('setInterval(() => {}, 1000)'),
      cwd: dir,
      owner: main,
    });
    const started = Date.now();
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(jobs.get(job.id)!.status).toBe('running');

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 60_000, signal: abort.signal });
    expect(jobs.get(job.id)!.status).toBe('running');
  });

  it('respeta maxRunning', async () => {
    const jobs = manager({ maxRunning: 1 });
    await jobs.start({ command: node('setInterval(() => {}, 1000)'), cwd: dir, owner: main });
    await expect(jobs.start({ command: node('1'), cwd: dir, owner: main })).rejects.toBeInstanceOf(
      JobLimitError,
    );
  });

  it('un cwd inexistente no deja un job a medias', async () => {
    const jobs = manager();
    await expect(
      jobs.start({ command: node('1'), cwd: join(dir, 'no-existe'), owner: main }),
    ).rejects.toThrow();
    expect(jobs.list()).toHaveLength(0);
  });

  it('el límite global libera primero la salida de los jobs ya terminados', async () => {
    const jobs = manager({ maxOutputChars: 4000, maxTotalOutputChars: 5000 });
    const big = node("for (let i = 0; i < 40; i++) console.log('x'.repeat(99))");
    const a = await jobs.start({ command: big, cwd: dir, owner: main });
    await jobs.waitFor(a.id, { until: 'end', timeoutMs: 20_000 });
    const b = await jobs.start({ command: big, cwd: dir, owner: main });
    await jobs.waitFor(b.id, { until: 'end', timeoutMs: 20_000 });

    const first = jobs.get(a.id)!;
    const second = jobs.get(b.id)!;
    const retained = (j: typeof first): number => j.outputChars - j.droppedChars;
    expect(retained(first) + retained(second)).toBeLessThanOrEqual(5000);
    // El más reciente conserva todo lo que su propio límite le deja.
    expect(retained(second)).toBe(4000);
  });

  it('olvida los jobs terminados más antiguos pasado maxRetained', async () => {
    const jobs = manager({ maxRetained: 2 });
    for (let i = 0; i < 3; i++) {
      const job = await jobs.start({ command: node('1'), cwd: dir, owner: main });
      await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    }
    expect(jobs.list().map((j) => j.id)).toEqual(['2', '3']);
    expect(() => jobs.readOutput('1', MAIN_JOB_SCOPE, { maxChars: 10 })).toThrow(JobNotFoundError);
  });
});

describe('JobManager — sin procesos huérfanos', () => {
  it('cancelar termina el árbol entero, no solo el proceso padre', async () => {
    const jobs = manager();
    const { command, pidFile } = treeCommand();
    const job = await jobs.start({ command, cwd: dir, owner: main });
    const pids = await readPids(pidFile);
    expect(alive(pids.parent)).toBe(true);
    expect(alive(pids.child)).toBe(true);

    const cancelled = await jobs.cancel(job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.endReason).toBe('cancelled');
    expect(cancelled.exitCode).toBeNull();

    expect(await waitUntil(() => !alive(pids.parent) && !alive(pids.child))).toBe(true);
    expect(alive(job.pid!)).toBe(false);
    // La salida capturada hasta la cancelación sigue ahí.
    expect(jobs.readOutput(job.id, MAIN_JOB_SCOPE, { maxChars: 100 }).slice.stdout).toContain(
      'ready',
    );
  });

  it('cancelar un job ya terminado no hace nada', async () => {
    const jobs = manager();
    const job = await jobs.start({ command: node('1'), cwd: dir, owner: main });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    expect((await jobs.cancel(job.id)).status).toBe('completed');
  });

  it('shutdown cancela todos los jobs vivos con su árbol', async () => {
    const jobs = manager();
    const { command, pidFile } = treeCommand();
    const a = await jobs.start({ command, cwd: dir, owner: main });
    const b = await jobs.start({
      command: node('setInterval(() => {}, 1000)'),
      cwd: dir,
      owner: main,
    });
    const pids = await readPids(pidFile);

    await jobs.shutdown();

    for (const id of [a.id, b.id]) {
      expect(jobs.get(id)).toMatchObject({ status: 'cancelled', endReason: 'session-closed' });
    }
    expect(await waitUntil(() => !alive(pids.parent) && !alive(pids.child) && !alive(b.pid!))).toBe(
      true,
    );
  });

  it('closeExecRuntime (el teardown de chat/run) apaga los jobs de todos los managers', async () => {
    const jobs = manager();
    const { command, pidFile } = treeCommand();
    const job = await jobs.start({ command, cwd: dir, owner: main });
    const pids = await readPids(pidFile);
    expect(liveJobManagers()).toBeGreaterThan(0);

    await closeExecRuntime();

    expect(jobs.get(job.id)!.status).toBe('cancelled');
    expect(await waitUntil(() => !alive(pids.parent) && !alive(pids.child))).toBe(true);
    expect(liveJobManagers()).toBe(0);
  });

  it('killAllSync (gancho de exit) mata el árbol sin esperar a nada', async () => {
    const jobs = manager();
    const { command, pidFile } = treeCommand();
    await jobs.start({ command, cwd: dir, owner: main });
    const pids = await readPids(pidFile);

    jobs.killAllSync();

    expect(await waitUntil(() => !alive(pids.parent) && !alive(pids.child))).toBe(true);
  });

  it('shutdownAllJobs no lanza aunque no haya nada que cerrar', async () => {
    await expect(shutdownAllJobs()).resolves.toBeUndefined();
  });
});

describe('JobManager — ownership y avisos', () => {
  it('un subagente solo accede a sus jobs; el principal, a todos los de la sesión', async () => {
    const jobs = manager();
    const mine = await jobs.start({ command: node('1'), cwd: dir, owner: main });
    const theirs = await jobs.start({ command: node('1'), cwd: dir, owner: { scope: 'sub_a' } });

    expect(jobs.canAccess('sub_a', mine, 'read')).toBe(false);
    expect(jobs.canAccess('sub_a', mine, 'cancel')).toBe(false);
    expect(jobs.canAccess('sub_b', theirs, 'read')).toBe(false);
    expect(jobs.canAccess('sub_a', theirs, 'cancel')).toBe(true);
    expect(jobs.canAccess(MAIN_JOB_SCOPE, theirs, 'cancel')).toBe(true);

    expect(jobs.list('sub_a').map((j) => j.id)).toEqual([theirs.id]);
    expect(jobs.list(MAIN_JOB_SCOPE).map((j) => j.id)).toEqual([mine.id, theirs.id]);
  });

  it('subagentAccess amplía lo que un subagente puede hacer con jobs ajenos', async () => {
    const readers = manager({ subagentAccess: 'read' });
    const job = await readers.start({ command: node('1'), cwd: dir, owner: main });
    expect(readers.canAccess('sub_a', job, 'read')).toBe(true);
    expect(readers.canAccess('sub_a', job, 'cancel')).toBe(false);

    const managersToo = manager({ subagentAccess: 'manage' });
    const other = await managersToo.start({ command: node('1'), cwd: dir, owner: main });
    expect(managersToo.canAccess('sub_a', other, 'cancel')).toBe(true);
  });

  it('closeScope cancela los jobs vivos del subagente que termina, y solo los suyos', async () => {
    const jobs = manager();
    const forever = node('setInterval(() => {}, 1000)');
    const parent = await jobs.start({ command: forever, cwd: dir, owner: main });
    const child = await jobs.start({ command: forever, cwd: dir, owner: { scope: 'sub_a' } });

    await jobs.closeScope('sub_a');

    expect(jobs.get(child.id)).toMatchObject({ status: 'cancelled', endReason: 'scope-closed' });
    expect(jobs.get(parent.id)!.status).toBe('running');
    expect(await waitUntil(() => !alive(child.pid!))).toBe(true);
  });

  it('el aviso de fin se entrega una sola vez, y solo al scope dueño', async () => {
    const jobs = manager();
    const trace = fakeTrace();
    const job = await jobs.start({
      command: node("console.log('x'); process.exit(2)"),
      cwd: dir,
      owner: main,
      trace: trace.scope,
    });
    expect(jobs.hasNotifications(MAIN_JOB_SCOPE)).toBe(false);
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });

    expect(jobs.takeNotifications('sub_a')).toEqual([]);
    expect(jobs.hasNotifications(MAIN_JOB_SCOPE)).toBe(true);
    const [notice] = jobs.takeNotifications(MAIN_JOB_SCOPE);
    expect(notice).toMatchObject({ id: job.id, status: 'failed', exitCode: 2, endReason: 'exit' });
    expect(notice!.unreadChars).toBeGreaterThan(0);
    expect(jobs.takeNotifications(MAIN_JOB_SCOPE)).toEqual([]);
    expect(trace.events.some((e) => e.event === 'job' && e.phase === 'notified')).toBe(true);
  });

  it('si el dueño ya vio el final por sí mismo, no se le vuelve a avisar', async () => {
    const jobs = manager();
    const job = await jobs.start({ command: node('1'), cwd: dir, owner: main });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    jobs.markSeen(job.id, MAIN_JOB_SCOPE);
    expect(jobs.takeNotifications(MAIN_JOB_SCOPE)).toEqual([]);
  });

  it('subscribe recibe created, started y ended en orden', async () => {
    const jobs = manager();
    const seen: string[] = [];
    const off = jobs.subscribe((ev) => seen.push(`${ev.type}:${ev.job.status}`));
    const job = await jobs.start({ command: node('1'), cwd: dir, owner: main });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    off();
    expect(seen).toEqual(['created:running', 'started:running', 'ended:completed']);
  });
});

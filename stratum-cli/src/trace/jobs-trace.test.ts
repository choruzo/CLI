import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { buildTraceModel, computeMetrics } from '../eval/metrics.js';
import { evaluateChecks, type CheckContext } from '../eval/checks.js';
import type { ScenarioCheck } from '../eval/scenario.js';
import { isBackgroundStep, isJobNotice } from './model.js';
import { TraceRecorder } from './recorder.js';
import { readTraceFile } from './read.js';
import { TRACE_CAP_JOBS, type TraceRecord } from './records.js';

/**
 * Jobs en segundo plano en la traza: el `JobManager` anota su ciclo de vida con
 * `TraceScope.runtime`, y de ahí salen las métricas. Las de tools no cambian.
 */

let dir: string;
let config: StratumConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobtrace-'));
  config = StratumConfigSchema.parse({ trace: { dir } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ended = {
  event: 'job' as const,
  phase: 'ended' as const,
  durationMs: 1200,
  stdoutBytes: 100,
  stderrBytes: 20,
  droppedChars: 0,
};

async function record(write: (rec: TraceRecorder) => void): Promise<TraceRecord[]> {
  const file = join(dir, 's.jsonl');
  const rec = new TraceRecorder({ file, sessionId: 's', config });
  write(rec);
  await rec.flush();
  return readTraceFile(file);
}

describe('ciclo de vida de un job en la traza', () => {
  it('cada fase es un punto notice, con el comando redactado y sin salida', async () => {
    const records = await record((rec) => {
      const scope = rec.scope();
      scope.turnStart('lanza', [{ role: 'user', content: 'lanza' }]);
      scope.event({
        type: 'tool_call_ready',
        id: 'c1',
        name: 'exec',
        input: { command: 'npm test', background: true },
      });
      scope.runtime({
        event: 'job',
        phase: 'created',
        jobId: '1',
        command: 'deploy --token sk-proj-abcdefghij0123456789abcdefghij0123456789',
        cwd: '/repo',
        scope: 'main',
      });
      scope.runtime({ event: 'job', phase: 'started', jobId: '1', pid: 4242 });
      scope.event({ type: 'tool_result', id: 'c1', name: 'exec', result: 'job 1', durationMs: 5 });
      scope.event({ type: 'tool_call_ready', id: 'c2', name: 'exec', input: { command: 'ls' } });
      scope.event({ type: 'tool_result', id: 'c2', name: 'exec', result: 'a', durationMs: 5 });
      scope.runtime({
        event: 'job',
        phase: 'read',
        jobId: '1',
        scope: 'main',
        offset: 0,
        chars: 80,
        finished: false,
      });
      scope.runtime({
        ...ended,
        jobId: '1',
        status: 'failed',
        exitCode: 2,
        reason: 'exit',
        outputRead: true,
      });
      scope.event({
        type: 'job_notice',
        jobs: [{ id: '1', command: 'npm test', status: 'failed', exitCode: 2, durationMs: 1200 }],
      });
      scope.runtime({
        event: 'job',
        phase: 'notified',
        jobId: '1',
        status: 'failed',
        scope: 'main',
      });
      scope.turnEnd('stop');
    });

    expect(records[0]).toMatchObject({ t: 'meta', caps: expect.arrayContaining([TRACE_CAP_JOBS]) });
    expect(JSON.stringify(records)).not.toContain('sk-proj-abcdefghij');

    const model = buildTraceModel(records);
    const jobSteps = model.steps.filter(isJobNotice);
    expect(jobSteps.map((s) => s.data.phase)).toEqual([
      'created',
      'started',
      'read',
      'ended',
      'notified',
    ]);
    expect(jobSteps[3]).toMatchObject({ status: 'error', name: 'Job #1: terminó (failed)' });
    // El aviso que entra en el contexto del modelo es un paso `context`.
    expect(model.steps.some((s) => s.kind === 'context' && /Aviso de jobs/.test(s.name))).toBe(
      true,
    );

    expect(computeMetrics(records)).toMatchObject({
      toolCalls: 2,
      // Un job que falla no es un error de la tool que lo lanzó…
      toolErrors: 0,
      // …ni un aviso, ni un error del agente.
      warnings: 0,
      fatalErrors: 0,
      hadErrors: false,
      foregroundExecCalls: 1,
      backgroundExecCalls: 1,
      jobsStarted: 1,
      jobsCompleted: 0,
      jobsFailed: 1,
      jobsCancelled: 0,
      jobsOutputRead: 1,
      jobNotifications: 1,
      jobOutputBytes: 120,
    });
  });

  it('un job que termina con el turno cerrado no alarga el turno', async () => {
    const file = join(dir, 'late.jsonl');
    const base: TraceRecord[] = [
      { t: 'meta', v: 1, at: 0, sessionId: 'late', caps: ['runtime', 'llm-origin', 'jobs'] },
      { t: 'turn', at: 1000, input: 'x' },
      {
        t: 'point',
        at: 1100,
        id: 'a',
        kind: 'notice',
        name: 'Job #1: arrancó',
        data: { event: 'job', phase: 'started', jobId: '1', pid: 1 },
      },
      { t: 'turn_end', at: 2000, stopReason: 'stop' },
      {
        t: 'point',
        at: 60_000,
        id: 'b',
        kind: 'notice',
        name: 'Job #1: terminó (completed)',
        data: {
          ...ended,
          jobId: '1',
          status: 'completed',
          exitCode: 0,
          reason: 'exit',
          outputRead: false,
        },
      },
    ];
    writeFileSync(file, base.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const records = readTraceFile(file);
    const model = buildTraceModel(records);
    const late = model.steps.find((s) => s.id === 'b')!;
    expect(isBackgroundStep(model, late)).toBe(true);
    expect(isBackgroundStep(model, model.steps.find((s) => s.id === 'a')!)).toBe(false);
    const metrics = computeMetrics(records);
    expect(metrics.durationMs).toBe(1000);
    expect(metrics).toMatchObject({ jobsStarted: 1, jobsCompleted: 1, jobsOutputRead: 0 });
  });

  it('una traza anterior al cap no sabe nada de jobs: null, no cero', async () => {
    const records: TraceRecord[] = [
      { t: 'meta', v: 1, at: 0, sessionId: 'old', caps: ['runtime'] },
      { t: 'turn', at: 1, input: 'x' },
      { t: 'turn_end', at: 2, stopReason: 'stop' },
    ];
    expect(computeMetrics(records)).toMatchObject({
      jobsStarted: null,
      jobsFailed: null,
      jobsOutputRead: null,
      foregroundExecCalls: 0,
      backgroundExecCalls: 0,
    });
  });

  it('leer la salida de un job dos veces con los mismos argumentos no es una acción repetida', async () => {
    const records = await record((rec) => {
      const scope = rec.scope();
      scope.turnStart('x', [{ role: 'user', content: 'x' }]);
      for (const id of ['c1', 'c2', 'c3']) {
        scope.event({ type: 'tool_call_ready', id, name: 'get_job_output', input: { jobId: '1' } });
        scope.event({
          type: 'tool_result',
          id,
          name: 'get_job_output',
          result: 'x',
          durationMs: 1,
        });
      }
      scope.turnEnd('stop');
    });
    expect(computeMetrics(records).repeatedCalls).toBe(0);
  });
});

describe('criterios de eval sobre jobs', () => {
  async function ctxFor(records: TraceRecord[], workDir: string): Promise<CheckContext> {
    return {
      mode: 'mock',
      workDir,
      exitCode: 0,
      output: '',
      model: buildTraceModel(records),
      metrics: computeMetrics(records),
    };
  }

  it('runtime_event job casa por fase y por fase:resultado', async () => {
    const records = await record((rec) => {
      const scope = rec.scope();
      scope.turnStart('x', [{ role: 'user', content: 'x' }]);
      scope.runtime({ event: 'job', phase: 'started', jobId: '1', pid: 1 });
      scope.runtime({
        ...ended,
        jobId: '1',
        status: 'cancelled',
        exitCode: null,
        reason: 'session-closed',
        outputRead: false,
      });
      scope.turnEnd('stop');
    });
    const check = (detail: string, min = 1, max?: number): ScenarioCheck => ({
      type: 'runtime_event',
      event: 'job',
      detail,
      min,
      ...(max !== undefined ? { max } : {}),
    });
    const results = await evaluateChecks(
      [
        check('started'),
        check('ended:cancelled'),
        check('ended:session-closed'),
        check('ended:failed', 0, 0),
        check('ended:completed'),
      ],
      await ctxFor(records, dir),
    );
    expect(results.map((r) => r.pass)).toEqual([true, true, true, true, false]);
  });

  it('processes_gone exige que los pids del fichero ya no existan', async () => {
    const ctx = await ctxFor([], dir);
    const check: ScenarioCheck = { type: 'processes_gone', pidFile: 'pids.json' };

    expect((await evaluateChecks([check], ctx))[0]).toMatchObject({
      pass: false,
      detail: expect.stringContaining('no existe'),
    });

    // Un pid que casi seguro no existe.
    writeFileSync(join(dir, 'pids.json'), JSON.stringify({ parent: 2 ** 22 + 12345 }));
    expect((await evaluateChecks([check], ctx))[0]!.pass).toBe(true);

    // Este proceso sí está vivo.
    writeFileSync(join(dir, 'pids.json'), JSON.stringify([process.pid]));
    const alive = (await evaluateChecks([check], ctx))[0]!;
    expect(alive.pass).toBe(false);
    expect(alive.detail).toContain(String(process.pid));
  }, 20_000);
});

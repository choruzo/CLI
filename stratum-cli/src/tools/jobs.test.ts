import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolDispatcher,
  ToolRegistry,
  isToolVisibleForProfile,
  isToolVisibleInMode,
} from './registry.js';
import { registerBuiltinTools } from './index.js';
import { callEffects } from './environments.js';
import { READ_ONLY_TOOLSET } from './call-policy.js';
import { createExecTool } from './exec/exec.js';
import { resetExecRuntime } from './exec/runtime.js';
import { formatJobNotifications } from './jobs.js';
import { JobManager } from '../jobs/manager.js';
import { JOB_TOOLS, MAIN_JOB_SCOPE } from '../jobs/types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type {
  DestructiveDecision,
  ToolCallReady,
  ToolContext,
  ToolResult,
} from '../agent/types.js';
import type { TraceScope } from '../trace/recorder.js';
import type { TraceRuntimeEvent } from '../trace/records.js';

const node = (script: string): string => `node -e "${script}"`;
const FOREVER = node('setInterval(() => {}, 1000)');

let dir: string;
let managers: JobManager[];

function setup(raw: Record<string, unknown> = {}): {
  config: StratumConfig;
  jobs: JobManager;
  dispatcher: ToolDispatcher;
  registry: ToolRegistry;
  ctx: (overrides?: Partial<ToolContext>) => ToolContext;
  call: (
    name: string,
    input: Record<string, unknown>,
    c?: Partial<ToolContext>,
  ) => Promise<ToolResult>;
} {
  const tools = (raw.tools ?? {}) as Record<string, unknown>;
  const config = StratumConfigSchema.parse({ ...raw, tools: { auditLog: false, ...tools } });
  const jobs = new JobManager(config, { killGraceMs: 300 });
  managers.push(jobs);
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  const dispatcher = new ToolDispatcher(registry);
  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    signal: new AbortController().signal,
    cwd: dir,
    config,
    jobs,
    jobScope: MAIN_JOB_SCOPE,
    destructivePolicy: 'ask',
    ...overrides,
  });
  let seq = 0;
  const call = async (
    name: string,
    input: Record<string, unknown>,
    c: Partial<ToolContext> = {},
  ): Promise<ToolResult> => {
    const ready: ToolCallReady = { id: `c${++seq}`, name, input };
    const [res] = await dispatcher.dispatch([ready], ctx(c));
    return res!.result;
  };
  return { config, jobs, dispatcher, registry, ctx, call };
}

function text(result: ToolResult): string {
  return result.ok ? result.output : result.error;
}

function attr(xml: string, name: string): string {
  return new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1] ?? '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobtools-'));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  resetExecRuntime();
  // En Windows el directorio de trabajo de un proceso recién terminado tarda
  // un instante en liberarse, aunque el proceso ya no exista.
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});

describe('exec con background: true', () => {
  it('devuelve el jobId en el acto y el proceso sigue corriendo', async () => {
    const { call, jobs } = setup();
    const started = Date.now();
    const result = await call('exec', { command: FOREVER, background: true });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const out = text(result);
    expect(attr(out, 'jobId')).toBe('1');
    expect(out).toContain('[background job #1 started:');
    expect(jobs.get('1')).toMatchObject({ status: 'running', owner: { scope: MAIN_JOB_SCOPE } });
  });

  it('solo en el target local', async () => {
    const { call, jobs } = setup({
      ssh: { hosts: { web: { host: '127.0.0.1', user: 'u', password: 'x' } } },
    });
    const result = await call('exec', { command: 'uptime', target: 'ssh:web', background: true });
    expect(result.ok).toBe(false);
    expect(text(result)).toContain('only supported on target "local"');
    expect(jobs.list()).toHaveLength(0);
  });

  it('sin JobManager en la sesión, o con los jobs desactivados, se rechaza sin ejecutar', async () => {
    const a = setup();
    const noJobs = await a.call(
      'exec',
      { command: FOREVER, background: true },
      { jobs: undefined },
    );
    expect(text(noJobs)).toContain('not available in this session');

    const b = setup({ tools: { jobs: { enabled: false } } });
    const disabled = await b.call('exec', { command: FOREVER, background: true });
    expect(text(disabled)).toContain('tools.jobs.enabled');
    expect(b.jobs.list()).toHaveLength(0);
    // Y sus tools ni se registran.
    for (const name of JOB_TOOLS) expect(b.registry.get(name)).toBeUndefined();
  });

  it('maxRunning se devuelve como error recuperable que no cuenta como fallo de la tool', async () => {
    const { call } = setup({ tools: { jobs: { maxRunning: 1 } } });
    await call('exec', { command: FOREVER, background: true });
    const second = await call('exec', { command: FOREVER, background: true });
    expect(second).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
    expect(text(second)).toContain('tools.jobs.maxRunning');
  });
});

describe('background no se salta ninguna guarda', () => {
  const samples = [
    'rm -r build',
    'git push --force',
    'ls -la',
    'git status',
    'cat .env',
    'npm test',
    'DROP TABLE users',
  ];

  it('la clasificación destructiva no depende de background', () => {
    const { config, ctx } = setup();
    const exec = createExecTool(config);
    for (const command of samples) {
      expect(exec.isDestructive!({ command, background: true }, ctx())).toBe(
        exec.isDestructive!({ command }, ctx()),
      );
    }
  });

  it('los efectos (read-only, entornos) tampoco', () => {
    for (const command of samples) {
      expect(callEffects('exec', { command, background: true })).toEqual(
        callEffects('exec', { command }),
      );
    }
  });

  it('un comando destructivo en background se bloquea igual sin nadie que confirme', async () => {
    const { call, jobs } = setup();
    const result = await call(
      'exec',
      { command: 'rm -r build', background: true },
      { destructivePolicy: 'deny' },
    );
    expect(result.ok).toBe(false);
    expect(text(result)).toContain('Destructive operation blocked');
    expect(jobs.list()).toHaveLength(0);
  });

  it('pide la misma confirmación, y si se deniega no arranca nada', async () => {
    const { call, jobs } = setup();
    const confirm = vi.fn(async (_req: unknown): Promise<DestructiveDecision> => 'deny');
    const result = await call(
      'exec',
      { command: 'rm -r build', background: true },
      { confirmDestructive: confirm },
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toMatchObject({ toolName: 'exec' });
    expect(text(result)).toContain('User denied');
    expect(jobs.list()).toHaveLength(0);
  });

  it('el hard-deny es inapelable también en background, y queda en la traza', async () => {
    const { call, jobs } = setup();
    const events: TraceRuntimeEvent[] = [];
    const trace = {
      runtime: (ev: TraceRuntimeEvent) => void events.push(ev),
    } as unknown as TraceScope;
    const result = await call(
      'exec',
      { command: 'rm -rf /', background: true },
      { destructivePolicy: 'allow', trace },
    );
    expect(result).toMatchObject({ ok: false, recoverable: false });
    expect(text(result)).toContain('non-negotiable safety rule');
    expect(jobs.list()).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'veto', source: 'preflight' }));
  });

  it('una sesión read-only veta un job que muta y deja pasar uno que solo observa', async () => {
    const { call, jobs } = setup();
    const write = await call(
      'exec',
      { command: 'touch nuevo.txt', background: true },
      { readOnly: true },
    );
    expect(text(write)).toContain('Read-only session');
    expect(jobs.list()).toHaveLength(0);

    const read = await call(
      'exec',
      { command: 'git status', background: true },
      { readOnly: true },
    );
    expect(read.ok).toBe(true);
  });

  it('un entorno read-only o confirm-always manda igual sobre un job', async () => {
    const ro = setup({ environments: { lab: { match: ['local'], readOnly: true } } });
    const vetoed = await ro.call('exec', { command: 'touch x', background: true });
    expect(text(vetoed)).toContain('Environment "lab" is read-only');
    expect(ro.jobs.list()).toHaveLength(0);

    const prod = setup({
      environments: { prod: { match: ['local'], tier: 'production' } },
    });
    const blocked = await prod.call(
      'exec',
      { command: 'touch x', background: true },
      { destructivePolicy: 'allow' },
    );
    expect(text(blocked)).toContain('requires the user to approve every change');
    expect(prod.jobs.list()).toHaveLength(0);
  });

  it('una ruta sensible bloqueada sigue bloqueada', async () => {
    const { call, jobs } = setup();
    const result = await call('exec', { command: 'cat ~/.ssh/id_rsa', background: true });
    expect(result).toMatchObject({ ok: false, recoverable: false });
    expect(jobs.list()).toHaveLength(0);
  });

  it('la salida de un job sale redactada por la frontera del dispatcher', async () => {
    const { call, jobs } = setup();
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const started = await call('exec', {
      command: node(`console.log('${token}')`),
      background: true,
    });
    expect(text(started)).not.toContain(token);
    await jobs.waitFor('1', { until: 'end', timeoutMs: 20_000 });
    const output = await call('get_job_output', { jobId: '1' });
    expect(text(output)).not.toContain(token);
    expect(text(output)).toContain('[redacted:');
  });
});

describe('tools de jobs', () => {
  it('get_job_output lee por partes: lo nuevo en cada llamada, y el final', async () => {
    const { call } = setup();
    await call('exec', {
      command: node(
        "let i = 0; const t = setInterval(() => { console.log('linea ' + i); if (++i === 4) clearInterval(t); }, 300)",
      ),
      background: true,
    });

    const first = text(await call('get_job_output', { jobId: 1, waitMs: 15_000 }));
    expect(first).toContain('linea 0');
    expect(first).not.toContain('linea 3');
    expect(attr(first, 'finished')).toBe('false');

    const status = text(await call('get_job_status', { jobId: '#1', waitMs: 15_000 }));
    expect(attr(status, 'status')).toBe('completed');
    expect(attr(status, 'exitCode')).toBe('0');

    const rest = text(await call('get_job_output', { jobId: '1' }));
    expect(attr(rest, 'offset')).toBe(attr(first, 'nextOffset'));
    expect(rest).not.toContain('linea 0');
    expect(rest).toContain('linea 3');
    expect(attr(rest, 'finished')).toBe('true');
    expect(attr(rest, 'nextOffset')).toBe(attr(rest, 'totalChars'));
  });

  it('get_job_output respeta maxChars, offset y tail', async () => {
    const { call, jobs } = setup();
    await call('exec', {
      command: node(
        "for (let i = 0; i < 50; i++) console.log('fila-' + String(i).padStart(3, '0'))",
      ),
      background: true,
    });
    await jobs.waitFor('1', { until: 'end', timeoutMs: 20_000 });

    const head = text(await call('get_job_output', { jobId: '1', maxChars: 30 }));
    expect(head).toContain('fila-000');
    expect(head).not.toContain('fila-010');
    expect(head).toContain('More output is available');

    const tail = text(await call('get_job_output', { jobId: '1', tail: true, maxChars: 30 }));
    expect(tail).toContain('fila-049');
    expect(tail).not.toContain('fila-000');

    const again = text(await call('get_job_output', { jobId: '1', offset: 0, maxChars: 30 }));
    expect(again).toContain('fila-000');

    const both = await call('get_job_output', { jobId: '1', offset: 0, tail: true });
    expect(both.ok).toBe(false);
  });

  it('un job fallido deja leer su stderr', async () => {
    const { call, jobs } = setup();
    await call('exec', {
      command: node("console.error('fallo grave'); process.exit(7)"),
      background: true,
    });
    await jobs.waitFor('1', { until: 'end', timeoutMs: 20_000 });
    const status = text(await call('get_job_status', { jobId: '1' }));
    expect(attr(status, 'status')).toBe('failed');
    expect(attr(status, 'exitCode')).toBe('7');
    const output = text(await call('get_job_output', { jobId: '1' }));
    expect(output).toMatch(/<stderr>[^<]*fallo grave/);
  });

  it('cancel_job detiene el job y list_jobs lo refleja', async () => {
    const { call, jobs } = setup();
    await call('exec', { command: FOREVER, background: true });
    const pid = jobs.get('1')!.pid!;

    const running = text(await call('list_jobs', {}));
    expect(attr(running, 'count')).toBe('1');
    expect(running).toContain('status="running"');

    const cancelled = text(await call('cancel_job', { jobId: '1' }));
    expect(attr(cancelled, 'status')).toBe('cancelled');
    expect(() => process.kill(pid, 0)).toThrow();

    expect(text(await call('list_jobs', { status: 'running' }))).toContain('count="0"');
    expect(text(await call('list_jobs', {}))).toContain('status="cancelled"');
    // Lo canceló él: no hace falta avisarle después.
    expect(jobs.takeNotifications(MAIN_JOB_SCOPE)).toEqual([]);
  });

  it('un scope no ve ni manipula los jobs de otro; el principal sí los de un hijo', async () => {
    const { call, jobs } = setup();
    await call('exec', { command: FOREVER, background: true });
    await call('exec', { command: FOREVER, background: true }, { jobScope: 'sub_a' });
    expect(jobs.get('2')!.owner.scope).toBe('sub_a');

    const asChild = { jobScope: 'sub_a' };
    expect(text(await call('list_jobs', {}, asChild))).toContain('count="1"');
    for (const tool of ['get_job_status', 'get_job_output', 'cancel_job']) {
      const res = await call(tool, { jobId: '1' }, asChild);
      expect(res).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
      expect(text(res)).toContain('No background job with id "1"');
    }
    expect(jobs.get('1')!.status).toBe('running');

    // Otro subagente tampoco toca el de su hermano.
    expect((await call('cancel_job', { jobId: '2' }, { jobScope: 'sub_b' })).ok).toBe(false);
    expect(jobs.get('2')!.status).toBe('running');

    expect(text(await call('list_jobs', {}))).toContain('count="2"');
    expect(text(await call('list_jobs', {}))).toContain('owner="sub_a"');
    expect((await call('cancel_job', { jobId: '2' })).ok).toBe(true);
    expect(jobs.get('2')!.status).toBe('cancelled');
  });

  it('un id que no existe responde igual que uno ajeno', async () => {
    const { call } = setup();
    const res = await call('get_job_status', { jobId: '99' });
    expect(text(res)).toContain('No background job with id "99"');
  });
});

describe('visibilidad de las tools de jobs', () => {
  it('siguen a exec en perfiles, read-only y modos', () => {
    for (const name of JOB_TOOLS) {
      expect(isToolVisibleForProfile(name, { allowedTools: ['exec'] })).toBe(true);
      expect(isToolVisibleForProfile(name, { allowedTools: ['read_file'] })).toBe(false);
      expect(isToolVisibleForProfile(name, { allowedTools: null, hiddenTools: ['exec'] })).toBe(
        false,
      );
      expect(isToolVisibleForProfile(name, READ_ONLY_TOOLSET)).toBe(true);
      expect(isToolVisibleInMode(name, 'plan')).toBe(true);
      expect(isToolVisibleInMode(name, 'normal')).toBe(true);
      expect(callEffects(name, { jobId: '1' })).toMatchObject({ known: true, mutating: false });
    }
  });

  it('se ofrecen justo detrás de exec', () => {
    const { registry } = setup();
    const names = registry.toToolSchemas().map((t) => t.function.name);
    const at = names.indexOf('exec');
    expect(names.slice(at + 1, at + 5)).toEqual([...JOB_TOOLS]);
  });
});

describe('formatJobNotifications', () => {
  it('una línea por job, con lo justo para decidir si leer la salida', () => {
    const out = formatJobNotifications([
      {
        id: '12',
        command: 'npm test',
        status: 'completed',
        exitCode: 0,
        endReason: 'exit',
        durationMs: 38_200,
        unreadChars: 0,
      },
      {
        id: '13',
        command: 'cargo build',
        status: 'failed',
        exitCode: 101,
        endReason: 'exit',
        durationMs: 4000,
        unreadChars: 512,
      },
    ]);
    expect(out).toContain('Background job #12 (npm test) completed with exit code 0 after 38.2s.');
    expect(out).toContain('Background job #13 (cargo build) failed (exit 101) after 4.0s.');
    expect(out).toContain('get_job_output(jobId="13")');
  });
});

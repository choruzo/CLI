import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { appendRuntimeNotice, pushUserInput } from './cancel.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { resetExecRuntime } from '../tools/exec/runtime.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { JobManager } from '../jobs/manager.js';
import { MAIN_JOB_SCOPE } from '../jobs/types.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { AgentEvent, Message, RunOptions, SubagentRouter } from './types.js';
import type { IProvider } from '../providers/base.js';

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });
const node = (script: string): string => `node -e "${script}"`;
const FOREVER = node('setInterval(() => {}, 1000)');

let dir: string;
let jobs: JobManager;

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

function loopFor(provider: IProvider, messages: Message[], extras = {}): ReactLoop {
  return new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, extras);
}

function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

/** Roles seguidos iguales entre `user`: lo que rompería una plantilla estricta. */
function consecutiveUsers(messages: Message[]): number {
  let n = 0;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.role === 'user' && messages[i - 1]!.role === 'user') n++;
  }
  return n;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-jobsflow-'));
  jobs = new JobManager(config, { killGraceMs: 300 });
});

afterEach(async () => {
  await jobs.shutdown();
  resetExecRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe('aviso de jobs en el loop', () => {
  it('a mitad de turno el aviso acompaña al último resultado de tool, sin mensaje nuevo', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: node("console.log('fin')"), background: true }),
      // Trabajo en primer plano mientras el job termina.
      makeToolCallRound('c2', 'exec', { command: node('setTimeout(() => {}, 2500)') }),
      makeTextRound('Todo listo.'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'lanza y sigue' },
    ];

    const events = await collect(loopFor(provider, messages).run({ jobs }));

    const notice = events.find((e) => e.type === 'job_notice');
    expect(notice).toMatchObject({ jobs: [{ id: '1', status: 'completed', exitCode: 0 }] });
    // El aviso llega justo antes de la tercera llamada al modelo.
    const order = events.map((e) => e.type);
    expect(order.indexOf('job_notice')).toBeGreaterThan(order.lastIndexOf('tool_result'));

    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    const lastTool = messages.filter((m) => m.role === 'tool').at(-1)!;
    expect(lastTool.tool_call_id).toBe('c2');
    expect(lastTool.content).toContain('<background_jobs>');
    expect(lastTool.content).toContain('Background job #1');
    expect(lastTool.content).toContain('completed with exit code 0');
    // Entregado una vez: no queda nada pendiente.
    expect(jobs.hasNotifications(MAIN_JOB_SCOPE)).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('un job que termina con el agente parado no fuerza una llamada: espera al turno siguiente', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: node('process.exit(4)'), background: true }),
      makeTextRound('Lanzado.'),
      makeTextRound('Ya lo he visto.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];

    pushUserInput(messages, 'lanza los tests');
    await collect(loopFor(provider, messages).run({ jobs }));
    await jobs.waitFor('1', { until: 'end', timeoutMs: 20_000 });

    // Terminó sin turno abierto: el aviso queda pendiente y el modelo no se llama.
    expect(provider.callCount).toBe(2);
    expect(jobs.hasNotifications(MAIN_JOB_SCOPE)).toBe(true);

    pushUserInput(messages, '¿cómo va?');
    const events = await collect(loopFor(provider, messages).run({ jobs }));

    expect(events.some((e) => e.type === 'job_notice')).toBe(true);
    const last = messages.filter((m) => m.role === 'user').at(-1)!;
    expect(last.content).toMatch(/^¿cómo va\?/);
    expect(last.content).toContain('Background job #1');
    expect(last.content).toContain('failed (exit 4)');
    expect(consecutiveUsers(messages)).toBe(0);
    expect(provider.callCount).toBe(3);
  });

  it('si el agente ya vio el final con una tool, no se le repite', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: node('1'), background: true }),
      makeToolCallRound('c2', 'get_job_status', { jobId: '1', waitMs: 20_000 }),
      makeTextRound('Hecho.'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x' },
    ];
    const events = await collect(loopFor(provider, messages).run({ jobs }));
    expect(events.some((e) => e.type === 'job_notice')).toBe(false);
    expect(messages.some((m) => (m.content ?? '').includes('<background_jobs>'))).toBe(false);
  });

  it('cancelar el turno no cancela el job', async () => {
    const abort = new AbortController();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: FOREVER, background: true }),
      makeTextRound('nunca llega'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x' },
    ];
    for await (const ev of loopFor(provider, messages).run({ jobs, signal: abort.signal })) {
      if (ev.type === 'tool_result') abort.abort();
    }
    expect(jobs.get('1')!.status).toBe('running');
  });
});

describe('appendRuntimeNotice', () => {
  it('se anexa al último user o tool y solo crea un mensaje si no hay dónde', () => {
    const afterTool: Message[] = [
      { role: 'user', content: 'tarea' },
      { role: 'assistant', content: null },
      { role: 'tool', content: 'salida', tool_call_id: 'a' },
    ];
    const tool = afterTool[2]!;
    appendRuntimeNotice(afterTool, 'AVISO');
    expect(afterTool).toHaveLength(3);
    // Mismo objeto: la traza ya lo conoce y no lo cuenta como entrada nueva.
    expect(afterTool[2]).toBe(tool);
    expect(tool.content).toBe('salida\n\nAVISO');

    const afterAssistant: Message[] = [{ role: 'assistant', content: 'hola' }];
    appendRuntimeNotice(afterAssistant, 'AVISO');
    expect(afterAssistant.at(-1)).toEqual({ role: 'user', content: 'AVISO' });
  });
});

describe('jobs y subagentes', () => {
  it('un hijo no toca los jobs del padre, y los suyos mueren con él', async () => {
    const parent = new MockProvider([
      makeToolCallRound('p1', 'exec', { command: FOREVER, background: true }),
      makeToolCallRound('p2', 'delegate_task', { task: 'trabaja', profile: 'general' }),
      makeTextRound('Fin.'),
    ]);
    const child = new MockProvider([
      makeToolCallRound('k1', 'cancel_job', { jobId: '1' }),
      makeToolCallRound('k2', 'list_jobs', {}),
      makeToolCallRound('k3', 'exec', { command: FOREVER, background: true }),
      makeTextRound('He terminado.'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x' },
    ];
    const loop = loopFor(parent, messages, {
      profiles: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-'))),
    });
    const opts: RunOptions = { jobs, makeSubagentRouter: () => mockRouter(child) };

    const events = await collect(loop.run(opts));

    const childEvents = events.flatMap((e) => (e.type === 'subagent_event' ? [e.event] : []));
    const denied = childEvents.find((e) => e.type === 'tool_error' && e.name === 'cancel_job');
    expect(denied).toMatchObject({
      error: expect.stringContaining('No background job with id "1"'),
    });
    const listed = childEvents.find((e) => e.type === 'tool_result' && e.name === 'list_jobs');
    expect(listed).toMatchObject({ result: expect.stringContaining('count="0"') });

    // El job del padre sigue vivo; el del hijo se canceló al cerrar su scope.
    expect(jobs.get('1')).toMatchObject({ status: 'running', owner: { scope: MAIN_JOB_SCOPE } });
    const childJob = jobs.get('2')!;
    expect(childJob.owner.scope).toMatch(/^sub_/);
    expect(childJob).toMatchObject({ status: 'cancelled', endReason: 'scope-closed' });
    expect(() => process.kill(childJob.pid!, 0)).toThrow();
    // Al padre no se le avisa de un job que no era suyo.
    expect(events.some((e) => e.type === 'job_notice')).toBe(false);
  });
});

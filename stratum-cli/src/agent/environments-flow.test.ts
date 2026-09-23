import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, Message, PlanDecision, RunOptions, SubagentRouter } from './types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';

const config: StratumConfig = StratumConfigSchema.parse({
  environments: {
    prod: { match: ['ssh:prod-*'], tier: 'production', requirePlan: true, policy: 'ask' },
  },
});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** Proveedor que además apunta las tools que se ofrecieron en cada petición. */
class RecordingProvider implements IProvider {
  readonly offered: string[][] = [];
  private readonly inner: MockProvider;
  constructor(rounds: OpenAIStreamChunk[][]) {
    this.inner = new MockProvider(rounds);
  }
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.offered.push((req.tools ?? []).map((t) => t.function.name));
    yield* this.inner.complete(req);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Registry real con una `exec` falsa (no ejecuta nada, apunta lo que recibe). */
function registryWithFakeExec() {
  const run = vi.fn(async (params: unknown) => ({
    ok: true as const,
    output: `ran: ${(params as { command: string }).command}`,
  }));
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  registry.register({
    name: 'exec',
    description: 'fake exec',
    schema: z.object({ command: z.string(), target: z.string().optional() }),
    execute: run,
  });
  return { registry, run };
}

const errors = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'tool_error' }> => e.type === 'tool_error');

describe('requirePlan de un entorno (Hito 17)', () => {
  it('un cambio en prod escala a modo plan; tras aprobar, se ejecuta', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new RecordingProvider([
      makeToolCallRound('c1', 'exec', { command: 'systemctl restart api', target: 'ssh:prod-1' }),
      // ya en modo plan: observar está permitido
      makeToolCallRound('c2', 'exec', { command: 'systemctl status api', target: 'ssh:prod-1' }),
      makeToolCallRound('c3', 'present_plan', {
        summary: 'Reiniciar api',
        steps: [{ title: 'Reiniciar el servicio' }],
      }),
      makeToolCallRound('c4', 'exec', { command: 'systemctl restart api', target: 'ssh:prod-1' }),
      makeTextRound('Hecho.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, registry, messages, config, 'm', 32768);
    const approve = vi.fn(async (plan): Promise<PlanDecision> => ({ decision: 'approve', plan }));

    const events = await collect(loop.run({ onApprovePlan: approve }));

    expect(events).toContainEqual({ type: 'warning', message: 'plan_required:prod' });
    const first = errors(events)[0]!;
    expect(first.id).toBe('c1');
    expect(first.error).toContain('PLAN MODE');
    expect(approve).toHaveBeenCalledTimes(1);
    // status (Fase 1) y restart (Fase 3) — el primer restart nunca corrió.
    expect(run.mock.calls.map((c) => (c[0] as { command: string }).command)).toEqual([
      'systemctl status api',
      'systemctl restart api',
    ]);
    // Tras escalar, el schema es el de Fase 1: sin write_file, con exec y present_plan.
    const phase1 = provider.offered[1]!;
    expect(phase1).toContain('present_plan');
    expect(phase1).toContain('exec');
    expect(phase1).not.toContain('write_file');
  });

  it('sin gate de aprobación (subagente, CI) solo rechaza y no escala', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: 'rm -f /srv/x', target: 'ssh:prod-1' }),
      makeTextRound('No puedo.'),
    ]);
    const loop = new ReactLoop(provider, registry, [], config, 'm', 32768);
    const events = await collect(loop.run({}));
    expect(errors(events)[0]!.error).toContain('cannot present one');
    expect(events.some((e) => e.type === 'warning')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('leer en prod nunca exige plan', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: 'df -h', target: 'ssh:prod-1' }),
      makeTextRound('ok'),
    ]);
    const loop = new ReactLoop(provider, registry, [], config, 'm', 32768);
    const events = await collect(loop.run({}));
    expect(errors(events)).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('planApproved (hijo delegado en Fase 3) satisface requirePlan', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: 'systemctl restart api', target: 'ssh:prod-1' }),
      makeTextRound('ok'),
    ]);
    const loop = new ReactLoop(provider, registry, [], config, 'm', 32768);
    await collect(loop.run({ planApproved: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('Fase 1 del modo plan admite exec read-only (Hito 17)', () => {
  it('un comando que observa corre; uno que cambia se rechaza con motivo', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: 'git status' }),
      makeToolCallRound('c2', 'exec', { command: 'npm install' }),
      makeToolCallRound('c3', 'present_plan', { summary: 's', steps: [{ title: 't' }] }),
    ]);
    const loop = new ReactLoop(provider, registry, [], config, 'm', 32768);
    const events = await collect(
      loop.run({ mode: 'plan', onApprovePlan: async () => ({ decision: 'reject' }) }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    const err = errors(events)[0]!;
    expect(err.id).toBe('c2');
    expect(err.error).toContain('only read-only commands');
    expect(err.error).toContain('npm');
  });
});

describe('modo read-only en el loop (Hito 17)', () => {
  it('oculta las tools que escriben y rechaza las que el modelo invente', async () => {
    const { registry, run } = registryWithFakeExec();
    const provider = new RecordingProvider([
      makeToolCallRound('c1', 'write_file', { path: 'x.txt', content: 'y' }),
      makeToolCallRound('c2', 'exec', { command: 'cat x.txt' }),
      makeToolCallRound('c3', 'exec', { command: 'rm x.txt' }),
      makeTextRound('fin'),
    ]);
    const loop = new ReactLoop(provider, registry, [], config, 'm', 32768);
    const events = await collect(loop.run({ readOnly: true, destructivePolicy: 'allow' }));

    const offered = provider.offered[0]!;
    expect(offered).toContain('exec');
    expect(offered).toContain('read_file');
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('edit_file');
    expect(offered).not.toContain('store_decision');

    const errs = errors(events);
    expect(errs.map((e) => e.id)).toEqual(['c1', 'c3']);
    expect(errs[0]!.error).toContain('read-only session');
    expect(errs[1]!.error).toContain('Read-only session');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('un subagente hereda el modo read-only del padre', async () => {
    const { registry, run } = registryWithFakeExec();
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 'limpia', profile: 'general' }),
      makeTextRound('listo'),
    ]);
    const child = new MockProvider([
      makeToolCallRound('k1', 'exec', { command: 'rm -rf build' }),
      makeTextRound('no pude'),
    ]);
    const childRouter: SubagentRouter = {
      getActive: () => child,
      model: 'mock',
      providerName: 'mock',
      contextWindow: 32768,
      hasFallback: false,
      advanceProvider: () => null,
      switchModel: () => undefined,
    };
    const loop = new ReactLoop(parent, registry, [], config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-h17-'))),
    });
    const opts: RunOptions = { readOnly: true, makeSubagentRouter: () => childRouter };
    const events = await collect(loop.run(opts));

    const childErrors = events
      .filter((e) => e.type === 'subagent_event')
      .map((e) => (e as { event: AgentEvent }).event)
      .filter((e) => e.type === 'tool_error');
    expect(childErrors).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });
});

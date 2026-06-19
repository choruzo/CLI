import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { AgentEvent, Message, Plan, PlanDecision, RunOptions } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

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

describe('Plan & Execute — flujo del loop (Hito 7)', () => {
  it('emite plan_proposed y, al rechazar, termina sin ejecutar', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'present_plan', {
        summary: 'Refactor',
        steps: [{ title: 'Paso uno' }, { title: 'Paso dos' }],
      }),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const opts: RunOptions = {
      mode: 'plan',
      onApprovePlan: async (): Promise<PlanDecision> => ({ decision: 'reject' }),
    };
    const events = await collect(loop.run(opts));

    const proposed = events.find((e) => e.type === 'plan_proposed');
    expect(proposed).toBeDefined();
    expect((proposed as { plan: Plan }).plan.steps).toHaveLength(2);
    expect((proposed as { plan: Plan }).plan.steps[0]).toMatchObject({
      id: 'step-1',
      status: 'pending',
    });

    // Rechazo → done stop, sin tool_result de ejecución.
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });
    expect(events.some((e) => e.type === 'plan_step_update')).toBe(false);
  });

  it('al aprobar, transita a execute e inyecta plan; update_plan emite plan_step_update', async () => {
    // Ronda 1: present_plan (Fase 1). Tras aprobar, ronda 2: update_plan in_progress;
    // ronda 3: update_plan done; ronda 4: texto final (stop).
    const provider = new MockProvider([
      makeToolCallRound('c1', 'present_plan', {
        summary: 'Tarea',
        steps: [{ title: 'Único paso' }],
      }),
      makeToolCallRound('c2', 'update_plan', { stepId: 'step-1', status: 'in_progress' }),
      makeToolCallRound('c3', 'update_plan', { stepId: 'step-1', status: 'done' }),
      makeTextRound('Listo.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const persisted: Array<{ done: boolean }> = [];
    const opts: RunOptions = {
      mode: 'plan',
      onApprovePlan: async (plan): Promise<PlanDecision> => ({ decision: 'approve', plan }),
      onPlanPersist: (_p, done) => persisted.push({ done }),
    };
    const events = await collect(loop.run(opts));

    const updates = events.filter((e) => e.type === 'plan_step_update');
    expect(updates).toEqual([
      { type: 'plan_step_update', stepId: 'step-1', status: 'in_progress' },
      { type: 'plan_step_update', stepId: 'step-1', status: 'done' },
    ]);

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop' });

    // Se persistió al menos al aprobar y al completar.
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    expect(persisted.at(-1)?.done).toBe(true);

    // La inyección de ejecución entró en el historial como tool result de present_plan.
    const injected = messages.find(
      (m) => m.role === 'tool' && m.name === 'present_plan' && m.content?.includes('APPROVED'),
    );
    expect(injected).toBeDefined();
  });

  it('en modo plan rechaza tools mutantes con tool_error recuperable', async () => {
    const provider = new MockProvider([
      makeToolCallRound('w1', 'write_file', { path: '/tmp/x', content: 'hola' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const events = await collect(loop.run({ mode: 'plan' }));
    const err = events.find((e) => e.type === 'tool_error');
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain('Plan mode');
    expect((err as { recoverable: boolean }).recoverable).toBe(true);
    // No se ejecutó la escritura.
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });
});

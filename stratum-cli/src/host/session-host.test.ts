import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { SessionHost, type SessionHostOptions } from './session-host.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, RunOptions, ToolContext, ToolDefinition } from '../agent/types.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-host-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeConfig(): StratumConfig {
  return StratumConfigSchema.parse({
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: 32768,
        },
      },
    },
    memory: { autoExtract: false },
    tools: { auditLog: false },
    trace: { enabled: false },
  });
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose({ cancelBackground: true })));
});

async function makeHost(
  rounds: OpenAIStreamChunk[][],
  extra: Partial<SessionHostOptions> = {},
): Promise<SessionHost> {
  const config = makeConfig();
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider(rounds));
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd: root, env: {} }),
    config,
    router,
    ...extra,
  });
  hosts.push(host);
  return host;
}

function tool(
  name: string,
  seen: ToolContext[],
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}.`,
    schema: z.object({}),
    execute: async (_params: unknown, ctx: ToolContext) => {
      seen.push(ctx);
      return { ok: true, output: 'ok' };
    },
    ...extra,
  } as ToolDefinition;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('SessionHost', () => {
  it('monta la sesión sobre su entorno y ejecuta un turno', async () => {
    const seen: ToolContext[] = [];
    const host = await makeHost([makeToolCallRound('c1', 'probe', {}), makeTextRound('hecho')]);
    host.registry.register(tool('probe', seen));

    const events = await collect(host.run('usa probe'));

    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toBe(root);
    expect(seen[0]!.sessionId).toBe(host.sessionId);
    // La sesión trabaja sobre una copia propia de la config.
    expect(seen[0]!.config).toBe(host.config);
  });

  it('dos hosts de la misma config cargada no comparten objeto de config', async () => {
    const config = makeConfig();
    const make = (): Promise<SessionHost> =>
      SessionHost.create({
        env: createSessionEnv({ cwd: root, env: {} }),
        config,
        router: new ProviderRouter(config),
      });
    const a = await make();
    const b = await make();
    hosts.push(a, b);

    expect(a.config).not.toBe(b.config);
    expect(a.config).not.toBe(config);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('las puertas del host contestan las decisiones del runtime', async () => {
    const seen: ToolContext[] = [];
    const confirm = vi.fn(async () => 'approve' as const);
    const host = await makeHost([makeToolCallRound('c1', 'danger', {}), makeTextRound('hecho')], {
      gates: { confirm },
    });
    host.registry.register(tool('danger', seen, { destructive: true }));

    await collect(host.run('hazlo'));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('sin puerta de confirmación, lo destructivo no se ejecuta', async () => {
    const seen: ToolContext[] = [];
    const host = await makeHost([makeToolCallRound('c1', 'danger', {}), makeTextRound('hecho')]);
    host.registry.register(tool('danger', seen, { destructive: true }));

    const events = await collect(host.run('hazlo'));

    expect(seen).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool_error' && e.name === 'danger')).toBe(true);
  });

  it('runOptions cablea id, política y persistencia; setGates las sustituye', async () => {
    const host = await makeHost([makeTextRound('x')], { destructivePolicy: 'deny' });
    const before: RunOptions = host.runOptions();
    expect(before.sessionId).toBe(host.sessionId);
    expect(before.destructivePolicy).toBe('deny');
    expect(before.onConfirmDestructive).toBeUndefined();
    expect(before.onSubagentPersist).toBeTypeOf('function');

    const approvePlan = vi.fn();
    host.setGates({ approvePlan });
    expect(host.runOptions({ mode: 'plan' })).toMatchObject({ mode: 'plan' });
    expect(host.runOptions().onApprovePlan).toBe(approvePlan);
  });

  it('cancel() aborta el turno en curso', async () => {
    const seen: ToolContext[] = [];
    const host = await makeHost([makeToolCallRound('c1', 'slow', {}), makeTextRound('nunca')]);
    host.registry.register(
      tool('slow', seen, {
        execute: async (_p: unknown, ctx: ToolContext) => {
          seen.push(ctx);
          host.cancel();
          return { ok: true, output: 'ok' };
        },
      }),
    );

    const events = await collect(host.run('espera'));

    expect(seen[0]!.signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
  });

  it('dispose es idempotente y cierra los jobs de la sesión', async () => {
    const host = await makeHost([makeTextRound('x')]);
    const jobs = host.agent.jobs;
    expect(jobs).toBeDefined();

    await host.dispose();
    await host.dispose();

    expect(jobs!.isClosed).toBe(true);
  });
});

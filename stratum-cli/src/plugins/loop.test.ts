/**
 * PL1 — plugins a través del `ReactLoop`: lo que ve el modelo, el write-log, el
 * aviso de repetición y los subagentes.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { ReactLoop } from '../agent/harness.js';
import { ProfileLoader } from '../agent/profiles.js';
import { ChangeTracker } from '../agent/risk.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { AgentEvent, Message, SubagentRouter, ToolDefinition } from '../agent/types.js';
import type { IProvider } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { TraceRuntimeEvent } from '../trace/records.js';
import type { TraceScope } from '../trace/recorder.js';
import { PluginHost } from './host.js';
import type { PluginAPI, PluginAgentRef } from './api.js';

const config = StratumConfigSchema.parse({});

async function hostWith(setup: (api: PluginAPI) => void): Promise<PluginHost> {
  const host = new PluginHost(
    { hookTimeoutMs: 500, setupTimeoutMs: 500, batchTimeoutMs: 2_000 },
    { cwd: '/repo', worktree: '/repo', version: 'test' },
  );
  await host.add(
    { id: 'p', apiVersion: 1, setup },
    { source: 'flag', entry: '/p.js', options: {} },
  );
  return host;
}

function tool(name: string, output: string): ToolDefinition {
  return {
    name,
    description: name,
    schema: z.object({ value: z.string().optional(), path: z.string().optional() }),
    execute: async () => ({ ok: true, output }),
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function traceCapturing(): { scope: TraceScope; events: TraceRuntimeEvent[] } {
  const events: TraceRuntimeEvent[] = [];
  const scope: TraceScope = {
    turnStart: () => {},
    turnEnd: () => {},
    modelStart: () => ({ firstChunk: () => {}, usage: () => {}, end: () => {} }),
    event: () => {},
    runtime: (ev) => void events.push(ev),
    child: () => scope,
  };
  return { scope, events };
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

describe('ReactLoop + plugins', () => {
  it('un veto llega como tool_error `blocked: plugin` y no cuenta como llamada repetida', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', (c) => (c.tool === 'nuke' ? { block: true, reason: 'no' } : undefined)),
    );
    const registry = new ToolRegistry();
    registry.register(tool('nuke', 'nunca'));
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const { scope, events: trace } = traceCapturing();
    const loop = new ReactLoop(
      new MockProvider([
        makeToolCallRound('c1', 'nuke', { value: 'x' }),
        makeToolCallRound('c2', 'nuke', { value: 'x' }),
        makeTextRound('vale'),
      ]),
      registry,
      messages,
      config,
      'm',
      32768,
      undefined,
      { plugins },
    );
    const events = await collect(loop.run({ trace: scope }));
    const errors = events.filter((e) => e.type === 'tool_error');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.type === 'tool_error' && e.blocked === 'plugin')).toBe(true);
    expect(trace.filter((e) => e.event === 'repeat')).toEqual([]);
    expect(
      trace.filter((e) => e.event === 'veto').map((e) => e.event === 'veto' && e.source),
    ).toEqual(['plugin', 'plugin']);
  });

  it('tool.after cambia lo que ve el modelo; el write-log cuenta el diff original', async () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', '-a', '+b', '+c'].join('\n');
    const plugins = await hostWith((api) =>
      api.on('tool.after', () => ({ output: 'anotado por el plugin' })),
    );
    const registry = new ToolRegistry();
    registry.register(tool('edit_file', diff));
    const changes = new ChangeTracker();
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      new MockProvider([
        makeToolCallRound('c1', 'edit_file', { path: 'x.ts' }),
        makeTextRound('hecho'),
      ]),
      registry,
      messages,
      config,
      'm',
      32768,
      undefined,
      { plugins, changes },
    );
    const events = await collect(loop.run());
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ result: 'anotado por el plugin' });
    expect(messages.find((m) => m.role === 'tool')?.content).toBe('anotado por el plugin');
    expect(changes.stats).toEqual([{ path: 'x.ts', added: 2, deleted: 1 }]);
  });

  it('el veto aplica también a un subagente, que se identifica como tal', async () => {
    const seen: PluginAgentRef[] = [];
    const plugins = await hostWith((api) =>
      api.on('tool.before', (c) => {
        seen.push(c.agent);
        return c.tool === 'nuke' ? { block: true, reason: 'tampoco delegando' } : undefined;
      }),
    );
    const registry = new ToolRegistry();
    registry.register(tool('nuke', 'nunca'));
    const child = new MockProvider([
      makeToolCallRound('k1', 'nuke', { value: 'x' }),
      makeTextRound('no pude'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      new MockProvider([
        makeToolCallRound('d1', 'delegate_task', { task: 'hazlo', profile: 'general' }),
        makeTextRound('listo'),
      ]),
      registry,
      messages,
      config,
      'm',
      32768,
      undefined,
      {
        plugins,
        profiles: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-'))),
      },
    );
    const events = await collect(loop.run({ makeSubagentRouter: () => mockRouter(child) }));
    const childErrors = events.filter(
      (e) => e.type === 'subagent_event' && e.event.type === 'tool_error',
    );
    expect(childErrors).toHaveLength(1);
    expect(childErrors[0]).toMatchObject({ event: { blocked: 'plugin' } });
    expect(seen).toEqual([
      { kind: 'subagent', profile: 'general', id: expect.stringMatching(/^sub_/) },
    ]);
  });
});

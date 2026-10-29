/**
 * PL1 — los hooks de plugin en el `ToolDispatcher`: `tool.before` en la fase de
 * vetos (antes de toda confirmación) y `tool.after` sobre lo que ve el modelo.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher, ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { TraceRuntimeEvent } from '../trace/records.js';
import type { TraceScope } from '../trace/recorder.js';
import { PluginHost } from './host.js';
import type { PluginAPI } from './api.js';

const config = StratumConfigSchema.parse({});
const SECRET = 'sk-proj-abc123def456ghi789jkl012';

async function hostWith(setup: (api: PluginAPI) => void): Promise<PluginHost> {
  const host = new PluginHost(
    { hookTimeoutMs: 200, setupTimeoutMs: 200, batchTimeoutMs: 1_000 },
    { cwd: '/repo', worktree: '/repo', version: 'test' },
  );
  await host.add(
    { id: 'p', apiVersion: 1, setup },
    { source: 'flag', entry: '/p.js', options: {} },
  );
  return host;
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

function setup(tool: Partial<ToolDefinition> = {}) {
  const execute = vi.fn(async () => ({ ok: true as const, output: 'executed' }));
  const registry = new ToolRegistry();
  registry.register({
    name: 'probe',
    description: 'probe',
    schema: z.object({ value: z.string().optional() }),
    execute,
    ...tool,
  });
  return { dispatcher: new ToolDispatcher(registry), execute };
}

const ctx = (overrides: Partial<ToolContext>): ToolContext => ({
  signal: new AbortController().signal,
  cwd: process.cwd(),
  config,
  ...overrides,
});

describe('ToolDispatcher + plugins', () => {
  it('veta antes de confirmar: no se pregunta por lo que un plugin va a vetar', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', () => ({ block: true, reason: 'prohibido' })),
    );
    const { dispatcher, execute } = setup({ destructive: true });
    const confirm = vi.fn(async () => 'approve' as const);
    const { scope, events } = traceCapturing();
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins, confirmDestructive: confirm, trace: scope }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ notRun: true });
    expect(res!.result).toMatchObject({
      ok: false,
      error: 'Blocked by plugin p: prohibido',
      recoverable: true,
      countsAsFailure: false,
      blocked: 'plugin',
    });
    expect(events).toEqual([
      expect.objectContaining({ event: 'veto', source: 'plugin', tool: 'probe', callId: 'c1' }),
    ]);
  });

  it('un veto de plugin no se levanta con --allow-destructive ni con allow-all', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', () => ({ block: true, reason: 'no' })),
    );
    const { dispatcher, execute } = setup({ destructive: true });
    await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins, allowDestructive: true, destructivePolicy: 'allow' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('el motivo del veto se redacta (lo escribe un tercero)', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', () => ({ block: true, reason: `usa ${SECRET}` })),
    );
    const { dispatcher } = setup();
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins }),
    );
    expect(res!.result.ok).toBe(false);
    if (!res!.result.ok) {
      expect(res!.result.error).not.toContain(SECRET);
      expect(res!.result.error).toContain('[redacted:');
    }
  });

  it('un handler que lanza veta; los demás de la llamada no la ejecutan', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', () => {
        throw new Error('bug');
      }),
    );
    const { dispatcher, execute } = setup();
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result).toMatchObject({ ok: false, blocked: 'plugin', countsAsFailure: false });
  });

  it('tool.after cambia lo que ve el modelo, re-redactado; `result` sigue siendo el de la tool', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.after', (r) => ({ output: `${r.output} · clave ${SECRET}` })),
    );
    const { dispatcher } = setup();
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins }),
    );
    expect(res!.result).toEqual({ ok: true, output: 'executed' });
    expect(res!.presented?.ok).toBe(true);
    if (res!.presented?.ok) {
      expect(res!.presented.output).toMatch(/^executed · clave \[redacted: /);
      expect(res!.presented.output).not.toContain(SECRET);
    }
  });

  it('tool.after no convierte un error en éxito', async () => {
    const plugins = await hostWith((api) => api.on('tool.after', () => ({ output: 'todo bien' })));
    const { dispatcher } = setup({
      execute: async () => ({ ok: false as const, error: 'falló', recoverable: true }),
    });
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins }),
    );
    expect(res!.result.ok).toBe(false);
    expect(res!.presented).toBeUndefined();
  });

  it('con la pausa pedida, un lote vetado por plugin no ejecuta nada al reanudar', async () => {
    const plugins = await hostWith((api) =>
      api.on('tool.before', () => ({ block: true, reason: 'no' })),
    );
    const { dispatcher, execute } = setup();
    const waitAtSafePoint = vi.fn(async () => undefined);
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      ctx({ plugins, pause: { pauseRequested: true, waitAtSafePoint } }),
    );
    // Todo el lote estaba vetado: no hay nada que esperar ni que ejecutar.
    expect(waitAtSafePoint).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result).toMatchObject({ blocked: 'plugin' });
  });

  it('sin plugins (o un host vacío) el dispatcher se comporta como siempre', async () => {
    const { dispatcher, execute } = setup();
    const [a] = await dispatcher.dispatch([{ id: 'c1', name: 'probe', input: {} }], ctx({}));
    const [b] = await dispatcher.dispatch(
      [{ id: 'c2', name: 'probe', input: {} }],
      ctx({ plugins: PluginHost.empty() }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(a).toEqual({
      callId: 'c1',
      toolName: 'probe',
      result: { ok: true, output: 'executed' },
      durationMs: expect.any(Number),
    });
    expect(b!.presented).toBeUndefined();
  });
});

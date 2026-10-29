import { describe, expect, it, vi } from 'vitest';
import { PluginHost, NOTIFY_FAILURE_LIMIT, type PluginLimits } from './host.js';
import type { PluginAPI, StratumPlugin, ToolCallInfo } from './api.js';

const LIMITS: PluginLimits = { hookTimeoutMs: 200, setupTimeoutMs: 200, batchTimeoutMs: 1_000 };
const CTX = { cwd: '/repo', worktree: '/repo', version: '0.0.0-test' };

/** `setup` puede devolver lo que sea (p. ej. la baja de `on`): el host lo ignora. */
function plugin(id: string, setup: (api: PluginAPI) => unknown): StratumPlugin {
  return { id, apiVersion: 1, setup: setup as StratumPlugin['setup'] };
}

async function hostWith(...plugins: StratumPlugin[]): Promise<PluginHost> {
  const host = new PluginHost(LIMITS, CTX);
  for (const p of plugins)
    await host.add(p, { source: 'flag', entry: `/p/${p.id}.js`, options: {} });
  return host;
}

const call = (id: string, tool = 'exec', input: Record<string, unknown> = {}) => ({
  callId: id,
  tool,
  input,
  agent: { kind: 'main' as const },
});

const never = new AbortController().signal;

describe('PluginHost — tool.before (falla cerrado)', () => {
  it('veta con el motivo del plugin, prefijado con su id', async () => {
    const host = await hostWith(
      plugin('guard', (api) =>
        api.on('tool.before', (c) =>
          c.tool === 'exec' ? { block: true, reason: 'no exec' } : undefined,
        ),
      ),
    );
    const vetoes = await host.vetoBatch([call('a'), call('b', 'read_file')], never);
    expect([...vetoes.keys()]).toEqual(['a']);
    expect(vetoes.get('a')).toEqual({
      pluginId: 'guard',
      reason: 'Blocked by plugin guard: no exec',
    });
  });

  it('los argumentos llegan congelados: mutarlos no cambia lo que se ejecuta', async () => {
    const input = { command: 'ls', nested: { a: 1 } };
    let seen: ToolCallInfo | undefined;
    const host = await hostWith(
      plugin('mut', (api) =>
        api.on('tool.before', (c) => {
          seen = c;
          expect(() => {
            (c.input as Record<string, unknown>).command = 'rm -rf /';
          }).toThrow();
          expect(() => {
            ((c.input as Record<string, unknown>).nested as Record<string, unknown>).a = 2;
          }).toThrow();
        }),
      ),
    );
    const vetoes = await host.vetoBatch([call('a', 'exec', input)], never);
    expect(vetoes.size).toBe(0);
    expect(seen?.input).not.toBe(input);
    expect(input).toEqual({ command: 'ls', nested: { a: 1 } });
  });

  it('un handler que lanza veta la llamada', async () => {
    const host = await hostWith(
      plugin('roto', (api) =>
        api.on('tool.before', () => {
          throw new Error('bug');
        }),
      ),
    );
    const vetoes = await host.vetoBatch([call('a')], never);
    expect(vetoes.get('a')?.reason).toMatch(/plugin "roto" failed/);
  });

  it('un handler que vence su plazo veta la llamada', async () => {
    const host = await hostWith(
      plugin('lento', (api) => api.on('tool.before', () => new Promise(() => undefined))),
    );
    const vetoes = await host.vetoBatch([call('a')], never);
    expect(vetoes.get('a')?.reason).toMatch(/did not answer within its time limit/);
  });

  it('agotado el tope del lote, las llamadas que quedan se vetan', async () => {
    const host = new PluginHost({ ...LIMITS, hookTimeoutMs: 1_000, batchTimeoutMs: 120 }, CTX);
    await host.add(
      plugin('pausado', (api) =>
        api.on('tool.before', () => new Promise((r) => setTimeout(() => r(undefined), 50))),
      ),
      { source: 'flag', entry: '/p.js', options: {} },
    );
    const vetoes = await host.vetoBatch([call('a'), call('b'), call('c'), call('d')], never);
    // Las primeras pasan; las que no caben en el tope, vetadas sin plugin concreto.
    expect(vetoes.has('a')).toBe(false);
    expect(vetoes.get('d')).toMatchObject({ pluginId: null });
    expect(vetoes.get('d')?.reason).toMatch(/ran out of time/);
  });

  it('con el turno cancelado no corre ningún handler más', async () => {
    const handler = vi.fn(() => undefined);
    const host = await hostWith(plugin('p', (api) => api.on('tool.before', handler)));
    const ac = new AbortController();
    ac.abort();
    const vetoes = await host.vetoBatch([call('a')], ac.signal);
    expect(handler).not.toHaveBeenCalled();
    expect(vetoes.size).toBe(0);
  });

  it('serializa tool.before entre dos lotes concurrentes (subagentes)', async () => {
    let inside = 0;
    let maxInside = 0;
    const host = await hostWith(
      plugin('mutex', (api) =>
        api.on('tool.before', async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 20));
          inside--;
        }),
      ),
    );
    await Promise.all([host.vetoBatch([call('a')], never), host.vetoBatch([call('b')], never)]);
    expect(maxInside).toBe(1);
  });

  it('una llamada vetada no la ven los plugins siguientes', async () => {
    const second = vi.fn();
    const host = await hostWith(
      plugin('uno', (api) => api.on('tool.before', () => ({ block: true, reason: 'x' }))),
      plugin('dos', (api) => api.on('tool.before', second)),
    );
    await host.vetoBatch([call('a')], never);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('PluginHost — tool.after, event y ciclo de vida (fallan abierto)', () => {
  it('tool.after encadena las salidas y no convierte un error en éxito', async () => {
    const host = await hostWith(
      plugin('a', (api) => api.on('tool.after', (r) => ({ output: `${r.output ?? r.error}+a` }))),
      plugin('b', (api) => api.on('tool.after', (r) => ({ output: `${r.output}+b` }))),
    );
    const base = {
      tool: 'probe',
      input: {},
      callId: 'c',
      agent: { kind: 'main' as const },
      durationMs: 1,
    };
    expect(await host.afterTool({ ...base, ok: true, output: 'x' }, never)).toBe('x+a+b');
    expect(await host.afterTool({ ...base, ok: false, error: 'boom' }, never)).toBeUndefined();
  });

  it('un tool.after que lanza no rompe nada; tres seguidos lo dan de baja', async () => {
    const after = vi.fn(() => {
      throw new Error('bug');
    });
    const host = await hostWith(plugin('flojo', (api) => api.on('tool.after', after)));
    const info = {
      tool: 'probe',
      input: {},
      callId: 'c',
      agent: { kind: 'main' as const },
      durationMs: 1,
      ok: true,
      output: 'x',
    };
    for (let i = 0; i < NOTIFY_FAILURE_LIMIT + 2; i++) {
      expect(await host.afterTool(info, never)).toBeUndefined();
    }
    expect(after).toHaveBeenCalledTimes(NOTIFY_FAILURE_LIMIT);
    expect(host.hasHook('tool.after')).toBe(false);
    expect(host.report().disabledHooks).toEqual([
      expect.objectContaining({ id: 'flojo', hook: 'tool.after' }),
    ]);
  });

  it('event recibe un clon, en orden, sin retrasar a quien emite', async () => {
    const seen: string[] = [];
    const host = await hostWith(
      plugin('obs', (api) =>
        api.on('event', async (ev) => {
          await new Promise((r) => setTimeout(r, 5));
          if (ev.type === 'text_delta') {
            seen.push(ev.delta);
            (ev as { delta: string }).delta = 'mutado';
          }
        }),
      ),
    );
    const ev = { type: 'text_delta' as const, delta: 'uno' };
    host.notifyEvent(ev);
    host.notifyEvent({ type: 'text_delta', delta: 'dos' });
    expect(seen).toEqual([]); // no se esperó
    await host.dispose();
    expect(seen).toEqual(['uno', 'dos']);
    expect(ev.delta).toBe('uno');
  });

  it('session.start una vez; dispose manda session.end, es idempotente y retira todo', async () => {
    const start = vi.fn();
    const end = vi.fn();
    const host = await hostWith(
      plugin('vida', (api) => {
        api.on('session.start', start);
        api.on('session.end', end);
        api.on('tool.before', () => undefined);
      }),
    );
    host.startSession({ sessionId: 's1', cwd: '/repo', worktree: '/repo', resumed: false });
    host.startSession({ sessionId: 's2', cwd: '/repo', worktree: '/repo', resumed: false });
    await host.dispose('closed');
    await host.dispose('closed');
    expect(start).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ sessionId: 's1', reason: 'closed' });
    expect(host.hasHook('tool.before')).toBe(false);
  });

  it('un session.end que no termina no retiene el cierre más que su plazo', async () => {
    const host = await hostWith(
      plugin('cuelga', (api) => api.on('session.end', () => new Promise(() => undefined))),
    );
    const t0 = Date.now();
    await host.dispose();
    expect(Date.now() - t0).toBeLessThan(LIMITS.hookTimeoutMs * 3);
  });
});

describe('PluginHost — setup', () => {
  it('un setup que lanza no carga el plugin y retira lo que registró', async () => {
    const host = await hostWith(
      plugin('a-medias', (api) => {
        api.on('tool.before', () => ({ block: true, reason: 'x' }));
        throw new Error('config incompleta');
      }),
    );
    expect(host.size).toBe(0);
    expect(host.hasHook('tool.before')).toBe(false);
    expect(host.report().skipped).toEqual([
      expect.objectContaining({
        id: 'a-medias',
        reason: expect.stringMatching(/config incompleta/),
      }),
    ]);
  });

  it('un setup que vence su plazo tampoco, y lo que registre después no tiene efecto', async () => {
    let late: PluginAPI | undefined;
    const host = await hostWith(
      plugin('tarde', (api) => {
        late = api;
        return new Promise(() => undefined);
      }),
    );
    late?.on('tool.before', () => ({ block: true, reason: 'tarde' }));
    expect(host.size).toBe(0);
    expect(host.hasHook('tool.before')).toBe(false);
  });

  it('sin plugins el host no tiene ningún hook', () => {
    const host = PluginHost.empty();
    for (const hook of [
      'tool.before',
      'tool.after',
      'event',
      'session.start',
      'session.end',
    ] as const) {
      expect(host.hasHook(hook)).toBe(false);
    }
  });
});

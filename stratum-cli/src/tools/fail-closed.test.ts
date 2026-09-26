import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, ToolDispatcher } from './registry.js';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
}

function setup(tool: Partial<ToolDefinition>) {
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

describe('ToolDispatcher — los chequeos de seguridad fallan cerrado', () => {
  it('un preflight que lanza bloquea la llamada en vez de dejarla pasar', async () => {
    const { dispatcher, execute } = setup({
      preflight: () => {
        throw new Error('parser roto');
      },
    });
    const [res] = await dispatcher.dispatch([{ id: 'c1', name: 'probe', input: {} }], makeCtx());
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result.ok).toBe(false);
    if (!res!.result.ok) {
      expect(res!.result.error).toContain('safety check could not be evaluated');
      expect(res!.result.recoverable).toBe(true);
      // No consume reintentos: la culpa no es del modelo.
      expect(res!.result.countsAsFailure).toBe(false);
    }
  });

  it('un preflight que lanza tampoco se levanta con --allow-destructive', async () => {
    const { dispatcher, execute } = setup({
      preflight: () => {
        throw new Error('boom');
      },
    });
    await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      makeCtx({ allowDestructive: true, destructivePolicy: 'allow' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('isDestructive que lanza se trata como destructiva: se pregunta al usuario', async () => {
    const { dispatcher, execute } = setup({
      isDestructive: () => {
        throw new Error('boom');
      },
    });
    const confirm = vi.fn(async () => 'deny' as const);
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'probe', input: {} }],
      makeCtx({ confirmDestructive: confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result.ok).toBe(false);
  });

  it('isDestructive que lanza, sin nadie que confirme (CI), bloquea', async () => {
    const { dispatcher, execute } = setup({
      isDestructive: () => {
        throw new Error('boom');
      },
    });
    const [res] = await dispatcher.dispatch([{ id: 'c1', name: 'probe', input: {} }], makeCtx());
    expect(execute).not.toHaveBeenCalled();
    expect(res!.result.ok).toBe(false);
  });

  it('un preflight que pasa sigue dejando ejecutar', async () => {
    const { dispatcher, execute } = setup({ preflight: () => null });
    const [res] = await dispatcher.dispatch([{ id: 'c1', name: 'probe', input: {} }], makeCtx());
    expect(execute).toHaveBeenCalledOnce();
    expect(res!.result.ok).toBe(true);
  });
});

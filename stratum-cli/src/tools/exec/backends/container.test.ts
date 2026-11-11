import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StratumConfigSchema } from '../../../config/schema.js';
import type { ToolContext } from '../../../agent/types.js';
import { BOX_CONNECTORS_LABEL, BOX_LABEL, BOX_ROLE_LABEL } from '../../../box/spec.js';
import { ExecConnectError, type ExecRequest } from '../backend.js';

/**
 * El backend `container:<caja>` solo en sus rechazos (no llega a lanzar nada):
 * el runtime se sustituye por uno de mentira. Lo que corre de verdad contra
 * Podman o Docker está en `container.integration.test.ts`.
 */
const inspect = vi.hoisted(() => ({
  result: { exitCode: 0, stdout: '', stderr: '' } as {
    exitCode: number;
    stdout: string;
    stderr: string;
  },
  calls: [] as string[][],
}));

vi.mock('../../../box/runtime.js', () => ({
  cachedRuntime: async () => ({ ok: true, runtime: { kind: 'podman', bin: 'podman' } }),
  defaultRunner: async (_bin: string, args: string[]) => {
    inspect.calls.push(args);
    return inspect.result;
  },
}));

const { containerBackend } = await import('./container.js');

const config = StratumConfigSchema.parse({});
const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd(), config };
const req: ExecRequest = {
  command: 'echo hola',
  timeoutMs: 5000,
  maxBytes: 1024,
  signal: new AbortController().signal,
};

function respond(labels: Record<string, string>, running = true): void {
  inspect.result = {
    exitCode: 0,
    stdout: JSON.stringify([{ State: { Running: running }, Config: { Labels: labels } }]),
    stderr: '',
  };
}

const run = (name = 'box') =>
  containerBackend.run({ kind: 'container', name } as never, req, ctx).catch((e: unknown) => e);

beforeEach(() => {
  inspect.calls.length = 0;
});

describe('backend container: no entra en lo que no es la caja del agente (M20)', () => {
  it('un contenedor con papel (la caja de conectores) se rechaza aunque lleve la etiqueta', async () => {
    respond({ [BOX_LABEL]: 'box', [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' });
    const err = await run();
    expect(err).toBeInstanceOf(ExecConnectError);
    expect((err as Error).message).toMatch(/not created by Stratum/);
    expect(inspect.calls).toEqual([['container', 'inspect', 'stratum-box-box']]);
  });

  it('sin la etiqueta de la caja (como la de conectores): se rechaza', async () => {
    respond({ [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' });
    expect(await run()).toBeInstanceOf(ExecConnectError);
    respond({});
    expect(await run()).toBeInstanceOf(ExecConnectError);
  });

  it('con la etiqueta de otra caja: se rechaza', async () => {
    respond({ [BOX_LABEL]: 'otra' });
    expect(await run()).toBeInstanceOf(ExecConnectError);
  });

  it('la caja del agente parada: se rechaza como parada', async () => {
    respond({ [BOX_LABEL]: 'box' }, false);
    const err = await run();
    expect(err).toBeInstanceOf(ExecConnectError);
    expect((err as Error).message).toMatch(/stopped/);
  });
});

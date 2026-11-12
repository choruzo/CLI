import { describe, it, expect } from 'vitest';
import { BoxConfigSchema } from '../config/schema.js';
import { parseConnectorManifest, type ConnectorManifest } from '../connectors/manifest.js';
import {
  ConnectorsBoxUnavailableError,
  assertConnectorsBoxRunning,
  connectorLaunches,
} from './connectors.js';
import type { RunResult, RuntimeRunner } from './runtime.js';
import { BOX_CONNECTORS_LABEL, BOX_LABEL, BOX_ROLE_LABEL } from './spec.js';

const rt = { kind: 'podman', bin: 'podman' } as const;

const manifest = (id = 'open-meteo'): ConnectorManifest =>
  parseConnectorManifest(
    {
      schemaVersion: 1,
      id,
      version: '1.0.0',
      name: 'X',
      description: 'x',
      agents: ['companion'],
      hosts: [],
      secrets: [],
      tools: [{ name: 'a_tool', readOnly: true, summary: 's' }],
    },
    'test',
  );

function inspectRunner(
  result: { labels?: Record<string, string>; running?: boolean } | 'missing' | 'broken',
): { run: RuntimeRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: RuntimeRunner = async (_bin, args): Promise<RunResult> => {
    calls.push(args);
    if (result === 'missing') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: no such container stratum-box-box-connectors',
      };
    }
    if (result === 'broken') return { exitCode: 125, stdout: '', stderr: 'daemon exploded' };
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        { State: { Running: result.running ?? true }, Config: { Labels: result.labels ?? {} } },
      ]),
      stderr: '',
    };
  };
  return { run, calls };
}

const OWN = { [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' };

describe('connectorLaunches (M20)', () => {
  it('sin manifiestos: nada y sin detectar runtime', async () => {
    let detected = 0;
    const r = await connectorLaunches(BoxConfigSchema.parse({}), [], {
      detect: async () => {
        detected++;
        return { ok: true, runtime: rt };
      },
    });
    expect(r).toEqual({ ok: true, launches: [] });
    expect(detected).toBe(0);
  });

  it('sin runtime: no hay lanzamientos y dice por qué', async () => {
    const r = await connectorLaunches(
      BoxConfigSchema.parse({}),
      [{ manifest: manifest(), secrets: {} }],
      {
        detect: async () => ({ ok: false, reason: 'No container runtime available' }),
      },
    );
    expect(r).toEqual({ ok: false, reason: 'No container runtime available' });
  });

  it('compone la orden con el binario del runtime y la caja de conectores', async () => {
    const r = await connectorLaunches(
      BoxConfigSchema.parse({ name: 'mia' }),
      [{ manifest: manifest(), secrets: {} }],
      {
        detect: async () => ({ ok: true, runtime: rt }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0]!.config).toMatchObject({
      name: 'open-meteo',
      command: 'podman',
      args: [
        'exec',
        '-i',
        'stratum-box-mia-connectors',
        'node',
        '/opt/stratum/connectors/open-meteo/server.mjs',
      ],
    });
  });

  it('beforeConnect comprueba la caja de conectores', async () => {
    const { run, calls } = inspectRunner({ labels: { ...OWN, [BOX_ROLE_LABEL]: 'connectors' } });
    const r = await connectorLaunches(
      BoxConfigSchema.parse({}),
      [{ manifest: manifest(), secrets: {} }],
      {
        detect: async () => ({ ok: true, runtime: rt }),
        run,
      },
    );
    if (!r.ok) throw new Error('unexpected');
    await expect(r.launches[0]!.beforeConnect()).resolves.toBeUndefined();
    expect(calls).toEqual([['container', 'inspect', 'stratum-box-box-connectors']]);
  });
});

describe('assertConnectorsBoxRunning (M20)', () => {
  it('en marcha y de Stratum: ok', async () => {
    await expect(
      assertConnectorsBoxRunning(rt, 'box', inspectRunner({ labels: OWN }).run),
    ).resolves.toBeUndefined();
  });

  it('inexistente: ConnectorsBoxUnavailableError', async () => {
    const err = await assertConnectorsBoxRunning(rt, 'box', inspectRunner('missing').run).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectorsBoxUnavailableError);
    expect((err as Error).message).toMatch(/does not exist/);
  });

  it('el runtime falla por otra cosa: no disponible', async () => {
    await expect(
      assertConnectorsBoxRunning(rt, 'box', inspectRunner('broken').run),
    ).rejects.toBeInstanceOf(ConnectorsBoxUnavailableError);
  });

  it('ajena (sin etiquetas): no disponible', async () => {
    await expect(
      assertConnectorsBoxRunning(rt, 'box', inspectRunner({ labels: {} }).run),
    ).rejects.toBeInstanceOf(ConnectorsBoxUnavailableError);
  });

  it('con la etiqueta de la caja del agente: no disponible', async () => {
    await expect(
      assertConnectorsBoxRunning(
        rt,
        'box',
        inspectRunner({ labels: { ...OWN, [BOX_LABEL]: 'box' } }).run,
      ),
    ).rejects.toBeInstanceOf(ConnectorsBoxUnavailableError);
  });

  it('de otra caja: no disponible', async () => {
    await expect(
      assertConnectorsBoxRunning(
        rt,
        'box',
        inspectRunner({ labels: { ...OWN, [BOX_CONNECTORS_LABEL]: 'otra' } }).run,
      ),
    ).rejects.toBeInstanceOf(ConnectorsBoxUnavailableError);
  });

  it('parada: no disponible y dice que está parada', async () => {
    const err = await assertConnectorsBoxRunning(
      rt,
      'box',
      inspectRunner({ labels: OWN, running: false }).run,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorsBoxUnavailableError);
    expect((err as Error).message).toMatch(/stopped/);
  });
});

/**
 * M22 — la sonda de los vigilantes: abre el conector por el mismo camino que
 * una sesión (caja de conectores comprobada antes de conectar), llama a las
 * comprobaciones y cierra. Suspendido —no un fallo— cuando no se puede ni
 * intentar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BoxConfigSchema } from '../config/schema.js';
import { type ConnectorLaunchDeps } from '../box/connectors.js';
import type { RunResult } from '../box/runtime.js';
import { BOX_CONNECTORS_LABEL, BOX_ROLE_LABEL } from '../box/spec.js';
import type { ConnectorCatalog } from '../connectors/catalog.js';
import type { CheckArgValue } from '../connectors/checks.js';
import { parseConnectorManifest, type ConnectorManifest } from '../connectors/manifest.js';
import { CONNECTOR_SECRETS_SCHEMA_VERSION, connectorSecretsPath } from '../connectors/secrets.js';
import { CONNECTORS_SCHEMA_VERSION, connectorsFile } from '../connectors/store.js';
import { connectorProbe, type ProbeClient, type ProbeCall } from './probe.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manifest = (raw: Record<string, unknown>): ConnectorManifest =>
  parseConnectorManifest(raw, 'test');

const CASA = manifest({
  schemaVersion: 1,
  id: 'casa',
  version: '1.0.0',
  name: 'Casa',
  description: 'la casa',
  agents: ['companion'],
  hosts: [],
  secrets: [{ name: 'CASA_TOKEN', description: 'token' }],
  tools: [{ name: 'estado', readOnly: true, summary: 'estado' }],
  checks: [
    {
      tool: 'estado',
      summary: 'estado de una entidad',
      minIntervalSec: 60,
      args: [{ name: 'entity_id', type: 'string', required: true, description: 'entidad' }],
    },
  ],
});

const PLAIN = manifest({
  schemaVersion: 1,
  id: 'reloj',
  version: '1.0.0',
  name: 'Reloj',
  description: 'la hora',
  agents: ['companion'],
  hosts: [],
  secrets: [],
  tools: [{ name: 'hora', readOnly: true, summary: 'hora' }],
  checks: [{ tool: 'hora', summary: 'la hora', minIntervalSec: 60, args: [] }],
});

const catalog = {
  entries: [],
  problems: [],
  get: (id: string) => {
    const m = id === CASA.id ? CASA : id === PLAIN.id ? PLAIN : undefined;
    return m ? { manifest: m, skill: null } : undefined;
  },
} as unknown as ConnectorCatalog;

const RT = { kind: 'podman', bin: 'podman' } as const;

/** La caja de conectores, como la ve `container inspect`. */
function container(opts: { running?: boolean } = {}): RunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify([
      {
        State: { Running: opts.running ?? true },
        Config: { Labels: { [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' } },
      },
    ]),
    stderr: '',
  };
}

function launchDeps(
  respond: () => RunResult = () => container(),
): ConnectorLaunchDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    detect: async () => ({ ok: true, runtime: RT }),
    run: async (_bin, args) => {
      calls.push(args);
      return respond();
    },
  };
}

interface ClientLog {
  connects: number;
  closes: number;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Lo que se le pasó como `beforeConnect`, ya resuelto. */
  beforeConnect: number;
}

function client(log: ClientLog, opts: { failTools?: string[]; throwConnect?: boolean } = {}) {
  return (_config: unknown, beforeConnect: () => Promise<void>): ProbeClient => ({
    async connect() {
      log.connects++;
      await beforeConnect();
      log.beforeConnect++;
      if (opts.throwConnect) throw new Error('el conector no arranca');
    },
    async callTool(tool, args) {
      log.calls.push({ tool, args });
      if (opts.failTools?.includes(tool)) throw new Error(`"${tool}" se atragantó`);
      return {
        structuredContent: { estado: 'on', detalle: `${tool} ok` },
      };
    },
    async close() {
      log.closes++;
    },
  });
}

const newLog = (): ClientLog => ({ connects: 0, closes: 0, calls: [], beforeConnect: 0 });

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'stratum-watch-probe-'));
  dirs.push(base);
  const dataDir = join(base, 'companion');
  const secretsDir = join(base, 'daemon');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  return { base, dataDir, secretsDir };
}

function enable(dataDir: string, ids: string[]): void {
  writeFileSync(
    connectorsFile(dataDir),
    JSON.stringify({
      schemaVersion: CONNECTORS_SCHEMA_VERSION,
      enabled: ids.map((id) => ({ id, enabledAt: '2026-11-17T09:00:00.000Z' })),
    }),
    'utf-8',
  );
}

function secrets(secretsDir: string, values: Record<string, string>): void {
  writeFileSync(
    connectorSecretsPath(secretsDir),
    JSON.stringify({
      schemaVersion: CONNECTOR_SECRETS_SCHEMA_VERSION,
      connectors: { casa: values },
      updatedAt: '2026-11-17T09:00:00.000Z',
    }),
    'utf-8',
  );
}

const call = (
  tool = 'estado',
  args: Record<string, CheckArgValue> = { entity_id: 'light.salon' },
): ProbeCall => ({ tool, args });

describe('M22 — connectorProbe: suspendido', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('sin `connectors.json` (o sin el conector activo) no se intenta', async () => {
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log),
    });
    expect(await probe.run('casa', [call()])).toEqual({
      kind: 'suspended',
      reason: 'the connector "casa" is not enabled',
    });
    expect(log.connects).toBe(0);

    enable(ctx.dataDir, ['reloj']);
    expect(await probe.run('casa', [call()])).toEqual({
      kind: 'suspended',
      reason: 'the connector "casa" is not enabled',
    });
    expect(log.connects).toBe(0);
  });

  it('un conector que no está en este Stratum', async () => {
    enable(ctx.dataDir, ['nube']);
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(newLog()),
    });
    expect(await probe.run('nube', [call()])).toEqual({
      kind: 'suspended',
      reason: 'the connector "nube" is not in this Stratum',
    });
  });

  it('sin configurar (faltan secretos) tampoco', async () => {
    enable(ctx.dataDir, ['casa']);
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(newLog()),
    });
    expect(await probe.run('casa', [call()])).toEqual({
      kind: 'suspended',
      reason: 'the connector "casa" needs setup ("stratum connectors setup casa")',
    });
    // Con secretos, en cambio, se intenta.
    secrets(ctx.secretsDir, { CASA_TOKEN: 'tok' });
    const log = newLog();
    const ready = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log),
    });
    expect((await ready.run('casa', [call()])).kind).toBe('ran');
    expect(log.connects).toBe(1);
  });

  it('sin caja de conectores, o con ella parada, no se conecta', async () => {
    enable(ctx.dataDir, ['reloj']);
    const probe = (respond: () => RunResult) =>
      connectorProbe({
        dataDir: ctx.dataDir,
        box: BoxConfigSchema.parse({}),
        secretsDir: ctx.secretsDir,
        catalog,
        launch: launchDeps(respond),
        client: client(newLog()),
      });

    const missing = await probe(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: no such container stratum-box-box-connectors',
    })).run('reloj', [call('hora', {})]);
    expect(missing).toEqual({
      kind: 'suspended',
      reason:
        'The connectors box does not exist yet. Start the box ("stratum box start", or from Dot).',
    });

    const stopped = await probe(() => container({ running: false })).run('reloj', [
      call('hora', {}),
    ]);
    expect(stopped).toEqual({
      kind: 'suspended',
      reason: 'The connectors box is stopped. Start the box ("stratum box start", or from Dot).',
    });
  });

  it('sin runtime de contenedores, tampoco (y sin conectar)', async () => {
    enable(ctx.dataDir, ['reloj']);
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: { detect: async () => ({ ok: false, reason: 'No container runtime available' }) },
      client: client(log),
    });
    expect(await probe.run('reloj', [call('hora', {})])).toEqual({
      kind: 'suspended',
      reason: 'No container runtime available',
    });
    expect(log.connects).toBe(0);
  });
});

describe('M22 — connectorProbe: ran', () => {
  it('un resultado por llamada, en orden, y cierra siempre', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['casa']);
    secrets(ctx.secretsDir, { CASA_TOKEN: 'tok' });
    const log = newLog();
    const deps = launchDeps();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: deps,
      client: client(log),
    });
    const outcome = await probe.run('casa', [
      call('estado', { entity_id: 'light.salon' }),
      call('estado', { entity_id: 'light.cocina' }),
    ]);
    expect(outcome).toEqual({
      kind: 'ran',
      outcomes: [
        { ok: true, result: { estado: 'on', valor: null, detalle: 'estado ok' } },
        { ok: true, result: { estado: 'on', valor: null, detalle: 'estado ok' } },
      ],
    });
    // La caja se comprueba una vez por ciclo: justo antes de conectar.
    expect(deps.calls).toEqual([['container', 'inspect', 'stratum-box-box-connectors']]);
    expect(log).toMatchObject({ connects: 1, closes: 1 });
    expect(log.calls.map((c) => c.args.entity_id)).toEqual(['light.salon', 'light.cocina']);
  });

  it('unos argumentos que ya no casan con el manifiesto fallan sin llamar', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['casa']);
    secrets(ctx.secretsDir, { CASA_TOKEN: 'tok' });
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log),
    });
    const outcome = await probe.run('casa', [
      call('estado', {}),
      call('estado', { entity_id: 'light.salon', otro: 'x' }),
      call('estado', { entity_id: 'light.salon' }),
    ]);
    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.outcomes.map((o) => o.ok)).toEqual([false, false, true]);
    expect(log.calls).toHaveLength(1);
  });

  it('una tool que no es comprobación del manifiesto falla sin llamarla', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['reloj']);
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log),
    });
    const outcome = await probe.run('reloj', [call('hora', {}), call('borrar_todo', {})]);
    expect(outcome).toEqual({
      kind: 'ran',
      outcomes: [
        { ok: true, result: { estado: 'on', valor: null, detalle: 'hora ok' } },
        { ok: false, reason: '"borrar_todo" is not a check of "reloj"' },
      ],
    });
    expect(log.calls.map((c) => c.tool)).toEqual(['hora']);
    expect(log.closes).toBe(1);
  });

  it('un `callTool` que lanza es un fallo de esa llamada, no de las demás', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['casa']);
    secrets(ctx.secretsDir, { CASA_TOKEN: 'tok' });
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log, { failTools: ['estado'] }),
    });
    const outcome = await probe.run('casa', [call(), call()]);
    expect(outcome).toEqual({
      kind: 'ran',
      outcomes: [
        { ok: false, reason: '"estado" se atragantó' },
        { ok: false, reason: '"estado" se atragantó' },
      ],
    });
    expect(log.closes).toBe(1);
  });

  it('si no se puede conectar, el error sale (y el cliente se cierra igual)', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['reloj']);
    const log = newLog();
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({}),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(log, { throwConnect: true }),
    });
    await expect(probe.run('reloj', [call('hora', {})])).rejects.toThrow('el conector no arranca');
    expect(log.closes).toBe(1);
  });

  it('una caja que no es la de conectores se trata como suspendida', async () => {
    const ctx = setup();
    enable(ctx.dataDir, ['reloj']);
    const probe = connectorProbe({
      dataDir: ctx.dataDir,
      box: BoxConfigSchema.parse({ name: 'otra' }),
      secretsDir: ctx.secretsDir,
      catalog,
      launch: launchDeps(),
      client: client(newLog()),
    });
    const outcome = await probe.run('reloj', [call('hora', {})]);
    expect(outcome).toEqual({
      kind: 'suspended',
      reason:
        'The container "stratum-box-otra-connectors" was not created by Stratum as a connectors box.',
    });
  });
});

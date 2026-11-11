import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { BoxConfigSchema } from '../config/schema.js';
import { BoxManager } from '../box/manager.js';
import type { RunResult, RuntimeRunner } from '../box/runtime.js';
import { BOX_LABEL } from '../box/spec.js';
import { loadConnectorCatalog } from '../connectors/catalog.js';
import { connectorsFile, enabledConnectorIds } from '../connectors/store.js';
import { connectorsListSchema } from '../protocol/schemas.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

/**
 * M20 — `connectors.*` en el daemon: el catálogo (inyectado), `connectors.json`
 * en los datos del `companion` (temporales), y una caja con un runtime de
 * mentira. Lo que se prueba es el método, la autoridad que exige y lo que
 * escribe, no Docker.
 */

const SECRET_NAME = 'API_TOKEN';

function writeConnector(catalogDir: string, id: string): void {
  mkdirSync(join(catalogDir, id), { recursive: true });
  writeFileSync(
    join(catalogDir, id, 'connector.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: '1.0.0',
      name: `Conector ${id}`,
      description: 'Un conector de pruebas.',
      agents: ['companion'],
      hosts: ['api.example.com'],
      secrets: [{ name: SECRET_NAME, description: 'La clave de la API' }],
      tools: [
        { name: 'leer', readOnly: true, summary: 'Lee' },
        { name: 'escribir', readOnly: false, summary: 'Escribe' },
      ],
    }),
  );
}

/** Runtime de mentira con estado por contenedor (la caja del agente y la de conectores). */
function fakeRunner(opts: { failConnectorsCreate?: boolean } = {}): {
  run: RuntimeRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const boxes = new Map<string, { running: boolean; labels: Record<string, string> }>();
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
  const run: RuntimeRunner = async (_bin, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'container' && b === 'inspect') {
      const c = boxes.get(args[2]!);
      if (!c) return { exitCode: 1, stdout: '', stderr: `Error: No such container: ${args[2]}` };
      return ok(JSON.stringify([{ State: { Running: c.running }, Config: { Labels: c.labels } }]));
    }
    if (a === 'create') {
      const name = args[2]!;
      if (opts.failConnectorsCreate && name.endsWith('-connectors')) {
        return { exitCode: 125, stdout: '', stderr: 'no space left' };
      }
      const labels: Record<string, string> = {};
      args.forEach((v, i) => {
        if (args[i - 1] !== '--label') return;
        const eq = v.indexOf('=');
        labels[v.slice(0, eq)] = v.slice(eq + 1);
      });
      boxes.set(name, { running: false, labels });
    }
    if (a === 'start') boxes.get(args[1]!)!.running = true;
    if (a === 'stop') boxes.get(args.at(-1)!)!.running = false;
    return ok();
  };
  return { run, calls };
}

let t: TestDaemon | undefined;
let base: string;
let catalogDir: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-connectors-')));
  catalogDir = join(base, 'catalog');
  writeConnector(catalogDir, 'uno-dos');
  writeConnector(catalogDir, 'tres-cuatro');
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  rmSync(base, { recursive: true, force: true });
});

const file = (): string => connectorsFile(join(base, 'companion'));

async function start(
  extra: { runner?: ReturnType<typeof fakeRunner>; withBox?: boolean } = {},
): Promise<{ runner: ReturnType<typeof fakeRunner> }> {
  const runner = extra.runner ?? fakeRunner();
  t = await startTestDaemon({
    base,
    connectorCatalog: loadConnectorCatalog(catalogDir),
    box: new BoxManager({
      config: BoxConfigSchema.parse({ image: 'custom/box:1' }),
      exchangeDir: join(base, 'exchange'),
      run: runner.run,
      detect: async () => ({ ok: true, runtime: { kind: 'podman', bin: 'podman' } }),
    }),
  });
  return { runner };
}

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) =>
      err instanceof ProtocolError
        ? `${err.code}${err.data?.reason ? `:${err.data.reason}` : ''}`
        : `threw ${String(err)}`,
  );

describe('connectors.* (M20)', () => {
  it('list: un observador ve el catálogo, nada activo y la caja de conectores', async () => {
    await start();
    const observer = await t!.connect(['observer'], 'obs');
    const list = await observer.request('connectors.list', {});
    expect(connectorsListSchema.parse(list)).toBeDefined();
    expect(list.readOnly).toBe(false);
    expect(list.box).toEqual({ state: 'absent', reason: null });
    expect(list.connectors.map((c) => [c.id, c.enabled, c.enabledAt])).toEqual([
      ['tres-cuatro', false, null],
      ['uno-dos', false, null],
    ]);
    expect(list.connectors.find((c) => c.id === 'uno-dos')).toMatchObject({
      name: 'Conector uno-dos',
      hosts: ['api.example.com'],
      needs: [{ name: SECRET_NAME, description: 'La clave de la API' }],
      tools: [
        { name: 'leer', readOnly: true, summary: 'Lee' },
        { name: 'escribir', readOnly: false, summary: 'Escribe' },
      ],
    });
  });

  it('enable exige approve: operator y control reciben FORBIDDEN y no se escribe nada', async () => {
    await start();
    const operator = await t!.connect(['operator'], 'op');
    const observer = await t!.connect(['observer'], 'obs');
    expect(await code(operator.request('connectors.enable', { connectorId: 'uno-dos' }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(observer.request('connectors.enable', { connectorId: 'uno-dos' }))).toBe(
      'FORBIDDEN',
    );
    expect(enabledConnectorIds(file())).toEqual([]);
  });

  it('enable con approve escribe connectors.json, es idempotente y se ve en list', async () => {
    await start();
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    const first = await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    expect(first.changed).toBe(true);
    expect(first.connector).toMatchObject({ id: 'uno-dos', enabled: true });
    expect(typeof first.connector.enabledAt).toBe('number');

    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as {
      schemaVersion: number;
      enabled: { id: string }[];
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.enabled.map((e) => e.id)).toEqual(['uno-dos']);

    const again = await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    expect(again.changed).toBe(false);
    expect(again.connector.enabledAt).toBe(first.connector.enabledAt);
    expect(enabledConnectorIds(file())).toEqual(['uno-dos']);

    const observer = await t!.connect(['observer'], 'obs');
    const list = await observer.request('connectors.list', {});
    expect(list.connectors.find((c) => c.id === 'uno-dos')).toMatchObject({ enabled: true });
    expect(list.connectors.find((c) => c.id === 'tres-cuatro')).toMatchObject({ enabled: false });
  });

  it('disable solo exige control, es idempotente y deja el resto activo', async () => {
    await start();
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    const operator = await t!.connect(['operator'], 'op');
    const observer = await t!.connect(['observer'], 'obs');
    await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    await approver.request('connectors.enable', { connectorId: 'tres-cuatro' });

    expect(await code(observer.request('connectors.disable', { connectorId: 'uno-dos' }))).toBe(
      'FORBIDDEN',
    );
    const off = await operator.request('connectors.disable', { connectorId: 'uno-dos' });
    expect(off.changed).toBe(true);
    expect(off.connector).toMatchObject({ id: 'uno-dos', enabled: false, enabledAt: null });
    expect(enabledConnectorIds(file())).toEqual(['tres-cuatro']);
    expect((await operator.request('connectors.disable', { connectorId: 'uno-dos' })).changed).toBe(
      false,
    );
  });

  it('un id fuera del catálogo es NOT_FOUND, al activar y al desactivar', async () => {
    await start();
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    expect(await code(approver.request('connectors.enable', { connectorId: 'no-existe' }))).toBe(
      'NOT_FOUND',
    );
    expect(await code(approver.request('connectors.disable', { connectorId: 'no-existe' }))).toBe(
      'NOT_FOUND',
    );
    expect(enabledConnectorIds(file())).toEqual([]);
  });

  it('un connectors.json de un Stratum más nuevo: UNAVAILABLE read-only y no se toca', async () => {
    await start();
    mkdirSync(join(base, 'companion'), { recursive: true });
    const text = JSON.stringify({ schemaVersion: 99, enabled: [] });
    writeFileSync(file(), text);
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    expect(await code(approver.request('connectors.enable', { connectorId: 'uno-dos' }))).toBe(
      'UNAVAILABLE:read-only',
    );
    expect(await code(approver.request('connectors.disable', { connectorId: 'uno-dos' }))).toBe(
      'UNAVAILABLE:read-only',
    );
    expect(readFileSync(file(), 'utf-8')).toBe(text);
    const list = await approver.request('connectors.list', {});
    expect(list.readOnly).toBe(true);
    expect(list.connectors.every((c) => !c.enabled)).toBe(true);
  });

  it('activar con la caja en marcha arranca la de conectores; con la caja parada, no', async () => {
    const { runner } = await start();
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    const operator = await t!.connect(['operator'], 'op');

    // Caja parada (ni existe): activar no la arranca.
    await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    expect(runner.calls.some((c) => c[0] === 'create')).toBe(false);
    await approver.request('connectors.disable', { connectorId: 'uno-dos' });

    // Con la principal en marcha, activar arranca la de conectores.
    await operator.request('box.start', {});
    expect(
      runner.calls.some((c) => c[0] === 'create' && c[2] === 'stratum-box-box-connectors'),
    ).toBe(false);
    await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    const create = runner.calls.find(
      (c) => c[0] === 'create' && c[2] === 'stratum-box-box-connectors',
    );
    expect(create).toBeDefined();
    // La caja de conectores no es la caja del agente (`exec` nunca la alcanza).
    expect(create!.some((a) => a.startsWith(`${BOX_LABEL}=`))).toBe(false);
    expect(runner.calls).toContainEqual(['start', 'stratum-box-box-connectors']);
    const list = await operator.request('connectors.list', {});
    expect(list.box).toEqual({ state: 'running', reason: null });

    // Repetir (sin cambio) no vuelve a tocar la caja.
    runner.calls.length = 0;
    await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    expect(runner.calls).toEqual([]);
  });

  it('un fallo al arrancar la caja de conectores no deshace la activación', async () => {
    const runner = fakeRunner({ failConnectorsCreate: true });
    await start({ runner });
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    const operator = await t!.connect(['operator'], 'op');
    await operator.request('box.start', {});
    const r = await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    expect(r).toMatchObject({ changed: true, connector: { enabled: true } });
    expect(enabledConnectorIds(file())).toEqual(['uno-dos']);
    const list = await operator.request('connectors.list', {});
    expect(list.box.state).toBe('absent');
    expect(list.box.reason).toMatch(/no space left/);
  });

  it('ninguna respuesta lleva valores de secreto, solo su nombre', async () => {
    await start();
    const approver = await t!.connect(['operator', 'approver'], 'ap');
    const enabled = await approver.request('connectors.enable', { connectorId: 'uno-dos' });
    const list = await approver.request('connectors.list', {});
    for (const payload of [enabled, list]) {
      const text = JSON.stringify(payload);
      expect(text).toContain(SECRET_NAME);
      expect(text).not.toMatch(/"(value|secret|token|apiKey)"/i);
    }
    expect(readFileSync(file(), 'utf-8')).not.toContain(SECRET_NAME);
  });
});

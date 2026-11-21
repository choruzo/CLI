import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BoxConfigSchema } from '../config/schema.js';
import { BoxManager } from '../box/manager.js';
import type { RuntimeRunner } from '../box/runtime.js';
import { loadConnectorCatalog } from '../connectors/catalog.js';
import { connectorsFile, enableConnector } from '../connectors/store.js';
import { doctorReportSchema } from '../protocol/schemas.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

/**
 * M23 — `doctor.run` en el daemon: lo ve un observador, valida con el
 * contrato, cuenta lo que solo sabe el daemon (autoarranque de la caja,
 * conectores sin configurar) y nunca lleva el valor de un secreto.
 */

const SECRET_VALUE = 'sk-doctor-test-value-123456';

function writeConnector(catalogDir: string, id: string, secrets: string[]): void {
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
      secrets: secrets.map((name) => ({ name, description: 'Una clave' })),
      tools: [{ name: 'leer', readOnly: true, summary: 'Lee' }],
    }),
  );
}

/** Ningún contenedor existe; arrancar no hace falta en estos tests. */
const absentRunner: RuntimeRunner = async (_bin, args) =>
  args[0] === 'container' && args[1] === 'inspect'
    ? { exitCode: 1, stdout: '', stderr: `Error: No such container: ${args[2]}` }
    : { exitCode: 0, stdout: '', stderr: '' };

let t: TestDaemon | undefined;
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-doctor-')));
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe('doctor.run (M23)', () => {
  it('un observador recibe un informe válido con lo que sabe el daemon', async () => {
    const catalogDir = join(base, 'catalog');
    writeConnector(catalogDir, 'con-clave', ['API_TOKEN']);
    writeConnector(catalogDir, 'sin-configurar', ['OTRA_CLAVE']);
    const companion = join(base, 'companion');
    mkdirSync(companion, { recursive: true });
    enableConnector(connectorsFile(companion), 'con-clave', new Date());
    enableConnector(connectorsFile(companion), 'sin-configurar', new Date());
    const daemonDir = join(base, 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(
      join(daemonDir, 'connector-secrets.json'),
      JSON.stringify({
        schemaVersion: 1,
        connectors: { 'con-clave': { API_TOKEN: SECRET_VALUE } },
        updatedAt: new Date().toISOString(),
      }),
    );

    t = await startTestDaemon({
      base,
      connectorCatalog: loadConnectorCatalog(catalogDir),
      box: new BoxManager({
        config: BoxConfigSchema.parse({ enabled: true }),
        exchangeDir: join(base, 'exchange'),
        run: absentRunner,
        detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
      }),
      loginAutostart: async () => ({ enabled: false, detail: null }),
    });
    const observer = await t.connect(['observer'], 'obs');
    const { report } = await observer.request('doctor.run', {});
    expect(doctorReportSchema.parse(report)).toBeDefined();
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    expect(byId.get('daemon.running')?.status).toBe('ok');
    expect(byId.get('daemon.autostart')).toMatchObject({
      status: 'off',
      fix: 'stratum daemon autostart on',
    });
    // La caja habilitada y sin crear: avisa y dice cómo arrancarla.
    expect(byId.get('box.state')).toMatchObject({ status: 'warn', fix: 'stratum box start' });
    expect(byId.get('box.autostart')?.status).toBe('off');
    expect(byId.get('connectors.box')?.status).toBe('fail');
    expect(byId.get('connector.con-clave')?.status).toBe('ok');
    expect(byId.get('connector.sin-configurar')).toMatchObject({
      status: 'fail',
      detail: 'Missing: OTRA_CLAVE.',
      fix: 'stratum connectors setup sin-configurar',
    });
    // El provider de los tests no escucha: se dice, sin la URL.
    expect(byId.get('model.provider')).toMatchObject({ status: 'fail' });
    expect(JSON.stringify(report)).not.toContain('127.0.0.1');
    // Ningún valor de un secreto sale del daemon.
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
  });

  it('cuenta lo que hizo el autoarranque de la caja', async () => {
    t = await startTestDaemon({
      base,
      box: new BoxManager({
        config: BoxConfigSchema.parse({ enabled: true, autostart: true }),
        exchangeDir: join(base, 'exchange'),
        run: absentRunner,
        detect: async () => ({ ok: false, reason: 'Docker is not running.' }),
      }),
      boxAutostart: { enabled: true, retryMs: 60_000, windowMs: 600_000 },
    });
    await t.daemon.boxAutostart.idle();
    const observer = await t.connect(['observer'], 'obs');
    const { report } = await observer.request('doctor.run', {});
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get('box.autostart')).toMatchObject({
      status: 'warn',
      title: 'Waiting for the container runtime to start the box',
    });
    expect(byId.get('box.runtime')).toMatchObject({
      status: 'fail',
      detail: 'Docker is not running.',
    });
  });
});

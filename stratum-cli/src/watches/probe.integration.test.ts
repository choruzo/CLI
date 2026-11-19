/**
 * M22 — la sonda de los vigilantes contra el conector de verdad: se empaqueta
 * el server de Home Assistant con esbuild (como hará tsup), se levanta un HA
 * falso en `127.0.0.1` y se comprueba el camino completo —caja (falsa, en
 * marcha), secretos, cliente MCP real y `structuredContent`— hasta el
 * `CheckOutcome` que lee el motor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoxConfigSchema } from '../config/schema.js';
import { BOX_CONNECTORS_LABEL, BOX_ROLE_LABEL } from '../box/spec.js';
import { bundledCatalog } from '../connectors/active.js';
import { CONNECTOR_SECRETS_SCHEMA_VERSION, connectorSecretsPath } from '../connectors/secrets.js';
import { CONNECTORS_SCHEMA_VERSION, connectorsFile } from '../connectors/store.js';
import { McpServerClient } from '../tools/mcp/client.js';
import { connectorProbe } from './probe.js';

const ENTRY = fileURLToPath(
  new URL('../connector-servers/home-assistant/server.ts', import.meta.url),
);

let tmp: string;
let bundle: string;
let ha: Server;
let haUrl: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-watch-probe-it-'));
  bundle = join(tmp, 'server.mjs');
  await build({
    entryPoints: [ENTRY],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  ha = createServer((req, res) => {
    if (req.url === '/api/states/light.salon') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          entity_id: 'light.salon',
          state: 'off',
          attributes: { friendly_name: 'Salón' },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => ha.listen(0, '127.0.0.1', resolve));
  haUrl = `http://127.0.0.1:${(ha.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => ha.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

describe('M22 — connectorProbe contra Home Assistant', () => {
  it('con la caja en marcha y los secretos puestos, devuelve el estado estructurado', async () => {
    const dataDir = join(tmp, 'companion');
    const secretsDir = join(tmp, 'daemon');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(
      connectorsFile(dataDir),
      JSON.stringify({
        schemaVersion: CONNECTORS_SCHEMA_VERSION,
        enabled: [{ id: 'home-assistant', enabledAt: '2026-11-17T09:00:00.000Z' }],
      }),
      'utf-8',
    );
    writeFileSync(
      connectorSecretsPath(secretsDir),
      JSON.stringify({
        schemaVersion: CONNECTOR_SECRETS_SCHEMA_VERSION,
        connectors: { 'home-assistant': { HA_URL: haUrl, HA_TOKEN: 'tok-de-pruebas' } },
        updatedAt: '2026-11-17T09:00:00.000Z',
      }),
      'utf-8',
    );

    const probe = connectorProbe({
      dataDir,
      secretsDir,
      box: BoxConfigSchema.parse({}),
      catalog: bundledCatalog(),
      // La caja es falsa (`launch`), así que el cliente lanza el server
      // empaquetado en este proceso y le pasa los secretos por entorno, como
      // haría `podman exec` con `-e NOMBRE`.
      client: (_config, _beforeConnect) =>
        new McpServerClient({
          name: 'home-assistant',
          command: process.execPath,
          args: [bundle],
          env: { ...process.env, HA_URL: haUrl, HA_TOKEN: 'tok-de-pruebas' },
          startupTimeout: 15_000,
          toolTimeout: 30_000,
        } as never),
      launch: {
        detect: async () => ({ ok: true, runtime: { kind: 'podman', bin: 'podman' } }),
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              State: { Running: true },
              Config: {
                Labels: { [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' },
              },
            },
          ]),
          stderr: '',
        }),
      },
    });

    const outcome = await probe.run('home-assistant', [
      { tool: 'ha_comprobar', args: { entity_id: 'light.salon' } },
    ]);
    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.outcomes[0]).toMatchObject({
      ok: true,
      result: { estado: 'off', valor: null, detalle: 'Salón — off' },
    });
  }, 90_000);
});

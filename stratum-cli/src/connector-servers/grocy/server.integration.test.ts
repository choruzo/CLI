/**
 * Empaqueta el server con esbuild (como hará tsup en el build) y lo conecta con
 * el cliente MCP real de Stratum: debe arrancar sin node_modules, sin GROCY_URL
 * ni GROCY_API_KEY, y exponer exactamente las tools del manifiesto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServerClient } from '../../tools/mcp/client.js';

const ENTRY = fileURLToPath(new URL('./server.ts', import.meta.url));
const MANIFEST = fileURLToPath(
  new URL('../../../connectors/grocy/connector.json', import.meta.url),
);

let tmp: string;
let bundle: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-connector-'));
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
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('server de Grocy empaquetado', () => {
  it('conecta, expone las tools del manifiesto y avisa de que no está configurado', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      tools: Array<{ name: string }>;
    };
    const env = { ...process.env } as Record<string, string>;
    delete env.GROCY_URL;
    delete env.GROCY_API_KEY;
    const client = new McpServerClient({
      name: 'grocy',
      command: process.execPath,
      args: [bundle],
      env,
      startupTimeout: 15000,
      toolTimeout: 120000,
    } as never);
    try {
      await client.connect();
      expect(client.status).toBe('connected');
      expect(client.tools.map((t) => t.name).sort()).toEqual(
        manifest.tools.map((t) => t.name).sort(),
      );
      expect(client.tools).toHaveLength(6);
      const res = await client.callTool('grocy_despensa', {});
      expect(JSON.stringify(res)).toContain('Grocy no está configurado');
    } finally {
      await client.close();
    }
  }, 60_000);
});

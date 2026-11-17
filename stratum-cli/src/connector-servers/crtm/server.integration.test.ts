/**
 * Empaqueta el server con esbuild (como hará tsup en el build) y lo conecta con
 * el cliente MCP real de Stratum: debe arrancar sin node_modules, contestar al
 * `initialize` al instante aunque no haya índice y exponer exactamente las
 * tools del manifiesto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServerClient } from '../../tools/mcp/client.js';
import { buildAllFixtureIndexes } from './test-helpers.js';

const ENTRY = fileURLToPath(new URL('./server.ts', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../../connectors/crtm/connector.json', import.meta.url));

/** Lo que mira el test de una respuesta JSON-RPC. */
interface RpcMessage {
  id: number;
  result: { serverInfo: { name: string }; isError?: boolean; content: Array<{ text: string }> };
}

let tmp: string;
let bundle: string;
let cache: string;
let withIndexes: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-connector-crtm-'));
  cache = join(tmp, 'cache');
  withIndexes = join(tmp, 'cache-ready');
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
  await buildAllFixtureIndexes(join(withIndexes, 'crtm'));
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function env(cacheDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    STRATUM_CONNECTOR_CACHE: cacheDir,
    STRATUM_CRTM_OFFLINE: '1',
  };
}

describe('server de CRTM empaquetado', () => {
  it('conecta con McpServerClient y expone exactamente las tools del manifiesto', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      tools: Array<{ name: string; readOnly: boolean }>;
    };
    const client = new McpServerClient({
      name: 'crtm',
      command: process.execPath,
      args: [bundle],
      env: env(cache),
      startupTimeout: 15000,
      toolTimeout: 120000,
    } as never);
    try {
      const t0 = Date.now();
      await client.connect();
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(client.status).toBe('connected');
      expect(client.tools.map((t) => t.name).sort()).toEqual(
        manifest.tools.map((t) => t.name).sort(),
      );
      expect(client.tools).toHaveLength(4);
      expect(manifest.tools.every((t) => t.readOnly)).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  async function session(cacheDir: string) {
    const p = spawn(process.execPath, [bundle], {
      env: env(cacheDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    let buf = '';
    const waiters = new Map<number, (m: RpcMessage) => void>();
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(l) as RpcMessage;
        waiters.get(m.id)?.(m);
      }
    });
    const rpc = (id: number, method: string, params?: object) =>
      new Promise<RpcMessage>((resolve) => {
        waiters.set(id, resolve);
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    return { rpc, stderr: () => stderr, close: () => (p.stdin.end(), p.kill()) };
  }

  it('sin índice responde al instante y la tool dice que está preparando los horarios (sin red ni ruido en stderr)', async () => {
    const s = await session(cache);
    try {
      const t0 = Date.now();
      const init = await s.rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('crtm');
      expect(Date.now() - t0).toBeLessThan(5_000);
      const res = await s.rpc(2, 'tools/call', {
        name: 'transporte_salidas',
        arguments: { parada: 'Las Tablas' },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text).toMatch(/^Estoy preparando los horarios de /);
      expect(s.stderr()).not.toMatch(/ExperimentalWarning|SQLite/);
    } finally {
      s.close();
    }
  }, 30_000);

  it('con los índices en la caché responde con datos y la atribución, sin ruido en stderr', async () => {
    const s = await session(withIndexes);
    try {
      await s.rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
      const res = await s.rpc(2, 'tools/call', {
        name: 'transporte_lineas',
        arguments: { modo: 'ml', linea: 'ML1' },
      });
      expect(res.result.isError).toBeUndefined();
      expect(res.result.content[0]!.text).toContain('Línea ML1 de Metro Ligero');
      expect(res.result.content[0]!.text).toContain('Origen de los datos: CRTM');
      expect(s.stderr()).not.toMatch(/ExperimentalWarning|SQLite/);
    } finally {
      s.close();
    }
  }, 30_000);
});

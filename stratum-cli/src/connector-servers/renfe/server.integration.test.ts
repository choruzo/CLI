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
import { PREPARING_MESSAGE } from './static-feed.js';

const ENTRY = fileURLToPath(new URL('./server.ts', import.meta.url));
const MANIFEST = fileURLToPath(
  new URL('../../../connectors/renfe/connector.json', import.meta.url),
);

/** Lo que mira el test de una respuesta JSON-RPC. */
interface RpcMessage {
  id: number;
  result: { serverInfo: { name: string }; isError?: boolean; content: Array<{ text: string }> };
}

let tmp: string;
let bundle: string;
let cache: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-connector-renfe-'));
  cache = join(tmp, 'cache');
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

function env(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    STRATUM_CONNECTOR_CACHE: cache,
    STRATUM_RENFE_OFFLINE: '1',
  };
}

describe('server de Renfe empaquetado', () => {
  it('conecta con McpServerClient y expone exactamente las tools del manifiesto', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      tools: Array<{ name: string }>;
    };
    const client = new McpServerClient({
      name: 'renfe',
      command: process.execPath,
      args: [bundle],
      env: env(),
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
    } finally {
      await client.close();
    }
  }, 60_000);

  it('sin índice responde al instante y la tool dice que está preparando los horarios (sin red ni ruido en stderr)', async () => {
    const p = spawn(process.execPath, [bundle], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const lines: string[] = [];
    let buf = '';
    const waiters = new Map<number, (m: RpcMessage) => void>();
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(l);
        const m = JSON.parse(l) as RpcMessage;
        waiters.get(m.id)?.(m);
      }
    });
    const rpc = (id: number, method: string, params?: object) =>
      new Promise<RpcMessage>((resolve) => {
        waiters.set(id, resolve);
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    try {
      const t0 = Date.now();
      const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('renfe');
      expect(Date.now() - t0).toBeLessThan(5_000);
      const res = await rpc(2, 'tools/call', {
        name: 'cercanias_salidas',
        arguments: { estacion: 'Atocha' },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toBe(PREPARING_MESSAGE);
      expect(stderr).not.toMatch(/ExperimentalWarning|SQLite/);
    } finally {
      p.stdin.end();
      p.kill();
    }
  }, 30_000);
});

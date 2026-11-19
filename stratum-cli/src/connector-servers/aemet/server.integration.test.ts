/**
 * Empaqueta el server con esbuild (como hará tsup en el build) y lo conecta con
 * el cliente MCP real de Stratum: debe arrancar sin node_modules, contestar al
 * `initialize` al instante (no pide nada a AEMET al arrancar), exponer
 * exactamente las tools del manifiesto y atribuir los datos a AEMET.
 *
 * No toca la red: `aemet_municipios` sale de la tabla empaquetada y el municipio
 * inexistente se resuelve antes de pedir nada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServerClient } from '../../tools/mcp/client.js';

const ENTRY = fileURLToPath(new URL('./server.ts', import.meta.url));
const MANIFEST = fileURLToPath(
  new URL('../../../connectors/aemet/connector.json', import.meta.url),
);
const ATRIBUCION = 'Fuente: AEMET (© AEMET, https://www.aemet.es)';

/** Lo que mira el test de una respuesta JSON-RPC. */
interface RpcMessage {
  id: number;
  result: { serverInfo: { name: string }; isError?: boolean; content: Array<{ text: string }> };
}

let tmp: string;
let bundle: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-connector-aemet-'));
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

describe('server de AEMET empaquetado', () => {
  it('conecta con McpServerClient y expone exactamente las tools del manifiesto', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      tools: Array<{ name: string; readOnly: boolean }>;
    };
    const client = new McpServerClient({
      name: 'aemet',
      command: process.execPath,
      args: [bundle],
      env: process.env as Record<string, string>,
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
      expect(client.tools).toHaveLength(manifest.tools.length);
      expect(manifest.tools.every((t) => t.readOnly)).toBe(true);
      // Los municipios salen de la tabla empaquetada: nada de red.
      const res = JSON.stringify(await client.callTool('aemet_municipios', { nombre: 'Getafe' }));
      expect(res).toContain('Getafe · Madrid · 28065');
      expect(res).toContain(ATRIBUCION);
    } finally {
      await client.close();
    }
  }, 60_000);

  async function session() {
    const p = spawn(process.execPath, [bundle], {
      env: process.env as Record<string, string>,
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

  it('contesta al instante, atribuye en la salida y en el error, y no ensucia stderr', async () => {
    const s = await session();
    try {
      const t0 = Date.now();
      const init = await s.rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('aemet');
      expect(Date.now() - t0).toBeLessThan(5_000);

      const list = await s.rpc(2, 'tools/list');
      expect(JSON.stringify(list)).toContain('aemet_prevision');

      // Un municipio que no existe se resuelve sin pedir nada a AEMET.
      const fallo = await s.rpc(3, 'tools/call', {
        name: 'aemet_prevision',
        arguments: { municipio: 'zzzz' },
      });
      expect(fallo.result.content[0]!.text).toContain('No encuentro ningún municipio');
      expect(fallo.result.content[0]!.text.split('\n').at(-1)).toBe(ATRIBUCION);

      const args = await s.rpc(4, 'tools/call', {
        name: 'aemet_prevision',
        arguments: { municipio: 'Getafe', dias: 9 },
      });
      expect(args.result.isError).toBe(true);
      expect(args.result.content[0]!.text).toContain('dias debe ser un entero entre 1 y 7');
      expect(args.result.content[0]!.text.split('\n').at(-1)).toBe(ATRIBUCION);

      expect(s.stderr()).not.toMatch(/ExperimentalWarning|Error interno/);
    } finally {
      s.close();
    }
  }, 30_000);
});

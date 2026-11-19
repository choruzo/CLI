/**
 * M22 — las comprobaciones que declara el manifiesto (`checks`) tienen que
 * existir de verdad en el server: la tool con su `outputSchema`, los mismos
 * argumentos, y un `structuredContent` que `parseCheckResult` sabe leer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCheckResult } from '../../connectors/checks.js';
import { checksOf, parseConnectorManifest } from '../../connectors/manifest.js';
import { createMcpServer } from '../lib/mcp-stdio.js';
import { createAemetTools } from './tools.js';
import { AemetAvisos, RSS_URL } from './warnings.js';

const MANIFEST = fileURLToPath(
  new URL('../../../connectors/aemet/connector.json', import.meta.url),
);
const manifest = parseConnectorManifest(
  JSON.parse(readFileSync(MANIFEST, 'utf8')),
  'connector.json',
);

const FIXTURES = join(import.meta.dirname, 'fixtures');
const espXml = readFileSync(join(FIXTURES, 'esp.xml'), 'utf8');
const capXml = readFileSync(join(FIXTURES, 'cap.xml'), 'utf8');

/** Martes 17/11/2026, 20:30 en Madrid. */
const now = (): Date => new Date('2026-11-17T19:30:00Z');

const fetchImpl = (async (url: string | URL | Request): Promise<Response> =>
  new Response(String(url) === RSS_URL ? espXml : capXml)) as typeof fetch;

const tools = createAemetTools({
  forecast: {
    diaria: () => Promise.reject(new Error('no se usa')),
    horaria: () => Promise.reject(new Error('no se usa')),
  },
  avisos: new AemetAvisos({ fetchImpl, now }),
  now,
});
const server = createMcpServer({ name: manifest.id, version: manifest.version }, tools);

const checks = checksOf(manifest).map((c) => [c.tool, c] as const);

describe('comprobaciones del manifiesto de AEMET', () => {
  it('el manifiesto declara al menos una', () => {
    expect(checks.length).toBeGreaterThan(0);
  });

  it.each(checks)('%s existe como tool y declara su outputSchema', (_name, check) => {
    const tool = tools.find((t) => t.name === check.tool);
    expect(tool).toBeDefined();
    expect(tool!.outputSchema).toBeDefined();
  });

  it.each(checks)('%s valida exactamente los argumentos declarados', (_name, check) => {
    const tool = tools.find((t) => t.name === check.tool)!;
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      check.args.map((a) => a.name).sort(),
    );
    expect([...(schema.required ?? [])].sort()).toEqual(
      check.args
        .filter((a) => a.required)
        .map((a) => a.name)
        .sort(),
    );
  });

  it('tools/call devuelve un resultado estructurado que parseCheckResult lee', async () => {
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aemet_comprobar_avisos', arguments: { municipio: '27019' } },
    })) as { result: unknown };
    expect(parseCheckResult(r.result)).toEqual({
      ok: true,
      result: {
        estado: 'amarillo',
        valor: 1,
        detalle: 'Aviso amarillo de Vientos en Foz (Lugo, 27019); 1 aviso',
      },
    });
  });
});

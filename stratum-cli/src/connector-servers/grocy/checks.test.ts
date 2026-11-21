/**
 * M22 — la comprobación que declara el manifiesto de Grocy (`checks`) tiene que
 * existir de verdad en el server: la tool con su `outputSchema`, los mismos
 * argumentos, y un `structuredContent` que `parseCheckResult` sabe leer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCheckResult } from '../../connectors/checks.js';
import { checksOf, parseConnectorManifest } from '../../connectors/manifest.js';
import { createMcpServer } from '../lib/mcp-stdio.js';
import { createGrocyTools } from './tools.js';

const MANIFEST = fileURLToPath(
  new URL('../../../connectors/grocy/connector.json', import.meta.url),
);
const manifest = parseConnectorManifest(
  JSON.parse(readFileSync(MANIFEST, 'utf8')),
  'connector.json',
);
const KEY = 'clave-SECRETA-123';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fakeFetch(status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const p = new URL(String(input)).pathname.replace(/^\/api/, '');
    if (status !== 200) return new Response('{}', { status });
    if (p === '/stock/volatile') return new Response(JSON.stringify(fixture('volatile')));
    if (p === '/objects/products') return new Response(JSON.stringify(fixture('products')));
    if (p === '/objects/quantity_units')
      return new Response(JSON.stringify(fixture('quantity_units')));
    if (p === '/objects/locations') return new Response(JSON.stringify(fixture('locations')));
    return new Response('?', { status: 500 });
  }) as typeof fetch;
}

function build(status = 200) {
  const tools = createGrocyTools({
    fetch: fakeFetch(status),
    url: 'http://grocy.casa:9283/api',
    apiKey: KEY,
    now: () => Date.parse('2026-11-21T10:00:00Z'),
  });
  return {
    tools,
    server: createMcpServer({ name: manifest.id, version: manifest.version }, tools),
  };
}

const { tools, server } = build();
const checks = checksOf(manifest).map((c) => [c.tool, c] as const);

async function call(srv: typeof server, args: unknown): Promise<{ result: unknown }> {
  return (await srv.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'grocy_comprobar', arguments: args },
  })) as { result: unknown };
}

describe('comprobaciones del manifiesto de Grocy', () => {
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
    const r = await call(server, { que: 'caducado' });
    expect(parseCheckResult(r.result)).toEqual({
      ok: true,
      result: {
        estado: 'hay',
        valor: 2,
        detalle: '2 productos caducados o con el consumo preferente pasado: Yogur, Queso',
      },
    });
  });

  it('un fallo de Grocy es un fallo de la comprobación, no un estado', async () => {
    const r = await call(build(500).server, { que: 'caducado' });
    const parsed = parseCheckResult(r.result);
    expect(parsed.ok).toBe(false);
  });
});

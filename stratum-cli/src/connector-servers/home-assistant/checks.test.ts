/**
 * M22 — las comprobaciones que declara el manifiesto (`checks`) tienen que
 * existir de verdad en el server: la tool con su `outputSchema`, los mismos
 * argumentos, y un `structuredContent` que `parseCheckResult` sabe leer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCheckResult } from '../../connectors/checks.js';
import { checksOf, parseConnectorManifest } from '../../connectors/manifest.js';
import { createMcpServer } from '../lib/mcp-stdio.js';
import { createHomeAssistantTools } from './tools.js';

const MANIFEST = fileURLToPath(
  new URL('../../../connectors/home-assistant/connector.json', import.meta.url),
);
const manifest = parseConnectorManifest(
  JSON.parse(readFileSync(MANIFEST, 'utf8')),
  'connector.json',
);
const TOKEN = 'tok-SECRETO-123';

const STATES = [
  {
    entity_id: 'light.salon',
    state: 'on',
    attributes: { friendly_name: 'Luz del salón' },
    last_changed: null,
  },
];

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const p = new URL(String(input)).pathname;
    if (p === '/api/config') {
      return new Response(JSON.stringify({ location_name: 'Casa', time_zone: 'Europe/Madrid' }));
    }
    if (p === '/api/states') return new Response(JSON.stringify(STATES));
    if (p.startsWith('/api/states/')) {
      const s = STATES.find((x) => x.entity_id === decodeURIComponent(p.slice(12)));
      return s ? new Response(JSON.stringify(s)) : new Response('{}', { status: 404 });
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
}

const tools = createHomeAssistantTools({
  fetch: fakeFetch(),
  url: 'http://ha.casa:8123',
  token: TOKEN,
});
const server = createMcpServer({ name: manifest.id, version: manifest.version }, tools);

const checks = checksOf(manifest).map((c) => [c.tool, c] as const);

describe('comprobaciones del manifiesto de Home Assistant', () => {
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
      params: { name: 'ha_comprobar', arguments: { entity_id: 'light.salon' } },
    })) as { result: unknown };
    expect(parseCheckResult(r.result)).toEqual({
      ok: true,
      result: { estado: 'on', valor: null, detalle: 'Luz del salón — on' },
    });
  });
});

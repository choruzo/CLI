/**
 * M22 — la comprobación que declara el manifiesto de Renfe (`checks`) tiene que
 * existir de verdad en el server: la tool con su `outputSchema`, los mismos
 * argumentos y un `structuredContent` que `parseCheckResult` sabe leer. Sin red:
 * índice de fixtures y feeds falsos.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCheckResult } from '../../connectors/checks.js';
import { checksOf, parseConnectorManifest } from '../../connectors/manifest.js';
import { createMcpServer, ToolUserError } from '../lib/mcp-stdio.js';
import type { RealtimeSource } from './realtime.js';
import { createRenfeCheckTools } from './tools.js';
import {
  NOW,
  alertEntity,
  buildFixtureIndex,
  encodeFeed,
  fakeRealtime,
  fixtureContext,
} from './test-helpers.js';

const MANIFEST = fileURLToPath(
  new URL('../../../connectors/renfe/connector.json', import.meta.url),
);
const manifest = parseConnectorManifest(
  JSON.parse(readFileSync(MANIFEST, 'utf8')),
  'connector.json',
);
const TS = Math.floor(new Date('2026-11-11T17:35:40Z').getTime() / 1000);

let tmp: string;
let indexPath: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-checks-'));
  indexPath = await buildFixtureIndex(tmp);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function alertsRt(): RealtimeSource {
  return fakeRealtime({
    alerts: encodeFeed(TS, [
      alertEntity({
        id: 'A1',
        routeIds: ['10T0007C3', '10T0008C3'],
        description: 'Obras entre Atocha y Chamartín.',
        start: TS - 3600,
      }),
      alertEntity({
        id: 'A2',
        stopIds: ['17000'],
        header: 'Chamartín',
        description: 'Ascensor averiado.',
        start: TS - 600,
      }),
      alertEntity({
        id: 'A3',
        routeIds: ['10T0001C1'],
        description: 'Aviso ya caducado.',
        start: TS - 7200,
        end: TS - 3600,
      }),
      alertEntity({
        id: 'A4',
        routeIds: ['30T0001C1'],
        description: 'Incidencia en Sevilla.',
        start: TS - 100,
      }),
    ]),
  });
}

function check(rt: RealtimeSource | null) {
  const tool = createRenfeCheckTools(fixtureContext(indexPath, rt, NOW))[0]!;
  return (args: object) => tool.handler(args);
}

describe('cercanias_comprobar_avisos', () => {
  it('con avisos en el núcleo: cuenta los vigentes y no los caducados ni los de otro núcleo', async () => {
    const r = await check(alertsRt())({ nucleo: 'madrid' });
    expect(r.structured).toMatchObject({ estado: 'con_avisos', valor: 2 });
    expect(r.structured.detalle).toContain('(2 avisos en Madrid)');
    expect(r.text).toContain('Origen de los datos: Renfe Operadora');
    expect(r.text).not.toContain('Sevilla');
  });

  it('con avisos en la línea', async () => {
    const r = await check(alertsRt())({ nucleo: 'madrid', linea: 'C3' });
    expect(r.structured).toMatchObject({ estado: 'con_avisos', valor: 2 });
    expect(r.structured.detalle).toContain('C3');
  });

  it('solo avisos caducados o de otro núcleo: sin_avisos con valor 0', async () => {
    const rt = fakeRealtime({
      alerts: encodeFeed(TS, [
        alertEntity({
          id: 'A3',
          routeIds: ['10T0001C1'],
          description: 'Aviso ya caducado.',
          start: TS - 7200,
          end: TS - 3600,
        }),
        alertEntity({
          id: 'A4',
          routeIds: ['30T0001C1'],
          description: 'Incidencia en Sevilla.',
          start: TS - 100,
        }),
      ]),
    });
    const r = await check(rt)({ nucleo: 'madrid', linea: 'C3' });
    expect(r.structured).toEqual({
      estado: 'sin_avisos',
      valor: 0,
      detalle: 'Sin avisos en Madrid C3',
    });
  });

  it('sin ningún aviso en el feed', async () => {
    const r = await check(fakeRealtime({ alerts: encodeFeed(TS, []) }))({ nucleo: 'madrid' });
    expect(r.structured).toEqual({
      estado: 'sin_avisos',
      valor: 0,
      detalle: 'Sin avisos en Madrid',
    });
  });

  it('recorta el texto de un aviso largo', async () => {
    const rt = fakeRealtime({
      alerts: encodeFeed(TS, [
        alertEntity({ id: 'L', routeIds: ['10T0007C3'], description: 'x'.repeat(2000), start: TS }),
      ]),
    });
    const r = await check(rt)({ nucleo: 'madrid' });
    expect((r.structured.detalle as string).length).toBeLessThanOrEqual(300);
  });

  it('núcleo o línea desconocidos son un error que dice qué tool usar', async () => {
    const c = check(alertsRt());
    await expect(c({ nucleo: 'narnia' })).rejects.toThrow(/cercanias_nucleos/);
    await expect(c({ nucleo: 'madrid', linea: 'Z99' })).rejects.toThrow(/cercanias_lineas/);
    await expect(c({ nucleo: 'madrid', linea: 'C3 C2' })).rejects.toBeInstanceOf(ToolUserError);
    await expect(c({})).rejects.toBeInstanceOf(ToolUserError);
  });

  it('un feed de avisos ilegible o sin tiempo real es un error, nunca sin_avisos', async () => {
    await expect(check(fakeRealtime({}))({ nucleo: 'madrid' })).rejects.toThrow(/avisos de Renfe/);
    await expect(check(null)({ nucleo: 'madrid' })).rejects.toThrow(/avisos de Renfe/);
  });
});

const checks = checksOf(manifest).map((c) => [c.tool, c] as const);
const tools = createRenfeCheckTools(fixtureContext('sin-uso.db', null, NOW));

describe('comprobaciones del manifiesto de Renfe', () => {
  it('el manifiesto declara al menos una', () => {
    expect(checks.length).toBeGreaterThan(0);
  });

  it.each(checks)('%s existe como tool, declara su outputSchema y es de solo lectura', (_n, c) => {
    const tool = tools.find((t) => t.name === c.tool);
    expect(tool).toBeDefined();
    expect(tool!.outputSchema).toBeDefined();
    expect(manifest.tools.find((t) => t.name === c.tool)?.readOnly).toBe(true);
  });

  it.each(checks)('%s valida exactamente los argumentos declarados', (_n, c) => {
    const tool = tools.find((t) => t.name === c.tool)!;
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(c.args.map((a) => a.name).sort());
    expect([...(schema.required ?? [])].sort()).toEqual(
      c.args
        .filter((a) => a.required)
        .map((a) => a.name)
        .sort(),
    );
  });

  it('los ids reales de núcleo y los nombres de línea casan con los patrones declarados', () => {
    const args = checks[0]![1].args;
    const nucleo = new RegExp(`^(?:${args.find((a) => a.name === 'nucleo')!.pattern})$`);
    const linea = new RegExp(`^(?:${args.find((a) => a.name === 'linea')!.pattern})$`);
    for (const id of ['madrid', 'murcia-alicante', 'san-sebastian', 'rodalies']) {
      expect(nucleo.test(id)).toBe(true);
    }
    for (const l of ['C3', 'R2', 'C1', 'R2N', 'C10']) expect(linea.test(l)).toBe(true);
  });

  it('tools/call devuelve un resultado estructurado que parseCheckResult lee', async () => {
    const server = createMcpServer(
      { name: manifest.id, version: manifest.version },
      createRenfeCheckTools(fixtureContext(indexPath, alertsRt(), NOW)),
    );
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'cercanias_comprobar_avisos', arguments: { nucleo: 'madrid' } },
    })) as { result: unknown };
    const parsed = parseCheckResult(r.result);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.result).toMatchObject({ estado: 'con_avisos', valor: 2 });
    }
  });
});

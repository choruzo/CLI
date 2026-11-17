/**
 * Server de fixtures del conector Renfe, **solo para los evals** (`stratum eval`,
 * `setup.connectors` de un escenario). Sirve las mismas tools que `server.ts`,
 * pero sobre un mundo fijo: el GTFS recortado de `fixtures/`, un tiempo real
 * fabricado que casa con él y un reloj parado. Así una pregunta del escenario
 * tiene siempre la misma respuesta correcta, con guion y contra un modelo real.
 *
 * Nunca va en la imagen de la caja (no está en la config de tsup de los
 * conectores): lo lanza el runner de evals como un server MCP del `companion`.
 * `STRATUM_RENFE_FIXTURES` es la carpeta `fixtures/` (obligatoria: en un bundle,
 * `import.meta.url` no apunta a ella).
 *
 * El mundo (2026-11-11, Madrid):
 * - Cercanías a las 18:36: el C3 Atocha→Chamartín de las 18:50 con +4 min y en
 *   la vía 2; el C2 Atocha→Alcalá de las 18:45 con +10 min; el C3 a Aranjuez de
 *   las 18:58, cancelado; el C3 de las 19:20 no para en Atocha. Avisos: obras en
 *   el C3 entre Atocha y Chamartín, el ascensor de Chamartín y uno de Sevilla.
 * - Larga distancia a las 07:36, con los `.pb` reales de esa mañana.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import {
  NOW,
  NOW_LD,
  alertEntity,
  buildFixtureIndex,
  buildLdFixtureIndex,
  encodeFeed,
  fakeRealtime,
  fixtureContext,
  ldFakeRealtime,
  ldFixtureContext,
  ldRealtimeFeeds,
  tripUpdateEntity,
  vehicleEntity,
} from './test-helpers.js';
import { createRenfeTools } from './tools.js';
import { createTrenesTools } from './tools-ld.js';

/** Hora del tiempo real de Cercanías: 18:35 en Madrid, un minuto antes del reloj. */
const RT_TS = Math.floor(new Date('2026-11-11T17:35:40Z').getTime() / 1000);

function cercaniasRealtime() {
  return fakeRealtime(
    {
      trip_updates: encodeFeed(RT_TS, [
        tripUpdateEntity({
          tripId: 'S110022C3',
          delay: 240,
          stops: [{ stopId: '18000', arrival: { delay: 240 } }],
        }),
        tripUpdateEntity({ tripId: 'S110025C2', delay: 600 }),
        tripUpdateEntity({ tripId: 'S110023C3', relationship: 3 }),
        tripUpdateEntity({ tripId: 'S110029C3', stops: [{ stopId: '18000', relationship: 1 }] }),
      ]),
      vehicle_positions: encodeFeed(RT_TS, [
        vehicleEntity({
          tripId: 'S110022C3',
          label: 'C3-10022-PLATF.(2)',
          stopId: '18000',
          status: 1,
          lat: 40.4066,
          lon: -3.6894,
        }),
      ]),
      alerts: encodeFeed(RT_TS, [
        alertEntity({
          id: 'A1',
          routeIds: ['10T0007C3', '10T0008C3'],
          description: 'Obras entre Atocha y Chamartín.',
          start: RT_TS - 3600,
        }),
        alertEntity({
          id: 'A2',
          stopIds: ['17000'],
          header: 'Chamartín',
          description: 'Ascensor averiado.',
          start: RT_TS - 600,
        }),
        alertEntity({
          id: 'A4',
          routeIds: ['30T0001C1'],
          description: 'Incidencia en Sevilla.',
          start: RT_TS - 100,
        }),
      ]),
    },
    NOW,
  );
}

async function main(): Promise<void> {
  const fixtures = process.env.STRATUM_RENFE_FIXTURES;
  if (!fixtures || !existsSync(join(fixtures, 'gtfs'))) {
    process.stderr.write('[renfe-fixture] STRATUM_RENFE_FIXTURES no apunta a fixtures/\n');
    process.exit(2);
  }
  // Los índices de las fixtures son pequeños: se construyen antes de contestar
  // a `initialize`, en una carpeta propia que se borra al salir.
  const dir = mkdtempSync(join(tmpdir(), 'stratum-renfe-fixture-'));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  process.on('exit', cleanup);
  const indexPath = await buildFixtureIndex(join(dir, 'cer'), () => undefined, fixtures);
  const ldIndexPath = await buildLdFixtureIndex(join(dir, 'ld'), fixtures);

  serveStdio(
    createMcpServer({ name: 'renfe', version: '1.2.0-fixture' }, [
      ...createRenfeTools(fixtureContext(indexPath, cercaniasRealtime(), NOW)),
      ...createTrenesTools(
        ldFixtureContext(ldIndexPath, ldFakeRealtime(ldRealtimeFeeds(fixtures), NOW_LD), NOW_LD),
      ),
    ]),
  );
}

void main();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { RealtimeSource } from './realtime.js';
import { createRenfeTools, attribution } from './tools.js';
import {
  FIXTURES,
  NOW,
  alertEntity,
  buildFixtureIndex,
  encodeFeed,
  fakeFeedFetch,
  fakeRealtime,
  fixtureContext,
  tripUpdateEntity,
  vehicleEntity,
} from './test-helpers.js';

void FIXTURES;

let tmp: string;
let indexPath: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-tools-'));
  indexPath = await buildFixtureIndex(tmp);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const TS = Math.floor(new Date('2026-11-11T17:35:40Z').getTime() / 1000); // 18:35 en Madrid
const ATTR =
  'Origen de los datos: Renfe Operadora (horarios del 11/11/2026; tiempo real de las 18:35)';
const ATTR_STATIC = 'Origen de los datos: Renfe Operadora (horarios del 11/11/2026)';

function tools(
  rt: RealtimeSource | null,
  now = NOW,
): Record<string, (args: object) => Promise<string>> {
  const list: ConnectorTool[] = createRenfeTools(fixtureContext(indexPath, rt, now));
  return Object.fromEntries(list.map((t) => [t.name, (a: object) => t.handler(a)]));
}

/** Tiempo real de un escenario con cada caso (retraso informado, arrastrado, cancelado, saltado…). */
function scenario(): RealtimeSource {
  return fakeRealtime({
    trip_updates: encodeFeed(TS, [
      // C3 Atocha→Chamartín 18:50: retraso informado en Atocha (+4).
      tripUpdateEntity({
        tripId: 'S110022C3',
        delay: 240,
        stops: [{ stopId: '18000', arrival: { delay: 240 } }],
      }),
      // C2 Atocha→Alcalá 18:45: solo delay del viaje (+10): arrastrado.
      tripUpdateEntity({ tripId: 'S110025C2', delay: 600 }),
      // C3 Atocha→Aranjuez 18:58: cancelado.
      tripUpdateEntity({ tripId: 'S110023C3', relationship: 3 }),
      // C3 Atocha→Chamartín 19:20: no para en Atocha.
      tripUpdateEntity({ tripId: 'S110029C3', stops: [{ stopId: '18000', relationship: 1 }] }),
    ]),
    vehicle_positions: encodeFeed(TS, [
      vehicleEntity({
        tripId: 'S110022C3',
        label: 'C3-10022-PLATF.(2)',
        stopId: '18000',
        status: 1,
        lat: 40.4066,
        lon: -3.6894,
      }),
    ]),
    alerts: encodeFeed(TS, []),
  });
}

describe('atribución', () => {
  it('con y sin tiempo real', () => {
    expect(attribution('20261111', TS)).toBe(ATTR);
    expect(attribution('20261111', null)).toBe(ATTR_STATIC);
  });

  it('toda salida acaba con la atribución (y nunca insinúa respaldo de Renfe)', async () => {
    const t = tools(scenario());
    const outs = await Promise.all([
      t.cercanias_nucleos!({}),
      t.cercanias_lineas!({ nucleo: 'madrid' }),
      t.cercanias_estaciones!({ nombre: 'sol' }),
      t.cercanias_salidas!({ estacion: 'est:18000' }),
      t.cercanias_salidas!({ estacion: 'Sol' }), // ambigua
      t.cercanias_trayecto!({ origen: 'Atocha', destino: 'Chamartín' }),
      t.cercanias_tren!({ tren: 'S110022C3' }),
      t.cercanias_avisos!({}),
      t.cercanias_avisos!({ nucleo: 'madrid' }),
    ]);
    for (const out of outs) {
      const last = out.split('\n').at(-1)!;
      expect(last).toMatch(/^Origen de los datos: Renfe Operadora \(horarios del 11\/11\/2026/);
      expect(out).not.toMatch(/oficial|respald|patrocin/i);
    }
  });
});

describe('cercanias_nucleos / cercanias_lineas', () => {
  it('núcleos por comunidad, con id y número de líneas', async () => {
    const out = await tools(null).cercanias_nucleos!({});
    expect(out).toContain('Comunidad de Madrid: Madrid (madrid) · 3 líneas');
    expect(out).toContain('Andalucía: Sevilla (sevilla) · 1 línea');
    expect(out).not.toContain('Rodalies'); // no está en el feed recortado
  });

  it('filtra por comunidad', async () => {
    const out = await tools(null).cercanias_nucleos!({ comunidad: 'andalucia' });
    expect(out).toContain('Sevilla (sevilla)');
    expect(out).not.toContain('Madrid');
    await expect(tools(null).cercanias_nucleos!({ comunidad: 'Narnia' })).rejects.toThrow(
      /cercanias_nucleos sin argumentos/,
    );
  });

  it('líneas de un núcleo con extremos y número de estaciones', async () => {
    const out = await tools(null).cercanias_lineas!({ nucleo: 'madrid' });
    expect(out).toContain('madrid/C3 · Aranjuez – Madrid-Chamartín-Clara Campoamor · 5 estaciones');
    expect(out).toContain(
      'madrid/C1 · Madrid-Chamartín-Clara Campoamor – Madrid-Aeropuerto T4 · 2 estaciones',
    );
    // También por nombre o por comunidad.
    expect(await tools(null).cercanias_lineas!({ nucleo: 'Sevilla' })).toContain('sevilla/C1');
    expect(await tools(null).cercanias_lineas!({ nucleo: 'Comunidad de Madrid' })).toContain(
      'madrid/C2',
    );
  });

  it('un núcleo desconocido orienta hacia cercanias_nucleos', async () => {
    await expect(tools(null).cercanias_lineas!({ nucleo: 'rodalies' })).rejects.toThrow(
      /cercanias_nucleos/,
    );
  });
});

describe('cercanias_estaciones', () => {
  it('lista de una línea en orden, con transbordos', async () => {
    const out = await tools(null).cercanias_estaciones!({ linea: 'madrid/C3' });
    const lines = out.split('\n');
    expect(lines[1]).toBe('1. Aranjuez · id est:60200');
    expect(lines[2]).toBe('2. Madrid-Atocha Cercanías (transbordo: C2) · id est:18000');
    expect(out).toContain(
      '5. Madrid-Chamartín-Clara Campoamor (transbordo: C1, C2) · id est:17000',
    );
  });

  it('«C1» sin núcleo es ambigua y devuelve los ids; con nucleo se resuelve', async () => {
    const amb = await tools(null).cercanias_estaciones!({ linea: 'C1' });
    expect(amb).toContain('madrid/C1');
    expect(amb).toContain('sevilla/C1');
    expect(amb).toContain('Repite con linea: "<id>"');
    const ok = await tools(null).cercanias_estaciones!({ linea: 'C1', nucleo: 'madrid' });
    expect(ok).toContain('Estaciones de madrid/C1');
  });

  it('por nombre: sin acentos, y candidatos con núcleo, líneas e id', async () => {
    const out = await tools(null).cercanias_estaciones!({ nombre: 'alcala' });
    expect(out).toContain('Alcalá de Henares — Madrid · C2 · id est:70103');
    expect(out).toContain('Alcalá de Henares-Universidad — Madrid · C2 · id est:70107');
    // Una coincidencia exacta gana a las parciales.
    const exact = await tools(null).cercanias_estaciones!({ nombre: 'Alcalá de Henares' });
    expect(exact).toContain('(1)');
    expect(await tools(null).cercanias_estaciones!({ nombre: 'sol' })).toContain('Sevilla');
    expect(
      await tools(null).cercanias_estaciones!({ nombre: 'sol', nucleo: 'madrid' }),
    ).not.toContain('Sevilla');
  });

  it('sin resultados no es un error, y sin argumentos orienta', async () => {
    expect(await tools(null).cercanias_estaciones!({ nombre: 'zzzz' })).toContain(
      'No encontré ninguna estación',
    );
    await expect(tools(null).cercanias_estaciones!({})).rejects.toThrow(/linea|nombre|nucleo/);
  });

  it('lo que no tiene servicio no es una estación', async () => {
    expect(await tools(null).cercanias_estaciones!({ nombre: 'sin servicio' })).toContain(
      'No encontré',
    );
  });
});

describe('cercanias_salidas', () => {
  it('sin tiempo real: horario y «sin datos de tiempo real» (nunca 0)', async () => {
    const out = await tools(null).cercanias_salidas!({ estacion: 'est:18000', max: 3 });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Salidas desde Madrid-Atocha Cercanías (Madrid) · desde las 18:36:');
    expect(lines[1]).toBe(
      'C2 a Alcalá de Henares-Universidad · sale 18:45 (en 9 min) · sin datos de tiempo real',
    );
    expect(lines[2]).toBe(
      'C3 a Madrid-Chamartín-Clara Campoamor · sale 18:50 (en 14 min) · sin datos de tiempo real',
    );
    expect(out).not.toMatch(/\+0|puntual/);
    expect(out).toContain('Hay más salidas: pide desde: "');
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
  });

  it('con tiempo real: informado, arrastrado, cancelado, saltado y vía; ordenadas por hora estimada', async () => {
    const out = await tools(scenario()).cercanias_salidas!({ estacion: 'est:18000', max: 6 });
    const lines = out.split('\n');
    // El C2 de las 18:45 lleva +10 min (arrastrado): sale 18:55, después del C3 de las 18:50 (+4 → 18:54).
    expect(lines[1]).toBe(
      'C3 a Madrid-Chamartín-Clara Campoamor · sale 18:54 (en 18 min) · +4 min (horario 18:50) · vía 2',
    );
    expect(lines[2]).toBe(
      'C2 a Alcalá de Henares-Universidad · sale 18:55 (en 19 min) · +10 min, estimado (horario 18:45)',
    );
    expect(out).toContain('C3 a Aranjuez · 18:58 · cancelado');
    expect(out).toContain(
      'C3 a Madrid-Chamartín-Clara Campoamor · 19:20 · no para en esta estación',
    );
    expect(out.split('\n').at(-1)).toBe(ATTR);
  });

  it('un viaje sin actualización dice «sin datos de tiempo real» aunque el feed funcione', async () => {
    const out = await tools(scenario()).cercanias_salidas!({ estacion: 'est:18000', max: 20 });
    expect(out).toMatch(
      /C2 a Alcalá de Henares-Universidad · sale 19:15 \(en 39 min\) · sin datos de tiempo real/,
    );
  });

  it('si el tiempo real falla, la salida sale con horario y sin la parte de tiempo real', async () => {
    const down = new RealtimeSource({ fetch: fakeFeedFetch({}), now: () => NOW.getTime() });
    const out = await tools(down).cercanias_salidas!({ estacion: 'est:18000', max: 2 });
    expect(out).toContain('sin datos de tiempo real');
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
  });

  it('destino filtra los trenes que paran después en esa estación', async () => {
    const out = await tools(null).cercanias_salidas!({
      estacion: 'Atocha',
      destino: 'Aranjuez',
      max: 2,
    });
    expect(out).toContain('hacia Aranjuez');
    const rows = out.split('\n').filter((l) => l.startsWith('C'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatch(/^C3 a Aranjuez/); // los C3 hacia Chamartín no pasan por Aranjuez después
    // Hacia Alcalá desde Atocha: solo C2.
    const alc = await tools(null).cercanias_salidas!({
      estacion: 'Atocha',
      destino: 'Alcalá de Henares',
      max: 2,
    });
    for (const r of alc.split('\n').filter((l) => l.startsWith('C'))) expect(r).toMatch(/^C2 /);
  });

  it('linea filtra; una línea desconocida orienta', async () => {
    const out = await tools(null).cercanias_salidas!({ estacion: 'Atocha', linea: 'C2', max: 20 });
    for (const r of out.split('\n').filter((l) => /^C\d/.test(l))) expect(r).toMatch(/^C2 /);
    await expect(
      tools(null).cercanias_salidas!({ estacion: 'Atocha', linea: 'C9' }),
    ).rejects.toThrow(/cercanias_lineas/);
  });

  it('desde cambia el inicio y el tren de madrugada del día anterior (horas > 24:00) aparece', async () => {
    const out = await tools(null).cercanias_salidas!({
      estacion: 'est:18000',
      desde: '00:10',
      max: 2,
    });
    expect(out).toContain('C3 a Madrid-Chamartín-Clara Campoamor · sale 00:10');
  });

  it('sin salidas en la ventana no es un error', async () => {
    const late = new Date('2026-11-11T22:50:00Z'); // 23:50: Sevilla ya no tiene servicio
    const out = await tools(null, late).cercanias_salidas!({ estacion: 'est:51100' });
    expect(out).toMatch(/No hay salidas desde Sevilla-Santa Justa/);
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
  });

  it('estación ambigua: no adivina, devuelve candidatos con su núcleo y su id', async () => {
    const out = await tools(null).cercanias_salidas!({ estacion: 'Sol' });
    expect(out).toContain('1. Sol — Madrid · C3 · id est:18101');
    expect(out).toContain('2. Sol — Sevilla · C1 · id est:51105');
    expect(out).toContain('Repite cercanias_salidas con estacion: "est:<id>"');
  });

  it('estación desconocida y argumentos inválidos orientan', async () => {
    const t = tools(null);
    await expect(t.cercanias_salidas!({ estacion: 'Narnia' })).rejects.toThrow(
      'No conozco la estación «Narnia». Usa cercanias_estaciones con nombre: "Narnia"',
    );
    await expect(t.cercanias_salidas!({ estacion: 'Sol', max: 99 })).rejects.toThrow(
      'max debe ser un entero entre 1 y 20',
    );
    await expect(
      t.cercanias_salidas!({ estacion: 'Atocha', desde: '9 de la noche' }),
    ).rejects.toThrow(/desde debe ser una hora/);
    await expect(t.cercanias_salidas!({})).rejects.toBeInstanceOf(ToolUserError);
  });

  it('si los horarios no cubren hoy, lo dice', async () => {
    const out = tools(null, new Date('2027-03-01T10:00:00Z')).cercanias_salidas!({
      estacion: 'Atocha',
    });
    await expect(out).rejects.toThrow(/no cubren hoy/);
  });
});

describe('cercanias_trayecto', () => {
  it('directo: horas de salida y llegada, duración, línea y retraso', async () => {
    const out = await tools(null).cercanias_trayecto!({
      origen: 'Atocha',
      destino: 'Chamartín',
      max: 2,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'Trayectos de Madrid-Atocha Cercanías a Madrid-Chamartín-Clara Campoamor desde las 18:36:',
    );
    expect(lines[1]).toBe('18:45 → 19:00 (15 min) · C2 · sin datos de tiempo real');
    expect(lines[2]).toBe('18:50 → 19:08 (18 min) · C3 · sin datos de tiempo real');
    expect(out).toContain('Hay más directos: pide desde: "');
  });

  it('con tiempo real las horas son estimadas y se omiten los cancelados', async () => {
    const out = await tools(scenario()).cercanias_trayecto!({
      origen: 'est:18000',
      destino: 'est:17000',
      max: 5,
    });
    // C3 18:50 con +4 min informado en Atocha y arrastrado a Chamartín: 18:54 → 19:12.
    expect(out).toContain('18:54 → 19:12 (18 min) · C3 · +4 min');
    // C2 18:45 con +10 min: 18:55 → 19:10.
    expect(out).toContain('18:55 → 19:10 (15 min) · C2 · +10 min, estimado');
    expect(out.split('\n').at(-1)).toBe(ATTR);
  });

  it('un tren cancelado no se ofrece y se avisa', async () => {
    const rt = fakeRealtime({
      trip_updates: encodeFeed(TS, [tripUpdateEntity({ tripId: 'S110022C3', relationship: 3 })]),
      vehicle_positions: encodeFeed(TS, []),
    });
    const out = await tools(rt).cercanias_trayecto!({
      origen: 'est:18000',
      destino: 'est:17000',
      max: 5,
    });
    expect(out).not.toContain('18:50');
    expect(out).toContain('(Omitidos por cancelación o sin parada: 1.)');
  });

  it('con un transbordo cuando no hay directos', async () => {
    const out = await tools(null).cercanias_trayecto!({
      origen: 'est:18101',
      destino: 'Aeropuerto T4',
      max: 2,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'No hay trenes directos de Sol a Madrid-Aeropuerto T4 en las próximas 2 h; con un transbordo desde las 18:36:',
    );
    // El C3 hacia Chamartín sale de Sol a las 18:55 y llega a las 19:08; el C1 de las 19:05 ya se fue.
    expect(lines[1]).toBe(
      '18:55 C3 → Madrid-Chamartín-Clara Campoamor 19:08 · cambio a C1 19:35 → Madrid-Aeropuerto T4 19:50 (55 min) · sin datos de tiempo real',
    );
  });

  it('respeta el tiempo mínimo del transbordo de transfers.txt (7 min en Chamartín)', async () => {
    // El C1 llega a Chamartín a las 19:05: con 3 min por defecto cogería el C3 de las 19:10;
    // con los 7 min de transfers.txt no llega y coge el de las 19:40.
    const out = await tools(null).cercanias_trayecto!({
      origen: 'est:98305',
      destino: 'est:18101',
      max: 1,
    });
    expect(out).toContain(
      '18:50 C1 → Madrid-Chamartín-Clara Campoamor 19:05 · cambio a C3 19:40 → Sol 19:53 (63 min)',
    );
  });

  it('origen y destino iguales, ambiguos o desconocidos', async () => {
    const t = tools(null);
    await expect(t.cercanias_trayecto!({ origen: 'Atocha', destino: 'est:18000' })).rejects.toThrow(
      /la misma estación/,
    );
    expect(await t.cercanias_trayecto!({ origen: 'Sol', destino: 'Atocha' })).toContain(
      'Repite cercanias_trayecto con origen: "est:<id>"',
    );
    await expect(t.cercanias_trayecto!({ origen: 'Atocha', destino: 'Narnia' })).rejects.toThrow(
      /cercanias_estaciones/,
    );
  });

  it('sin trayecto posible en las próximas horas no es un error', async () => {
    // Sevilla no se conecta con Madrid.
    const out = await tools(null).cercanias_trayecto!({
      origen: 'est:51100',
      destino: 'est:18000',
    });
    expect(out).toContain('No encontré trayectos');
  });
});

describe('cercanias_tren', () => {
  it('estado, retraso, vía y próximas paradas con hora estimada', async () => {
    const out = await tools(scenario()).cercanias_tren!({ tren: '10022' });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'Tren 10022 · C3 a Madrid-Chamartín-Clara Campoamor (Madrid) · de Aranjuez 18:30 a 19:08',
    );
    expect(lines[1]).toBe('Estado: en Madrid-Atocha Cercanías (posición 40.4066, -3.6894)');
    expect(lines[2]).toBe('Retraso: +4 min');
    expect(lines[3]).toBe('Vía: 2 (en Madrid-Atocha Cercanías)');
    expect(out).toContain('· Madrid-Atocha Cercanías · 18:54 (+4 min; horario 18:50)');
    expect(out).toContain('· Sol · 18:59 (+4 min, estimado; horario 18:55)');
    expect(out).toContain(
      '· Madrid-Chamartín-Clara Campoamor · 19:12 (+4 min, estimado; horario 19:08)',
    );
  });

  it('acepta el trip_id completo, y un número desconocido orienta', async () => {
    expect(await tools(null).cercanias_tren!({ tren: 'S110022C3' })).toContain('Tren 10022');
    await expect(tools(null).cercanias_tren!({ tren: '99999' })).rejects.toThrow(
      /cercanias_salidas/,
    );
  });

  it('cancelado, y sin posición ni datos: lo dice', async () => {
    const out = await tools(scenario()).cercanias_tren!({ tren: 'S110023C3' });
    expect(out).toContain('Estado: cancelado');
    expect(out).not.toContain('Próximas paradas');
    const none = await tools(null).cercanias_tren!({ tren: 'S110022C3' });
    expect(none).toContain('Estado: sin posición en tiempo real');
    expect(none).toContain('Retraso: sin datos de tiempo real');
  });

  it('un tren que aún no ha salido o ya terminó', async () => {
    const before = await tools(null).cercanias_tren!({ tren: 'S110022C3' });
    expect(before).toContain('Estado:');
    const early = await tools(null, new Date('2026-11-11T16:00:00Z')).cercanias_tren!({
      tren: 'S110022C3',
    });
    expect(early).toContain('aún no ha salido (sale de Aranjuez a las 18:30)');
    const late = await tools(null, new Date('2026-11-11T19:00:00Z')).cercanias_tren!({
      tren: 'S110022C3',
    });
    expect(late).toContain('ya ha terminado su recorrido');
  });

  it('el tren de la madrugada del día anterior se encuentra pasada la medianoche', async () => {
    const out = await tools(null, new Date('2026-11-10T23:15:00Z')).cercanias_tren!({
      tren: '10058',
    });
    expect(out).toContain('Tren 10058');
    expect(out).toContain('Estado: sin posición en tiempo real');
  });
});

describe('cercanias_avisos', () => {
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

  it('filtra por núcleo y descarta los caducados', async () => {
    const out = await tools(alertsRt()).cercanias_avisos!({ nucleo: 'madrid' });
    expect(out).toContain('Avisos activos para Madrid (2):');
    expect(out).toContain('Obras entre Atocha y Chamartín.');
    expect(out).toContain('Chamartín: Ascensor averiado.');
    expect(out).not.toContain('caducado');
    expect(out).not.toContain('Sevilla');
  });

  it('por línea: avisos de la línea y de sus estaciones', async () => {
    const out = await tools(alertsRt()).cercanias_avisos!({ linea: 'C3', nucleo: 'madrid' });
    expect(out).toContain('(2)');
    expect(out).toContain('[Madrid C3]');
  });

  it('por estación: los de su línea y los suyos', async () => {
    const t = tools(alertsRt());
    const cham = await t.cercanias_avisos!({ estacion: 'est:17000' });
    expect(cham).toContain('(2)');
    const aranjuez = await t.cercanias_avisos!({ estacion: 'Aranjuez' });
    expect(aranjuez).toContain('(1)');
    expect(aranjuez).toContain('Obras entre Atocha');
  });

  it('sin avisos para el filtro no es un error', async () => {
    const out = await tools(alertsRt()).cercanias_avisos!({ estacion: 'Alcalá de Henares' });
    expect(out).toContain('Sin avisos activos para Alcalá de Henares.');
    expect(out.split('\n').at(-1)).toBe(ATTR);
  });

  it('sin filtros resume cuántos hay por núcleo y pide filtrar', async () => {
    const out = await tools(alertsRt()).cercanias_avisos!({});
    expect(out).toContain('Hay 3 avisos activos (Madrid 2, Sevilla 1).');
    expect(out).toContain('nucleo, linea o estacion');
  });

  it('sin tiempo real lo dice (no es un error)', async () => {
    const out = await tools(null).cercanias_avisos!({ nucleo: 'madrid' });
    expect(out).toContain('Sin datos de tiempo real');
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
  });
});

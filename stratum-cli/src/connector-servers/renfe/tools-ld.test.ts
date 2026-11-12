import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { buildLdIndex } from './index-ld-build.js';
import type { RealtimeSource } from './realtime.js';
import { attributionLd, createTrenesTools, productLabel } from './tools-ld.js';
import {
  NOW_LD,
  buildLdFixtureIndex,
  ldFakeRealtime,
  ldFixtureContext,
  makeZip,
} from './test-helpers.js';

let tmp: string;
let indexPath: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-ld-tools-'));
  indexPath = await buildLdFixtureIndex(tmp);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ATTR_RT =
  'Origen de los datos: Renfe Operadora (horarios de larga distancia del 11/11/2026; tiempo real de las 20:30)';
const ATTR_STATIC =
  'Origen de los datos: Renfe Operadora (horarios de larga distancia del 11/11/2026)';

function tools(
  rt: RealtimeSource | null,
  now = NOW_LD,
): Record<string, (args: object) => Promise<string>> {
  const list: ConnectorTool[] = createTrenesTools(ldFixtureContext(indexPath, rt, now));
  return Object.fromEntries(list.map((t) => [t.name, (a: object) => t.handler(a)]));
}

/** Atocha (Puerta de Atocha), Chamartín: ids estables de la fixture. */
const ATOCHA = 'ld:60000';
const CHAMARTIN = 'ld:17000';

describe('atribución y descriptores', () => {
  it('con y sin tiempo real', () => {
    expect(attributionLd('20261111', 1794425443)).toBe(ATTR_RT);
    expect(attributionLd('20261111', null)).toBe(ATTR_STATIC);
  });

  it('las tools son tres, de solo lectura, con descripción y esquema estricto', () => {
    const list = createTrenesTools(ldFixtureContext(indexPath, null));
    expect(list.map((t) => t.name)).toEqual(['trenes_salidas', 'trenes_trayecto', 'trenes_tren']);
    for (const t of list) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('el producto se muestra como lo dice la gente', () => {
    expect(productLabel('ALVIA')).toBe('Alvia');
    expect(productLabel('AVE')).toBe('AVE');
    expect(productLabel('REG.EXP.')).toBe('Regional Exprés');
    expect(productLabel('NUEVO')).toBe('NUEVO');
  });

  it('toda salida acaba con la atribución (y nunca insinúa respaldo de Renfe)', async () => {
    const t = tools(ldFakeRealtime());
    const outs = await Promise.all([
      t.trenes_salidas!({ estacion: 'Madrid' }), // ambigua
      t.trenes_salidas!({ estacion: ATOCHA, destino: 'Sevilla' }),
      t.trenes_trayecto!({ origen: ATOCHA, destino: 'Sevilla' }),
      t.trenes_trayecto!({ origen: ATOCHA, destino: 'Barcelona', fecha: 'mañana' }),
      t.trenes_tren!({ tren: '194' }),
      t.trenes_tren!({ tren: '2070', fecha: 'mañana' }),
    ]);
    for (const out of outs) {
      const last = out.split('\n').at(-1)!;
      expect(last).toMatch(
        /^Origen de los datos: Renfe Operadora \(horarios de larga distancia del 11\/11\/2026/,
      );
      expect(out).not.toMatch(/oficial|respald|patrocin/i);
    }
    // Con tiempo real consultado, su hora; sin él (ambigua, otro día), solo los horarios.
    expect(outs[1]!.split('\n').at(-1)).toBe(ATTR_RT);
    expect(outs[0]!.split('\n').at(-1)).toBe(ATTR_STATIC);
    expect(outs[3]!.split('\n').at(-1)).toBe(ATTR_STATIC);
  });
});

describe('trenes_salidas', () => {
  it('«Madrid» es ambiguo: devuelve las estaciones con su id, no adivina', async () => {
    const out = await tools(null).trenes_salidas!({ estacion: 'Madrid' });
    expect(out).toContain('Hay varias estaciones que encajan con «Madrid»');
    expect(out).toContain('Madrid-Chamartín-Clara Campoamor · id ld:17000');
    expect(out).toContain('Madrid-Puerta de Atocha-Almudena Grandes · id ld:60000');
    expect(out).toContain('Madrid-Atocha Cercanías · id ld:18000');
    expect(out).toContain('Repite trenes_salidas con estacion: "ld:<id>"');
    expect(out).not.toContain('sale ');
  });

  it('una estación desconocida orienta', async () => {
    await expect(tools(null).trenes_salidas!({ estacion: 'Narnia' })).rejects.toThrow(
      /No encuentro ninguna estación de larga distancia/,
    );
  });

  it('hacia un destino: hora, minutos que faltan y «sin datos de tiempo real» si Renfe no informa', async () => {
    const out = await tools(ldFakeRealtime()).trenes_salidas!({
      estacion: 'Madrid-Puerta de Atocha',
      destino: 'Sevilla',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'Salidas de larga y media distancia desde Madrid-Puerta de Atocha-Almudena Grandes hacia Sevilla-Santa Justa · hoy (11/11/2026) desde las 07:36:',
    );
    expect(lines[1]).toBe(
      'AVE 2080 a Sevilla-Santa Justa · sale 08:00 (en 24 min) · sin datos de tiempo real',
    );
    expect(lines[2]).toBe(
      'AVLO 2096 a Sevilla-Santa Justa · sale 09:00 (en 84 min) · sin datos de tiempo real',
    );
    // Por defecto 8 salidas, y cómo pedir más.
    expect(lines.filter((l) => /^(AVE|AVLO) /.test(l))).toHaveLength(8);
    expect(out).toContain('Hay más salidas: repite con desde: "16:01".');
    expect(out).not.toContain('Barcelona'); // solo los que paran después en Sevilla
  });

  it('el CANCELED del feed LD se ignora (no es fiable); uno con retraso, la hora estimada y la de horario', async () => {
    const out = await tools(ldFakeRealtime()).trenes_salidas!({ estacion: CHAMARTIN });
    // El feed marca cancelado el 190, pero en LD esa marca no es fiable: sale sin tiempo real.
    expect(out).toContain('Alvia 190 a Badajoz · sale 08:30');
    expect(out).not.toContain('cancelado');
    expect(out).toContain(
      'Alvia 194 a Badajoz · sale 18:33 (en 657 min) · +13 min, estimado (horario 18:20)',
    );
  });

  it('las variantes de un mismo tren (mismo número y hora) salen una sola vez', async () => {
    const out = await tools(ldFakeRealtime()).trenes_salidas!({ estacion: CHAMARTIN });
    expect(out.split('\n').filter((l) => l.startsWith('Alvia 190 '))).toHaveLength(1);
    // Calatayud es el origen de una variante de 3062 y parada de la de Barcelona: un solo 3062.
    const cal = await tools(ldFakeRealtime()).trenes_salidas!({ estacion: 'Calatayud' });
    expect(cal.split('\n').filter((l) => l.startsWith('AVE 3062 '))).toHaveLength(1);
  });

  it('solo las paradas donde se puede subir cuentan como salida (no el final del viaje)', async () => {
    // Badajoz es el final de los Alvia de la fixture: no hay salidas desde allí.
    const out = await tools(ldFakeRealtime()).trenes_salidas!({ estacion: 'Badajoz' });
    expect(out).toContain('No hay salidas de larga distancia desde Badajoz hoy desde las 07:36.');
  });

  it('filtra por producto sin distinguir mayúsculas; uno desconocido lista los que hay', async () => {
    const out = await tools(null).trenes_salidas!({ estacion: ATOCHA, producto: 'avlo', max: 3 });
    const trains = out.split('\n').filter((l) => /^AVLO /.test(l));
    expect(trains).toHaveLength(3);
    expect(out).toContain('· AVLO · hoy');
    expect(out).not.toMatch(/^AVE /m);
    await expect(
      tools(null).trenes_salidas!({ estacion: ATOCHA, producto: 'tgv' }),
    ).rejects.toThrow('No conozco el producto «tgv». Los que hay: Alvia, AVE, AVLO.');
  });

  it('desde cambia la hora de inicio; max acota', async () => {
    const out = await tools(null).trenes_salidas!({ estacion: ATOCHA, desde: '17:00', max: 2 });
    const trains = out.split('\n').filter((l) => /sale /.test(l));
    expect(out).toContain('desde las 17:00:');
    expect(trains).toHaveLength(2);
    expect(trains[0]).toContain('AVLO 2176 a Sevilla-Santa Justa · sale 17:05 (en 569 min)');
  });

  it('otro día: solo la hora, sin tiempo real ni minutos que faltan', async () => {
    const out = await tools(ldFakeRealtime()).trenes_salidas!({
      estacion: CHAMARTIN,
      fecha: 'mañana',
    });
    expect(out).toContain('desde Madrid-Chamartín-Clara Campoamor · 12/11/2026 desde las 00:00:');
    expect(out).toContain('Alvia 190 a Badajoz · sale 08:30');
    expect(out).toContain('Alvia 194 a Badajoz · sale 18:20');
    expect(out).not.toMatch(/cancelado|tiempo real de|\+\d+ min|\(en /);
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
  });

  it('fecha explícita: calendar_dates quita un día y añade otro', async () => {
    const t = tools(null);
    // 14/11: el servicio del 190 de las 08:30 está quitado (otro 190, de las 09:10, sí circula).
    const quitado = await t.trenes_salidas!({ estacion: CHAMARTIN, fecha: '2026-11-14' });
    expect(quitado).not.toContain('sale 08:30');
    expect(quitado).toContain('Alvia 190 a Badajoz · sale 09:10');
    // 08/12: fuera del bloque de vigencia, pero añadido por calendar_dates.
    const anadido = await t.trenes_salidas!({ estacion: CHAMARTIN, fecha: '2026-12-08' });
    expect(anadido).toContain('Alvia 190 a Badajoz · sale 08:30');
  });

  it('fechas: hoy, mañana y pasado mañana; formato inválido o fuera de rango se explica', async () => {
    const t = tools(null);
    const hoy = await t.trenes_salidas!({ estacion: CHAMARTIN, fecha: 'hoy' });
    expect(hoy).toContain('hoy (11/11/2026)');
    const pasado = await t.trenes_salidas!({ estacion: CHAMARTIN, fecha: 'pasado mañana' });
    expect(pasado).toContain('13/11/2026');
    await expect(t.trenes_salidas!({ estacion: CHAMARTIN, fecha: 'ayer' })).rejects.toThrow(
      'fecha debe ser "YYYY-MM-DD", "hoy" o "mañana".',
    );
    await expect(t.trenes_salidas!({ estacion: CHAMARTIN, fecha: '2026-02-30' })).rejects.toThrow(
      /fecha debe ser/,
    );
    const e = await t.trenes_salidas!({ estacion: CHAMARTIN, fecha: '2030-01-01' }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ToolUserError);
    expect((e as Error).message).toBe(
      'No tengo horarios de larga distancia para el 01/01/2030: los que tengo cubren del 10/11/2026 al 12/12/2026.',
    );
    await expect(t.trenes_salidas!({ estacion: CHAMARTIN, fecha: '2026-11-09' })).rejects.toThrow(
      /los que tengo cubren del 10\/11\/2026/,
    );
  });

  it('un fallo del tiempo real no es un error: salen los horarios con «sin datos de tiempo real»', async () => {
    const out = await tools(ldFakeRealtime({})).trenes_salidas!({ estacion: CHAMARTIN });
    expect(out).toContain(
      'Alvia 190 a Badajoz · sale 08:30 (en 54 min) · sin datos de tiempo real',
    );
    expect(out).not.toContain('cancelado');
    expect(out.split('\n').at(-1)).toBe(ATTR_STATIC);
    // Y sin tiempo real configurado (null), igual.
    const sin = await tools(null).trenes_salidas!({ estacion: CHAMARTIN });
    expect(sin).toContain('sin datos de tiempo real');
  });

  it('argumentos inválidos dicen cuál', async () => {
    const t = tools(null);
    await expect(t.trenes_salidas!({})).rejects.toThrow(/estacion debe ser un texto/);
    await expect(t.trenes_salidas!({ estacion: ATOCHA, max: 99 })).rejects.toThrow(
      'max debe ser un entero entre 1 y 20',
    );
    await expect(t.trenes_salidas!({ estacion: ATOCHA, desde: '25h' })).rejects.toThrow(
      'desde debe ser una hora "HH:MM"',
    );
  });
});

describe('trenes_trayecto', () => {
  it('directos: salida → llegada, duración, tren y retraso', async () => {
    const out = await tools(ldFakeRealtime()).trenes_trayecto!({
      origen: ATOCHA,
      destino: 'Sevilla',
      max: 2,
    });
    expect(out.split('\n').slice(0, 3)).toEqual([
      'Trenes directos de Madrid-Puerta de Atocha-Almudena Grandes a Sevilla-Santa Justa · hoy (11/11/2026) desde las 07:36:',
      '08:00 → 10:39 (2 h 39 min) · AVE 2080 · sin datos de tiempo real',
      '09:00 → 11:52 (2 h 52 min) · AVLO 2096 · sin datos de tiempo real',
    ]);
    expect(out).toContain('Hay más trenes: repite con desde: "09:01".');
  });

  it('un directo con retraso informado muestra las horas estimadas', async () => {
    const out = await tools(ldFakeRealtime()).trenes_trayecto!({
      origen: CHAMARTIN,
      destino: 'Badajoz',
      desde: '05:00',
    });
    expect(out).toContain('18:33 → 23:25 (4 h 52 min) · Alvia 194 · +13 min, estimado');
    // El feed marca cancelado el 190 de las 08:30: se ignora y sale con su horario.
    expect(out).toContain('08:30 → ');
    expect(out).not.toContain('Cancelados');
  });

  it('aunque el feed marque cancelados todos los directos, salen con su horario', async () => {
    const out = await tools(ldFakeRealtime()).trenes_trayecto!({
      origen: ATOCHA,
      destino: 'Barcelona',
      desde: '05:00',
    });
    expect(out).toContain('06:27 → ');
    expect(out).toContain('AVE 3063');
    expect(out).toContain('AVE 3071');
    expect(out).not.toMatch(/cancelad/i);
  });

  it('sin directos: no hay transbordos y sugiere trenes_salidas en el origen', async () => {
    const out = await tools(null).trenes_trayecto!({ origen: CHAMARTIN, destino: ATOCHA });
    expect(out).toContain(
      'No hay trenes directos de Madrid-Chamartín-Clara Campoamor a Madrid-Puerta de Atocha',
    );
    expect(out).toContain('Aquí no hay transbordos');
    expect(out).toContain('trenes_salidas');
  });

  it('«Madrid» como origen devuelve candidatos; origen = destino es un error', async () => {
    const amb = await tools(null).trenes_trayecto!({ origen: 'Madrid', destino: 'Barcelona' });
    expect(amb).toContain('Hay varias estaciones que encajan con «Madrid»');
    expect(amb).toContain('Repite trenes_trayecto con origen: "ld:<id>"');
    await expect(
      tools(null).trenes_trayecto!({ origen: ATOCHA, destino: 'ld:60000' }),
    ).rejects.toThrow(/la misma estación/);
  });

  it('otro día: horas del horario, sin retraso, con la fecha', async () => {
    const out = await tools(ldFakeRealtime()).trenes_trayecto!({
      origen: ATOCHA,
      destino: 'Barcelona',
      fecha: '2026-11-12',
      desde: '05:00',
    });
    expect(out.split('\n').slice(0, 3)).toEqual([
      'Trenes directos de Madrid-Puerta de Atocha-Almudena Grandes a Barcelona-Sants · 12/11/2026 desde las 05:00:',
      '06:27 → 09:50 (3 h 23 min) · AVE 3063',
      '06:57 → 09:59 (3 h 2 min) · AVE 3071',
    ]);
    expect(out).not.toMatch(/cancelado|Cancelados|tiempo real|min ·/);
  });

  it('fuera de rango se dice hasta qué día hay horarios', async () => {
    await expect(
      tools(null).trenes_trayecto!({ origen: ATOCHA, destino: 'Sevilla', fecha: '2027-05-01' }),
    ).rejects.toThrow('los que tengo cubren del 10/11/2026 al 12/12/2026');
  });
});

describe('trenes_tren', () => {
  it('un tren con retraso, circulando: se funde la CANCELED residual y manda el vehículo', async () => {
    const out = await tools(ldFakeRealtime()).trenes_tren!({ tren: '194' });
    const lines = out.split('\n');
    expect(lines[0]).toBe(
      'Alvia 194 · Madrid-Chamartín-Clara Campoamor → Badajoz · sale 18:20, llega 23:12 · 11/11/2026',
    );
    expect(lines[1]).toBe('Estado: parado en Navalmoral de la Mata');
    expect(lines[2]).toBe('Retraso: +13 min');
    expect(out).not.toContain('cancelado');
    // Recorrido: lo ya pasado, con su hora de horario; el resto con la estimada.
    expect(out).toContain('Recorrido (8 paradas):');
    expect(out).toContain('· Leganés · 18:56 (ya pasó)');
    expect(out).toContain('· Navalmoral de la Mata · 21:08 (+13 min; horario 20:55)');
    expect(out).toContain('· Badajoz · 23:25 (+13 min, estimado; horario 23:12)');
    // Los SKIPPED contradictorios del feed no se enseñan.
    expect(out).not.toContain('no para');
  });

  it('el número vale con o sin ceros, con el producto delante o por trip_id', async () => {
    const t = tools(ldFakeRealtime());
    const a = await t.trenes_tren!({ tren: '194' });
    expect(await t.trenes_tren!({ tren: '00194' })).toBe(a);
    expect(await t.trenes_tren!({ tren: 'Alvia 194' })).toBe(a);
    expect(await t.trenes_tren!({ tren: '0019412026-11-11' })).toBe(a);
  });

  it('un tren que el feed marca cancelado: nunca «cancelado», sin tiempo real y su recorrido de horario', async () => {
    const out = await tools(ldFakeRealtime()).trenes_tren!({ tren: '190' });
    const lines = out.split('\n');
    expect(lines[0]).toContain(
      'Alvia 190 · Madrid-Chamartín-Clara Campoamor → Badajoz · sale 08:30, llega 13:38',
    );
    expect(lines[1]).toMatch(/^Estado: /);
    expect(out).not.toContain('cancelado');
    expect(out).toContain('Retraso: sin datos de tiempo real');
    expect(out).toContain('Recorrido (12 paradas):');
    expect(out).toContain('· Madrid-Atocha Cercanías · 08:43');
  });

  it('en marcha hacia una parada: «en camino a …» y un adelanto informado', async () => {
    const out = await tools(ldFakeRealtime()).trenes_tren!({ tren: '530' });
    expect(out).toContain('Estado: en camino a San Sebastián-Donostia (a unos 16 km)');
    expect(out).toContain('Retraso: -6 min');
    // Un adelanto no se arrastra: las paradas anteriores a la informada no dicen «+X».
    expect(out).toContain('· San Sebastián-Donostia · 20:55 (-6 min; horario 21:01)');
  });

  it('un vehículo sin parada propia: la parada del recorrido más cercana a sus coordenadas', async () => {
    // 00757 (variante «Alfaro» sin stop_id en el vehículo): la variante completa dice «camino de Logroño».
    const out = await tools(ldFakeRealtime()).trenes_tren!({ tren: '757' });
    expect(out).toContain('Estado: en camino a Logroño, cerca de Calahorra');
  });

  it('sin tiempo real: horario y «sin datos de tiempo real» según la hora', async () => {
    const t = tools(ldFakeRealtime());
    const enMarcha = await t.trenes_tren!({ tren: '2070' }); // 07:00–09:48 y son las 07:36
    expect(enMarcha).toContain('Estado: en marcha según el horario, sin posición en tiempo real');
    expect(enMarcha).toContain('Retraso: sin datos de tiempo real');
    const futuro = await t.trenes_tren!({ tren: '2160' });
    expect(futuro).toContain(
      'Estado: aún no ha salido (sale de Madrid-Puerta de Atocha-Almudena Grandes a las 16:00)',
    );
    // Más tarde ese mismo día: ya ha terminado.
    const tarde = await tools(null, new Date('2026-11-11T09:30:00Z')).trenes_tren!({
      tren: '2070',
    });
    expect(tarde).toContain('Estado: ya ha terminado su recorrido');
  });

  it('otro día: horario y aviso de que el tiempo real solo existe para hoy', async () => {
    const out = await tools(ldFakeRealtime()).trenes_tren!({ tren: '3063', fecha: 'mañana' });
    expect(out.split('\n')[0]).toContain('· 12/11/2026');
    expect(out).toContain('Tiempo real: solo existe para hoy; las horas son las del horario.');
    expect(out).not.toMatch(/Estado:|Retraso:|cancelado/);
    expect(out).toContain('· Zaragoza Delicias · 08:10');
    // Hoy el feed lo marca cancelado, y tampoco se dice.
    expect(await tools(ldFakeRealtime()).trenes_tren!({ tren: '3063' })).not.toContain('cancelado');
  });

  it('un tren que no circula ese día, o que no existe, se explica', async () => {
    const t = tools(null);
    await expect(t.trenes_tren!({ tren: '2070', fecha: '2026-12-08' })).rejects.toThrow(
      'El tren «2070» no circula el 08/12/2026 según los horarios que tengo.',
    );
    await expect(t.trenes_tren!({ tren: '99999' })).rejects.toThrow(
      /No conozco el tren «99999».*trenes_salidas/,
    );
    await expect(t.trenes_tren!({ tren: 'ninguno' })).rejects.toThrow(/No conozco el tren/);
    await expect(t.trenes_tren!({})).rejects.toThrow(/tren debe ser un texto/);
  });

  it('el recorrido se acota a 25 paradas: las 12 primeras, un resumen y las 12 últimas', async () => {
    // Un tren sintético de 30 paradas (la fixture real no pasa de 12).
    const stopIds = Array.from({ length: 30 }, (_, i) => `S${i + 1}`);
    const dir = mkdtempSync(join(tmpdir(), 'renfe-ld-long-'));
    try {
      const zip = makeZip({
        'routes.txt': 'route_id,route_short_name\nR1,MD\n',
        'stops.txt':
          'stop_id,stop_name,stop_lat,stop_lon\n' +
          stopIds.map((id, i) => `${id},Parada ${i + 1},40.0,-3.0`).join('\n') +
          '\n',
        'trips.txt': 'route_id,service_id,trip_id,trip_short_name\nR1,SV,T12026-11-11,07777\n',
        'stop_times.txt':
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n' +
          stopIds
            .map((id, i) => {
              const h = String(8 + Math.floor(i / 6)).padStart(2, '0');
              const m = String((i % 6) * 10).padStart(2, '0');
              return `T12026-11-11,${h}:${m}:00,${h}:${m}:00,${id},${i + 1},0,0`;
            })
            .join('\n') +
          '\n',
        'calendar.txt':
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSV,1,1,1,1,1,1,1,20261101,20261130\n',
        'calendar_dates.txt': 'service_id,date,exception_type\n',
      });
      const zipPath = join(dir, 'long.zip');
      writeFileSync(zipPath, zip);
      const built = await buildLdIndex({
        zipPath,
        dir,
        sourceUrl: 'test://long',
        feedDate: '20261111',
      });
      const long = createTrenesTools(ldFixtureContext(built.path, null)).find(
        (t) => t.name === 'trenes_tren',
      )!;
      const out = await long.handler({ tren: '7777' });
      const stops = out.split('\n').filter((l) => l.startsWith('· '));
      expect(out).toContain('Recorrido (30 paradas):');
      expect(stops).toHaveLength(25); // 12 + «… 6 paradas más …» + 12
      expect(stops[0]).toContain('Parada 1 ');
      expect(stops[11]).toContain('Parada 12 ');
      expect(stops[12]).toBe('· … 6 paradas más …');
      expect(stops[13]).toContain('Parada 19 ');
      expect(stops[24]).toContain('Parada 30 ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Cercanías y larga distancia son independientes', () => {
  it('el índice de larga distancia no existe: solo sus tools fallan, con su mensaje', async () => {
    const ctx = ldFixtureContext(indexPath, null);
    const failing = createTrenesTools({
      ...ctx,
      withIndex: () =>
        Promise.reject(new ToolUserError('Estoy preparando los horarios de larga distancia')),
    });
    await expect(failing[0]!.handler({ estacion: 'Atocha' })).rejects.toThrow(/larga distancia/);
    // Las de Cercanías no comparten nada con ese contexto (otro índice, otro tiempo real).
    const { createRenfeTools } = await import('./tools.js');
    const { buildFixtureIndex, fixtureContext } = await import('./test-helpers.js');
    const dir = mkdtempSync(join(tmpdir(), 'renfe-ld-ind-'));
    try {
      const cercanias = createRenfeTools(fixtureContext(await buildFixtureIndex(dir), null));
      const nucleos = cercanias.find((x) => x.name === 'cercanias_nucleos')!;
      expect(await nucleos.handler({})).toContain('Comunidad de Madrid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

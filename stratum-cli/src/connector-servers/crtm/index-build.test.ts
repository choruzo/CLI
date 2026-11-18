import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../renfe/test-helpers.js';
import type { ModeId } from './feeds.js';
import { buildModeIndex, indexFile, tripIdShift } from './index-build.js';
import { ModeIndex } from './queries.js';
import { buildFixtureIndex, FIXTURE_MODIFIED } from './test-helpers.js';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-crtm-build-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function open(mode: ModeId, dir: string): Promise<ModeIndex> {
  const ix = await ModeIndex.open(join(dir, indexFile(mode)));
  if (!ix) throw new Error('no abre');
  return ix;
}

describe('índice de Metro (fixtures reales recortadas)', () => {
  let ix: ModeIndex;
  beforeAll(async () => {
    const dir = join(tmp, 'metro');
    await buildFixtureIndex('metro', dir);
    ix = await open('metro', dir);
  });
  afterAll(() => ix.close());

  it('agrupa los andenes por parent_station y toma el nombre de la estación padre', () => {
    const sol = ix.station('est_90_58');
    expect(sol?.name).toBe('Puerta del Sol');
    const platforms = (
      ix.db
        .prepare("SELECT stop_id FROM stops WHERE station_id = 'est_90_58' ORDER BY 1")
        .all() as Array<{
        stop_id: string;
      }>
    ).map((r) => r.stop_id);
    // Sol tiene un andén en la línea 1 y otro en la 2: una sola estación.
    expect(platforms).toEqual(expect.arrayContaining(['par_4_12', 'par_4_35']));
    expect(ix.stations().filter((s) => s.name === 'Puerta del Sol')).toHaveLength(1);
  });

  it('los andenes sin parent_station declarado se agrupan por la convención par_ → est_', () => {
    expect(ix.station('est_4_10')?.name).toBe('Tribunal');
    const row = ix.db.prepare("SELECT station_id FROM stops WHERE stop_id = 'par_4_10'").get() as {
      station_id: string;
    };
    expect(row.station_id).toBe('est_4_10');
  });

  it('ignora los accesos y deja los nombres sin MAYÚSCULAS', () => {
    const ids = (
      ix.db.prepare('SELECT stop_id FROM stops').all() as Array<{ stop_id: string }>
    ).map((r) => r.stop_id);
    expect(ids.some((s) => s.startsWith('acc_'))).toBe(false);
    expect(
      ix.stations().some((s) => s.name === s.name.toUpperCase() && /[A-Z]{3}/.test(s.name)),
    ).toBe(false);
    expect(ix.station('est_4_6')?.name).toBe('Cuatro Caminos');
  });

  it('guarda el modified de ArcGIS y el rango del calendario (caducado, tal cual)', () => {
    expect(ix.meta.feedModified).toBe(FIXTURE_MODIFIED.metro);
    expect(ix.meta.lastDate).toBe('20260527');
    expect(ix.covers('20261117')).toBe(false);
    expect(ix.covers('20260101')).toBe(true);
  });

  it('las plantillas de Metro traen sus ventanas de frecuencia y varias por viaje', () => {
    const n = ix.db.prepare('SELECT COUNT(*) AS n FROM windows').get() as { n: number };
    const f = ix.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE freq = 1').get() as {
      n: number;
    };
    expect(f.n).toBe(16);
    expect(n.n).toBeGreaterThan(f.n);
  });
});

describe('índice de Metro Ligero', () => {
  it('salidas de hora exacta, estaciones por la convención y rango vigente', async () => {
    const dir = join(tmp, 'ml');
    await buildFixtureIndex('ml', dir);
    const ix = await open('ml', dir);
    try {
      expect(ix.station('est_10_9')?.name).toBe('Las Tablas');
      expect(ix.meta.firstDate).toBe('20261028');
      expect(ix.meta.lastDate).toBe('20271028');
      const f = ix.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE freq = 1').get() as {
        n: number;
      };
      expect(f.n).toBe(0);
      expect(ix.covers('20261117')).toBe(true);
      expect(ix.activeServices('20261117')).toEqual(['10_I14']);
      // Un domingo corre otro servicio; un festivo entre semana quita el de lunes-jueves y añade el de domingo.
      expect(ix.activeServices('20261115')).toEqual(['10_I13']);
      expect(ix.activeServices('20261207')).toEqual(['10_I13']);
      // El feed sale una hora antes que la etiqueta de su trip_id: manda la etiqueta.
      const rows = ix.db.prepare('SELECT trip_id, first_dep FROM trips').all() as {
        trip_id: string;
        first_dep: number;
      }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const label = /_(\d{2}):(\d{2}):(\d{2})_/.exec(r.trip_id)!;
        const secs = Number(label[1]) * 3600 + Number(label[2]) * 60 + Number(label[3]);
        expect(r.first_dep % 86_400, r.trip_id).toBe(secs);
      }
      expect(ix.db.prepare("SELECT value FROM meta WHERE key = 'trip_id_clock'").get()).toEqual({
        value: `${rows.length} corregidos, 0 sin etiqueta válida`,
      });
    } finally {
      ix.close();
    }
  });
});

describe('índice de los autobuses interurbanos y urbanos', () => {
  it('el interurbano agrupa los andenes del intercambiador de Moncloa y va por horas exactas', async () => {
    const dir = join(tmp, 'interurbano');
    await buildFixtureIndex('interurbano', dir);
    const ix = await open('interurbano', dir);
    try {
      expect(ix.meta.firstDate).toBe('20261028');
      expect(ix.meta.lastDate).toBe('20271127');
      expect(ix.covers('20261117')).toBe(true);
      // `par_8_06002` declara parent_station `est_90_14`: una sola estación para los andenes.
      expect(ix.station('est_90_14')?.name).toBe('Intercambiador de Moncloa');
      expect(
        ix.db.prepare("SELECT station_id FROM stops WHERE stop_id = 'par_8_06002'").get(),
      ).toEqual({ station_id: 'est_90_14' });
      // Ni un viaje por frecuencia: todo son horas exactas de `stop_times`.
      expect(ix.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE freq = 1').get()).toEqual({
        n: 0,
      });
      expect(ix.routes().map((r) => r.shortName)).toEqual(['625', '651']);
    } finally {
      ix.close();
    }
  });

  it('en el urbano el número se repite entre municipios y el id de GTFS los distingue', async () => {
    const dir = join(tmp, 'urbano');
    await buildFixtureIndex('urbano', dir);
    const ix = await open('urbano', dir);
    try {
      // Dos líneas «1»: la de Aranjuez y la de Ciempozuelos (una por municipio).
      const ones = ix.findRoutes('1');
      expect(ones).toHaveLength(2);
      expect(ones.map((r) => r.longName)).toEqual(
        expect.arrayContaining(['CIRCULAR DE CIEMPOZUELOS', 'L1 CIRCULAR (FFCC-Moreras-FFCC)']),
      );
      expect(ix.findRoutes('9__1__040_').map((r) => r.shortName)).toEqual(['1']);
      expect(ix.covers('20261117')).toBe(true);
      // El calendario del urbano acaba un día antes que el del interurbano.
      expect(ix.meta.lastDate).toBe('20271126');
    } finally {
      ix.close();
    }
  });
});

describe('tripIdShift', () => {
  it('etiqueta menos primera salida, en horas enteras de zona horaria', () => {
    expect(tripIdShift('10_I12-510_2023I12_06:05:00_1_1_10__51___', 5 * 3600 + 5 * 60)).toBe(3600);
    // Etiqueta 00:12 de un viaje que sale a las 23:12 del día de servicio: +1 h, no −23 h.
    expect(tripIdShift('x_00:12:00_y', 23 * 3600 + 12 * 60)).toBe(3600);
    // UTC en verano: dos horas.
    expect(tripIdShift('x_08:00:00_y', 6 * 3600)).toBe(7200);
    expect(tripIdShift('x_06:05:00_y', 6 * 3600 + 5 * 60)).toBe(0);
    // Sin etiqueta, o con una diferencia que no es de zona horaria: se deja la del feed.
    expect(tripIdShift('S110001C3', 3600)).toBeNull();
    expect(tripIdShift('x_06:05:00_y', 6 * 3600)).toBeNull();
    expect(tripIdShift('x_12:00:00_y', 6 * 3600)).toBeNull();
  });
});

describe('índice de la EMT', () => {
  it('cada parada es su propia estación y las líneas salen con su nombre corto', async () => {
    const dir = join(tmp, 'emt');
    await buildFixtureIndex('emt', dir);
    const ix = await open('emt', dir);
    try {
      expect(ix.station('3687')?.name).toBe('Moncloa');
      expect(ix.routes().map((r) => r.shortName)).toEqual(['1', '27']);
      expect(ix.findRoutes('27')).toHaveLength(1);
      expect(ix.routesAt('3687').map((r) => r.shortName)).toContain('1');
      const f = ix.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE freq = 0').get() as {
        n: number;
      };
      expect(f.n).toBe(0);
    } finally {
      ix.close();
    }
  });
});

describe('construcción', () => {
  const gtfs = (extra: Record<string, string> = {}) =>
    makeZip({
      'routes.txt': 'route_id,route_short_name,route_long_name\nR1,1,Uno - Dos\n',
      'stops.txt':
        'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,"ALFA, SUR",40,-3,0,\nB,BETA,40.1,-3.1,0,\n',
      'trips.txt':
        'route_id,service_id,trip_id,trip_headsign,direction_id\nR1,S,T1,BETA,0\nR1,S,T2,BETA,0\nR1,S,T3,BETA,0\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        'T1,7:00:00,7:00:00,A,1\nT1,7:10:00,7:10:00,B,2\n' +
        'T2,7:30:00,7:30:00,A,1\nT2,7:40:00,7:40:00,B,2\n' +
        'T3,8:00:00,8:00:00,A,1\nT3,8:12:00,8:12:00,B,2\n',
      'calendar.txt':
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20261101,20261231\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nS,20270105,1\nS,20261225,2\n',
      ...extra,
    });

  it('los viajes con el mismo recorrido y los mismos desfases comparten patrón', async () => {
    const dir = join(tmp, 'pat');
    const zip = join(dir, 'x.zip');
    mkdirSync(dir, { recursive: true });
    writeFileSync(zip, gtfs());
    const r = await buildModeIndex({ mode: 'emt', zipPath: zip, dir, feedModified: '1' });
    expect(r.trips).toBe(3);
    // T1 y T2 duran 10 min y T3 12: dos patrones.
    expect(r.patterns).toBe(2);
    const ix = await open('emt', dir);
    try {
      expect(ix.meta.lastDate).toBe('20270105'); // una fecha añadida (tipo 1) amplía el rango
      expect(ix.station('A')?.name).toBe('Alfa, Sur');
    } finally {
      ix.close();
    }
  });

  it('al enseñar una línea manda el recorrido que más viajes hace, no el más largo', async () => {
    // Los feeds de autobús traen viajes «9999» que concatenan el día entero de la
    // línea en uno solo (más de mil paradas). Ese no es el recorrido que se enseña.
    const dir = join(tmp, 'largo');
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, 'x.zip');
    const stops = Array.from({ length: 8 }, (_, i) => `S${i}`);
    const largo = stops.map((s, i) => `T9,${6 + i}:00:00,${6 + i}:00:00,${s},${i + 1}`).join('\n');
    writeFileSync(
      zip,
      makeZip({
        'routes.txt': 'route_id,route_short_name,route_long_name\nR1,1,Uno - Dos\n',
        'stops.txt':
          'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
          stops.map((s) => `${s},${s.toUpperCase()},40,-3,0,`).join('\n') +
          '\n',
        'trips.txt':
          'route_id,service_id,trip_id,trip_headsign,direction_id\n' +
          'R1,S,T1,DOS,0\nR1,S,T2,DOS,0\nR1,S,T3,DOS,0\nR1,S,T9,DOS,0\n',
        'stop_times.txt':
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
          'T1,7:00:00,7:00:00,S0,1\nT1,7:10:00,7:10:00,S1,2\n' +
          'T2,7:30:00,7:30:00,S0,1\nT2,7:40:00,7:40:00,S1,2\n' +
          'T3,8:00:00,8:00:00,S0,1\nT3,8:10:00,8:10:00,S1,2\n' +
          `${largo}\n`,
        'calendar.txt':
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20261101,20261231\n',
      }),
    );
    const r = await buildModeIndex({ mode: 'urbano', zipPath: zip, dir, feedModified: '1' });
    expect(r.trips).toBe(4);
    const ix = await open('urbano', dir);
    try {
      const dirs = ix.lineDirections('R1');
      expect(dirs).toHaveLength(1);
      expect(dirs[0]!.headsign).toBe('Dos');
      expect(dirs[0]!.stops.map((s) => s.stationId)).toEqual(['S0', 'S1']);
    } finally {
      ix.close();
    }
  });

  it('un stop_times partido por viaje se rechaza y no deja índice a medias', async () => {
    const dir = join(tmp, 'broken');
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, 'x.zip');
    writeFileSync(
      zip,
      gtfs({
        'stop_times.txt':
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,7:00:00,7:00:00,A,1\nT2,7:30:00,7:30:00,A,1\nT1,7:10:00,7:10:00,B,2\n',
      }),
    );
    await expect(
      buildModeIndex({ mode: 'emt', zipPath: zip, dir, feedModified: '1' }),
    ).rejects.toThrow(/no está agrupado por viaje/);
    expect(existsSync(join(dir, indexFile('emt')))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.db') || f.includes('tmp.db'))).toEqual([]);
  });
});

describe('temporales de otras construcciones', () => {
  it('solo borra los antiguos: el de otro proceso vivo (reciente) se respeta', async () => {
    const dir = join(tmp, 'stale');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'index-ml.11111.tmp.db');
    const recent = join(dir, 'index-ml.22222.tmp.db');
    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(old, threeHoursAgo, threeHoursAgo);
    await buildFixtureIndex('ml', dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(dir, indexFile('ml')))).toBe(true);
  });
});

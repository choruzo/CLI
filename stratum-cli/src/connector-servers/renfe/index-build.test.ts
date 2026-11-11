import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INDEX_FILE, buildIndex, tripShortNumber } from './index-build.js';
import { RenfeIndex, serviceDays } from './queries.js';
import { buildFixtureIndex, makeZip } from './test-helpers.js';

let tmp: string;
let indexPath: string;
const warnings: string[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-index-'));
  indexPath = await buildFixtureIndex(join(tmp, 'ok'), (m) => warnings.push(m));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function open(): Promise<RenfeIndex> {
  const ix = await RenfeIndex.open(indexPath);
  if (!ix) throw new Error('índice no abre');
  return ix;
}

describe('buildIndex', () => {
  it('guarda la fecha de los datos y no deja temporales', () => {
    expect(readdirSync(join(tmp, 'ok')).filter((f) => f.includes('.tmp.'))).toEqual([]);
    expect(existsSync(join(tmp, 'ok', INDEX_FILE))).toBe(true);
  });

  it('avisa del prefijo de núcleo desconocido y lo ignora', async () => {
    expect(warnings.some((w) => w.includes('«99»'))).toBe(true);
    const ix = await open();
    try {
      expect(ix.nucleos().map((n) => n.id)).toEqual(['madrid', 'sevilla']);
      expect(ix.line('madrid/C3')).toBeDefined();
      expect([...ix.db.prepare("SELECT 1 FROM lines WHERE id LIKE '99%'").all()]).toHaveLength(0);
    } finally {
      ix.close();
    }
  });

  it('agrupa los dos sentidos en una línea por núcleo + nombre corto', async () => {
    const ix = await open();
    try {
      const routes = ix.db
        .prepare("SELECT route_id FROM line_routes WHERE line_id = 'madrid/C3' ORDER BY route_id")
        .all() as Array<{ route_id: string }>;
      expect(routes.map((r) => r.route_id)).toEqual(['10T0007C3', '10T0008C3']);
      // «C1» existe en Madrid y en Sevilla: ids distintos.
      expect(ix.line('madrid/C1')).toBeDefined();
      expect(ix.line('sevilla/C1')).toBeDefined();
    } finally {
      ix.close();
    }
  });

  it('ordena las estaciones por el recorrido más largo (no por el viaje corto)', async () => {
    const ix = await open();
    try {
      expect(ix.lineStops('madrid/C3').map((s) => s.name)).toEqual([
        'Aranjuez',
        'Madrid-Atocha Cercanías',
        'Sol',
        'Madrid-Nuevos Ministerios',
        'Madrid-Chamartín-Clara Campoamor',
      ]);
      expect(ix.line('madrid/C3')?.nStops).toBe(5);
    } finally {
      ix.close();
    }
  });

  it('guarda las horas pasadas las 24:00 como segundos del día de servicio', async () => {
    const ix = await open();
    try {
      const r = ix.db
        .prepare(
          "SELECT MAX(dep) AS m FROM stop_times WHERE tid = (SELECT tid FROM trips WHERE trip_id = 'S110058C3')",
        )
        .get() as { m: number };
      expect(r.m).toBe(24 * 3600 + 28 * 60);
    } finally {
      ix.close();
    }
  });

  it('calcula el servicio de un día: calendar más calendar_dates', async () => {
    const ix = await open();
    try {
      expect(ix.activeServices('20261111').sort()).toEqual(['S1', 'S2']);
      expect(ix.activeServices('20261112')).toEqual(['S2']); // S1 retirado
      expect(ix.activeServices('20261113').sort()).toEqual(['S1', 'S2', 'S3']); // S3 añadido
      expect(ix.activeServices('20261201')).toEqual([]);
    } finally {
      ix.close();
    }
  });

  it('un viaje del día anterior con horas > 24:00 sigue corriendo pasada la medianoche', async () => {
    const ix = await open();
    try {
      // Hoy 00:15 (11/11): el tren del 10/11 que salió a las 23:50 está en Sol a las 24:15 = 00:15 de hoy.
      const days = serviceDays('20261111');
      const rows = ix.departures(['18101'], days, 0, 1800);
      const night = rows.find((r) => r.tripId === 'S110058C3');
      expect(night).toBeDefined();
      expect(night!.dep).toBe(15 * 60);
      expect(night!.day.ymd).toBe('20261110');
    } finally {
      ix.close();
    }
  });

  it('el número corto del tren sale del trip_id', () => {
    expect(tripShortNumber('3014X35833C5', '3014X')).toBe('35833');
    expect(tripShortNumber('S110001C3', 'S1')).toBe('10001');
    expect(tripShortNumber('XYZ', 'Q')).toBeNull();
  });

  it('un fallo de construcción deja el índice anterior intacto y sin temporales', async () => {
    const dir = join(tmp, 'atomic');
    const good = await buildFixtureIndex(dir);
    const before = (await RenfeIndex.open(good))!;
    const builtAt = before.meta.builtAt;
    before.close();
    // Zip sin stop_times.txt: la construcción falla a mitad.
    const badZip = join(dir, 'bad.zip');
    writeFileSync(
      badZip,
      makeZip({
        'routes.txt': 'route_id,route_short_name,route_long_name\n10T0001C1,C1,x\n',
        'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1,A,1,1\n',
        'trips.txt': 'route_id,service_id,trip_id\n10T0001C1,S,T1\n',
      }),
    );
    await expect(
      buildIndex({
        zipPath: badZip,
        dir,
        sourceUrl: 'x',
        now: () => new Date('2030-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/stop_times/);
    const after = (await RenfeIndex.open(good))!;
    expect(after.meta.builtAt).toBe(builtAt);
    expect(after.line('madrid/C3')).toBeDefined();
    after.close();
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

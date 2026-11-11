import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LD_INDEX_FILE, buildLdIndex, trainNumber } from './index-ld-build.js';
import { LdIndex } from './queries-ld.js';
import { buildLdFixtureIndex, makeZip } from './test-helpers.js';

let tmp: string;
let indexPath: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-ld-build-'));
  indexPath = await buildLdFixtureIndex(tmp);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Servicio del tren 190 (Madrid-Chamartín → Badajoz), bloque de vigencia 11/11–07/12.
// En el feed real `calendar_dates` solo quita días (tipo 2: 14, 15, 21 y 22 de nov.);
// la fixture añade a mano un día de tipo 1 (08/12, fuera de ese bloque).
const SERVICE_190 = '2026-11-112026-12-07001901';

describe('trainNumber', () => {
  it('quita los ceros a la izquierda del trip_short_name', () => {
    expect(trainNumber('00190', '0019012026-11-11')).toBe('190');
    expect(trainNumber('03123', '0312312026-11-11')).toBe('3123');
    expect(trainNumber('00000', 'x')).toBe('0');
  });

  it('sin trip_short_name numérico usa los cinco primeros dígitos del trip_id', () => {
    expect(trainNumber('', '0019012026-11-11')).toBe('190');
    expect(trainNumber('AVE', 'sin-numero')).toBeNull();
  });
});

describe('buildLdIndex (fixture recortada del GTFS real)', () => {
  it('construye el índice con sus tablas, los campos recortados y el rango de fechas', async () => {
    const ix = await LdIndex.open(indexPath);
    expect(ix).not.toBeNull();
    try {
      expect(ix!.meta.feedDate).toBe('20261111');
      expect(ix!.meta.firstDate).toBe('20261110');
      expect(ix!.meta.lastDate).toBe('20261212');
      expect(ix!.products()).toEqual(['ALVIA', 'AVE', 'AVLO']);
      const count = (table: string) =>
        (ix!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('trips')).toBe(45);
      expect(count('stop_times')).toBe(239);
      // El feed rellena con espacios: nada queda con relleno.
      expect(ix!.stopName('17000')).toBe('Madrid-Chamartín-Clara Campoamor');
      // El número de tren sale sin ceros y el trip_id (con la fecha de vigencia) no se toca.
      const t = ix!.trip('0019012026-11-11');
      expect(t?.number).toBe('190');
      expect(t?.product).toBe('ALVIA');
      expect(t?.firstStop).toBe('17000');
      expect(t?.lastStop).toBe('37606');
      expect(ix!.tripStops(t!.tid)).toHaveLength(12);
    } finally {
      ix?.close();
    }
  });

  it('el calendario aplica calendar_dates: quita un día (tipo 2) y añade otro (tipo 1)', async () => {
    const ix = (await LdIndex.open(indexPath))!;
    try {
      expect(ix.activeServices('20261112')).toContain(SERVICE_190);
      // Quitado por calendar_dates aunque el calendario lo incluya.
      expect(ix.activeServices('20261114')).not.toContain(SERVICE_190);
      expect(ix.activeServices('20261115')).not.toContain(SERVICE_190);
      // Añadido por calendar_dates aunque el calendario acabe el 07/12.
      expect(ix.activeServices('20261208')).toContain(SERVICE_190);
      // Y un día sin nada de eso, no.
      expect(ix.activeServices('20261213')).not.toContain(SERVICE_190);
    } finally {
      ix.close();
    }
  });

  it('un fallo al construir deja el índice anterior intacto y sin temporales', async () => {
    const before = readdirSync(tmp).sort();
    const bad = join(tmp, 'bad.zip');
    writeFileSync(bad, makeZip({ 'routes.txt': 'route_id,route_short_name\nR1,AVE\n' }));
    await expect(buildLdIndex({ zipPath: bad, dir: tmp, sourceUrl: 'test://bad' })).rejects.toThrow(
      /stops\.txt/,
    );
    const after = readdirSync(tmp)
      .filter((f) => f !== 'bad.zip')
      .sort();
    expect(after).toEqual(before.filter((f) => f !== 'bad.zip'));
    expect(after.some((f) => f.endsWith('.tmp.db'))).toBe(false);
    expect(existsSync(join(tmp, LD_INDEX_FILE))).toBe(true);
    const ix = await LdIndex.open(join(tmp, LD_INDEX_FILE));
    expect(ix?.meta.feedDate).toBe('20261111');
    ix?.close();
  });

  it('open devuelve null si no hay índice', async () => {
    expect(await LdIndex.open(join(tmp, 'no-existe.db'))).toBeNull();
  });
});

describe('LdIndex: resolución de estaciones', () => {
  it('un nombre ambiguo devuelve todos los candidatos y no adivina; el id estable resuelve', async () => {
    const ix = (await LdIndex.open(indexPath))!;
    try {
      const r = ix.resolveStation('Madrid');
      expect(r.kind).toBe('many');
      if (r.kind === 'many') {
        expect(r.values.map((s) => s.stopId).sort()).toEqual(['17000', '18000', '60000']);
      }
      expect(ix.resolveStation('madrid puerta de atocha')).toMatchObject({
        kind: 'one',
        value: { stopId: '60000' },
      });
      expect(ix.resolveStation('LD:17000')).toMatchObject({ kind: 'one' });
      expect(ix.resolveStation('ld:99999')).toEqual({ kind: 'none' });
      expect(ix.resolveStation('Narnia')).toEqual({ kind: 'none' });
    } finally {
      ix.close();
    }
  });
});

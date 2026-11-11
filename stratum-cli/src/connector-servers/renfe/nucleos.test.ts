import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NUCLEOS, nucleoById, nucleoOfRoute } from './nucleos.js';
import { csvRows } from './csv.js';
import { FIXTURES } from './test-helpers.js';

describe('núcleos', () => {
  it('el prefijo de dos dígitos del route_id da el núcleo (con relleno)', () => {
    expect(nucleoOfRoute('10T0001C1  ')?.id).toBe('madrid');
    expect(nucleoOfRoute('51T0010R2')?.id).toBe('rodalies');
    expect(nucleoOfRoute('99T0001X')).toBeUndefined();
  });

  it('15 núcleos con slug y prefijo únicos y su comunidad', () => {
    expect(NUCLEOS).toHaveLength(15);
    expect(new Set(NUCLEOS.map((n) => n.id)).size).toBe(15);
    expect(new Set(NUCLEOS.map((n) => n.prefix)).size).toBe(15);
    expect(nucleoById('murcia-alicante')?.comunidad).toBe(
      'Región de Murcia y Comunitat Valenciana',
    );
  });

  it('el routes.txt real completo no trae ningún prefijo fuera de la tabla', async () => {
    const text = readFileSync(join(FIXTURES, 'routes.full.txt'));
    const unknown = new Set<string>();
    let n = 0;
    for await (const r of csvRows(Readable.from([text]))) {
      n++;
      if (!nucleoOfRoute(r.route_id!)) unknown.add(r.route_id!.slice(0, 2));
    }
    expect(n).toBeGreaterThan(250);
    expect([...unknown]).toEqual([]);
  });
});

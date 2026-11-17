/**
 * Tests de `municipios.ts` sobre la tabla real (`municipios.json`): búsqueda
 * exacta, por código, por alias, por la forma visible, por prefijo con orden
 * por población, por similitud — y el formato medido del código de zona
 * Meteoalerta.
 */
import { describe, expect, it } from 'vitest';
import municipiosJson from './municipios.json' with { type: 'json' };
import {
  buscarMunicipios,
  municipioPorCodigo,
  zonasPorProvincia,
  TOTAL_MUNICIPIOS,
} from './municipios.js';

describe('buscarMunicipios (tabla real)', () => {
  it('coincidencia exacta por nombre normalizado', () => {
    const r = buscarMunicipios('Getafe');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      code: '28065',
      name: 'Getafe',
      zona: '722802',
      provincia: 'Madrid',
      nivel: 0,
    });
    expect(r[0]!.hab).toBe(173057);
  });

  it('acepta el código INE de 5 dígitos', () => {
    const r = buscarMunicipios('28065');
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('Getafe');
    expect(buscarMunicipios('99999')).toEqual([]);
  });

  it('resuelve los aliases de municipios desaparecidos', () => {
    for (const nombre of ['cerdedo', 'cotobade']) {
      const r = buscarMunicipios(nombre);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ code: '36902', name: 'Cerdedo-Cotobade', nivel: 0 });
    }
  });

  it('encuentra por la forma visible y por el nombre INE', () => {
    expect(buscarMunicipios('la acebeda').map((m) => m.code)).toEqual(['28001']);
    expect(buscarMunicipios('acebeda, la')[0]!.code).toBe('28001');
    expect(buscarMunicipios('palmar de troya, el')[0]!.code).toBe('41904');
    expect(buscarMunicipios('zarza-perrunal, la')[0]!.code).toBe('21902');
  });

  it('por prefijo, sin adivinar: devuelve todos los candidatos', () => {
    const r = buscarMunicipios('aceb');
    expect(r.length).toBeGreaterThan(1);
    expect(r.map((m) => m.name)).toContain('Acebeda, La');
  });

  it('en empate, primero los más poblados y los null al final', () => {
    const r = buscarMunicipios('villa');
    expect(r.length).toBeGreaterThan(3);
    for (let i = 1; i < r.length; i++) {
      const anterior = r[i - 1]!.hab ?? -1;
      const actual = r[i]!.hab ?? -1;
      expect(anterior).toBeGreaterThanOrEqual(actual);
    }
    // Los overrides no tienen habitantes propios: null, y van al final.
    const fuent = buscarMunicipios('fuente');
    expect(fuent[fuent.length - 1]!.hab).toBe(null);
    expect(buscarMunicipios('fuente carreteros')[0]).toMatchObject({
      code: '14901',
      hab: null,
      provincia: 'Córdoba',
    });
  });

  it('por similitud con erratas', () => {
    const r = buscarMunicipios('getttafe');
    expect(r[0]).toMatchObject({ code: '28065', nivel: 2 });
  });

  it('sin resultado, lista vacía (y no explota con la cadena vacía)', () => {
    expect(buscarMunicipios('qqqqq')).toEqual([]);
    expect(buscarMunicipios('   ')).toEqual([]);
  });

  it('el total coincide con la tabla generada', () => {
    expect(TOTAL_MUNICIPIOS).toBe(8132);
    expect(municipioPorCodigo('28065')?.name).toBe('Getafe');
    expect(municipioPorCodigo('aaaaa')).toBeUndefined();
  });
});

describe('formato medido del código de zona Meteoalerta (tabla real)', () => {
  it('la provincia está en zona[2:4] salvo Illes Balears (645…) y Canarias (659…)', () => {
    const excepciones = new Set(['07', '35', '38']);
    let visto07 = 0;
    let visto659 = 0;
    for (const m of municipiosTodas()) {
      const [code, , , zona] = m;
      const pro = code.slice(0, 2);
      if (excepciones.has(pro)) continue;
      expect(zona.slice(2, 4), `${code} zona ${zona}`).toBe(pro);
      if (pro === '51') expect(zona.startsWith('7851'), `${code} ${zona}`).toBe(true);
      if (pro === '52') expect(zona.startsWith('7952'), `${code} ${zona}`).toBe(true);
    }
    for (const [code, , , zona] of municipiosTodas()) {
      if (code.startsWith('07')) {
        expect(zona.startsWith('645'), `${code} zona ${zona}`).toBe(true);
        visto07++;
      }
      if (code.startsWith('35') || code.startsWith('38')) {
        expect(zona.startsWith('659'), `${code} zona ${zona}`).toBe(true);
        if (code.startsWith('38')) visto659++;
      }
    }
    expect(visto07).toBe(67); // Illes Balears: todas sus zonas comparten el prefijo 645
    expect(visto659).toBe(54); // Canarias comparte el prefijo 659 entre Las Palmas y Tenerife
  });

  it('el índice de zonas por provincia cubre las 52', () => {
    const idx = zonasPorProvincia();
    expect(idx.size).toBe(52);
    expect(idx.get('28')).toContain('722802');
    expect(idx.get('27')).toContain('712701'); // A Mariña (Lugo), la del CAP de la fixture
  });
});

/** Las filas de la tabla real como arrays crudos (para el test del formato). */
function municipiosTodas(): Array<[string, string, string, string]> {
  return municipiosJson.municipios as unknown as Array<[string, string, string, string]>;
}

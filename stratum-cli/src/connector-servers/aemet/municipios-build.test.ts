/**
 * Tests de `municipios-build.ts` con datos sintéticos mínimos: el cruce INE ↔
 * maestro, la forma visible de los nombres, un override con previsión, uno sin
 * ella, los alias de los fusionados y el fallo ante un código sin explicar.
 */
import { describe, expect, it } from 'vitest';
import { normalizeName } from '../renfe/normalize.js';
import { buildMunicipios, displayName, type Override } from './municipios-build.js';

const INE = [
  { code: '01001', name: 'Acebeda, La', province: '01' },
  { code: '01002', name: 'Pobra, A', province: '01' },
  { code: '18020', name: 'Arenas del Rey', province: '18' },
  { code: '18077', name: 'Fornes', province: '18' },
  { code: '36099', name: 'Cerdedo-Cotobade', province: '36' },
];

const MAESTRO = [
  {
    id: 'id01001',
    nombre: 'La Acebeda',
    zona_comarcal: '010101',
    latitud_dec: '40.30403754',
    longitud_dec: '-3.72935236',
    num_hab: '173057',
  },
  {
    id: 'id01002',
    nombre: 'A Pobra',
    zona_comarcal: '010102',
    latitud_dec: '43.0',
    longitud_dec: '-1.23456',
    num_hab: '50',
  },
  {
    id: 'id18020',
    nombre: 'Arenas del Rey',
    zona_comarcal: '611801',
    latitud_dec: '36.96789',
    longitud_dec: '-3.56789',
    num_hab: '6000',
  },
  {
    id: 'id36011',
    nombre: 'Cerdedo',
    zona_comarcal: '713602',
    latitud_dec: '42.53197',
    longitud_dec: '-8.39102',
    num_hab: '1860',
  },
  {
    id: 'id36012',
    nombre: 'Cotobade',
    zona_comarcal: '713602',
    latitud_dec: '42.47319',
    longitud_dec: '-8.48031',
    num_hab: '4327',
  },
];

const OVERRIDES: Override[] = [
  { code: '18077', origin: { name: 'Arenas del Rey', province: '18' }, forecast: false },
  { code: '36099', origin: { name: 'Cerdedo', province: '36' }, forecast: true },
];

// Cerdedo y Cotobade desaparecen en el INE (fusionados en Cerdedo-Cotobade).
const ALIAS_FROM = { '36011': '36099', '36012': '36099' };

const build = () => buildMunicipios(INE, MAESTRO, OVERRIDES, ALIAS_FROM, normalizeName);

describe('displayName', () => {
  it('mueve el artículo pospuesto al principio', () => {
    expect(displayName('Acebeda, La')).toBe('La Acebeda');
    expect(displayName("Hospitalet de Llobregat, L'")).toBe("L'Hospitalet de Llobregat");
    expect(displayName('Palmar de Troya, El')).toBe('El Palmar de Troya');
    expect(displayName('Zarza-Perrunal, La')).toBe('La Zarza-Perrunal');
    expect(displayName('Pobra, A')).toBe('A Pobra');
    expect(displayName('Pende, As')).toBe('As Pende');
  });

  it('deja el resto tal cual', () => {
    expect(displayName('Getafe')).toBe('Getafe');
    expect(displayName('Agurain/Salvatierra')).toBe('Agurain/Salvatierra');
    expect(displayName('Cima, Villa')).toBe('Cima, Villa'); // coma que no es artículo
    expect(displayName('  Acebeda, La ')).toBe('La Acebeda'); // recorta el borde
  });
});

describe('buildMunicipios', () => {
  it('cruza INE y maestro por código, con las filas ordenadas', () => {
    const { municipios, aliases } = build();
    expect(municipios).toEqual([
      ['01001', 'Acebeda, La', 'La Acebeda', '010101', 40.304, -3.7294, 173057],
      ['01002', 'Pobra, A', 'A Pobra', '010102', 43, -1.2346, 50],
      ['18020', 'Arenas del Rey', 'Arenas del Rey', '611801', 36.9679, -3.5679, 6000],
      [
        '18077',
        'Fornes',
        'Fornes',
        '611801',
        36.9679,
        -3.5679,
        null,
        { forecast: false, nearest: '18020', coordsFrom: '18020' },
      ],
      [
        '36099',
        'Cerdedo-Cotobade',
        'Cerdedo-Cotobade',
        '713602',
        42.532,
        -8.391,
        null,
        { forecast: true, from: '36011', coordsFrom: '36011' },
      ],
    ]);
    expect(aliases).toEqual({ cerdedo: '36099', cotobade: '36099' });
  });

  it('el nombre de la fila es el del INE, aunque el maestro lo escriba distinto', () => {
    const { municipios } = build();
    expect(municipios[0]![1]).toBe('Acebeda, La');
    expect(municipios[0]![2]).toBe('La Acebeda');
  });

  it('las filas que vienen del maestro no llevan flags', () => {
    const { municipios } = build();
    expect(municipios[0]).toHaveLength(7);
    expect(municipios[2]).toHaveLength(7);
  });

  it('override con previsión: zona y coordenadas del origen, sin habitantes propios', () => {
    const { municipios } = build();
    const [codigo, , , zona, lat, lon, hab, flags] = municipios[4]!;
    expect(codigo).toBe('36099');
    expect(zona).toBe('713602');
    expect(lat).toBe(42.532);
    expect(lon).toBe(-8.391);
    expect(hab).toBe(null);
    expect(flags).toEqual({ forecast: true, from: '36011', coordsFrom: '36011' });
  });

  it('override sin previsión: el origen queda como vecino más cercano', () => {
    const { municipios } = build();
    const [codigo, , , zona, , , hab, flags] = municipios[3]!;
    expect(codigo).toBe('18077');
    expect(zona).toBe('611801');
    expect(hab).toBe(null);
    expect(flags).toEqual({ forecast: false, nearest: '18020', coordsFrom: '18020' });
  });

  it('los alias se construyen con el normalizador inyectado', () => {
    const { aliases } = build();
    expect(Object.keys(aliases)).toEqual(['cerdedo', 'cotobade']);
    expect(normalizeName('Cotobade')).toBe('cotobade');
  });

  it('falla con la lista de los códigos sin explicar', () => {
    let mensaje = '';
    try {
      buildMunicipios(
        [...INE, { code: '99999', name: 'Fantasma', province: '99' }],
        [
          ...MAESTRO,
          {
            id: 'id36888',
            nombre: 'Viejo Pueblo',
            zona_comarcal: '360999',
            latitud_dec: '42.5',
            longitud_dec: '-8.4',
            num_hab: '10',
          },
        ],
        OVERRIDES,
        ALIAS_FROM,
        normalizeName,
      );
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain('99999');
    expect(mensaje).toContain('Fantasma');
    expect(mensaje).toContain('36888');
    expect(mensaje).toContain('Viejo Pueblo');
  });

  it('si el origen no está en la provincia indicada, muestra dónde aparece', () => {
    let mensaje = '';
    try {
      buildMunicipios(
        INE,
        MAESTRO,
        [{ code: '18077', origin: { name: 'Arenas del Rey', province: '29' }, forecast: false }],
        {},
        normalizeName,
      );
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain('provincia 29');
    expect(mensaje).toContain('18020');
    expect(mensaje).toContain('Arenas del Rey');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import type { ModeId } from './feeds.js';
import { buildAllFixtureIndexes, buildFixtureIndex, fixtureContext } from './test-helpers.js';
import { createCrtmTools } from './tools.js';

const CRTM = 'Origen de los datos: CRTM (Powered by CRTM, https://www.crtm.es)';
const EMT = 'Datos de EMT Madrid (Powered by EMT de Madrid)';

// Martes 2026-11-17, hora de Madrid (UTC+1): 17:35.
const TUE_1735 = '2026-11-17T16:35:00Z';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-crtm-tools-'));
  await buildAllFixtureIndexes(dir);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tools(nowIso = TUE_1735, only?: readonly ModeId[]): Record<string, ConnectorTool> {
  return Object.fromEntries(
    createCrtmTools(fixtureContext(dir, nowIso, only)).map((t) => [t.name, t]),
  );
}

async function call(
  name: string,
  args: object,
  nowIso = TUE_1735,
  only?: readonly ModeId[],
): Promise<string> {
  return tools(nowIso, only)[name]!.handler(args);
}

async function error(name: string, args: object, nowIso = TUE_1735): Promise<string> {
  try {
    await call(name, args, nowIso);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('debía fallar');
}

describe('transporte_salidas: Metro Ligero (horas exactas)', () => {
  it('da las próximas salidas con hora y minutos que faltan, según horario', async () => {
    const out = await call('transporte_salidas', { parada: 'Las Tablas', linea: 'ML1', max: 3 });
    expect(out).toContain(
      'Salidas desde Las Tablas (Metro Ligero, ml:est_10_9) a partir de las 17:35',
    );
    // Las Tablas es el final de la línea: solo salen trenes hacia Pinar de Chamartín.
    expect(out).toContain('- ML1 a Pinar de Chamartin · sale 18:00 (en 26 min) · según horario');
    expect(out).toContain('- ML1 a Pinar de Chamartin · sale 18:07 (en 32 min) · según horario');
    expect(out).toContain('(hay más salidas: pide max=');
  });

  it('no enseña salidas pasadas y respeta desde', async () => {
    const out = await call('transporte_salidas', { parada: 'ml:est_10_4', desde: '17:50', max: 2 });
    const times = [...out.matchAll(/sale (\d\d:\d\d)/g)].map((m) => m[1]!);
    expect(times).toHaveLength(2);
    expect(times.every((t) => t >= '17:50')).toBe(true);
  });

  it('solo trenes que luego paran en el destino', async () => {
    const out = await call('transporte_salidas', {
      parada: 'ml:est_10_4',
      destino: 'Las Tablas',
      max: 20,
    });
    expect(out).toContain('hacia Las Tablas');
    expect(out).not.toContain('a Pinar de Chamartin');
  });

  it('pasadas las 24:00 del día de servicio anterior aparecen como hoy', async () => {
    // Lunes 00:00:10 (Madrid): el último tren del domingo (día de servicio anterior) pasa por Antonio Saura a las 00:42.
    const out = await call(
      'transporte_salidas',
      { parada: 'ml:est_10_4', max: 2 },
      '2026-11-15T23:00:10Z',
    );
    expect(out).toContain('sale 00:42 (en 43 min)');
  });

  it('con pocos minutos por delante dice «en N min»; muy lejos, solo la hora; y mañana lo marca', async () => {
    const late = await call(
      'transporte_salidas',
      { parada: 'ml:est_10_4', max: 3 },
      '2026-11-17T22:50:00Z',
    );
    expect(late).toContain('sale mañana 00:46 · según horario');
    expect(late).toContain('sale mañana 18:05 · según horario');
    const far = await call(
      'transporte_salidas',
      { parada: 'ml:est_10_4', max: 1 },
      '2026-11-15T23:30:00Z',
    );
    expect(far).toContain('sale 00:42 (en 13 min)');
    // A las 02:00 el siguiente tren está a más de 3 h: solo la hora, sin «en N min».
    const night = await call(
      'transporte_salidas',
      { parada: 'ml:est_10_4', max: 1 },
      '2026-11-17T01:00:00Z',
    );
    expect(night).toMatch(/sale 1[78]:\d\d · según horario/);
    expect(night).not.toMatch(/\(en \d+ min\)/);
  });
});

describe('transporte_salidas: EMT (por frecuencia)', () => {
  it('dentro de una ventana dice cada cuánto pasa y hasta cuándo', async () => {
    const out = await call('transporte_salidas', { parada: 'emt:3687' });
    expect(out).toContain(
      '- EMT 1 hacia Prosperidad · cada 13 min (hasta las 19:03) · según horario',
    );
  });

  it('antes de la primera ventana dice la primera pasada y después la frecuencia', async () => {
    const out = await call('transporte_salidas', { parada: 'emt:3687' }, '2026-11-17T02:00:00Z');
    expect(out).toContain(
      '- EMT 1 hacia Prosperidad · primera pasada hacia las 06:02, después cada 18 min · según horario',
    );
  });

  it('una parada con dos sentidos de una línea los da por separado', async () => {
    const out = await call('transporte_salidas', { parada: 'emt:273' });
    expect(out).toMatch(/- EMT 1 hacia /);
  });

  it('el último tramo del día sigue siendo una ventana hasta que acaba', async () => {
    const out = await call('transporte_salidas', { parada: 'emt:3687', desde: '23:59' });
    // La ventana acaba pasadas las 24:00 del día de servicio: es de mañana, no «las 00:02» de hoy.
    expect(out).toContain('cada 20 min (hasta mañana a las 00:02)');
  });

  it('un día sin servicio de esa línea lo dice sin inventar horas', async () => {
    // Domingo 2026-11-22: la fixture solo trae el servicio de lunes a viernes.
    const out = await call('transporte_salidas', { parada: 'emt:3687' }, '2026-11-22T10:00:00Z');
    expect(out).toContain('No hay salidas en esta parada');
    expect(out).not.toMatch(/cada \d+ min/);
  });

  it('sin línea ni destino filtra y con linea desconocida orienta a transporte_lineas', async () => {
    expect(await error('transporte_salidas', { parada: 'emt:3687', linea: '999' })).toContain(
      'transporte_lineas',
    );
    const out = await call('transporte_salidas', { parada: 'emt:3687', destino: 'Prosperidad' });
    expect(out).toContain('hacia Prosperidad');
  });
});

describe('Metro con el calendario caducado', () => {
  it('dice que el horario no cubre hoy y no da horas ni frecuencias', async () => {
    const out = await call('transporte_salidas', { parada: 'Sol', modo: 'metro' });
    expect(out).toContain(
      'El horario de Metro publicado por el CRTM no cubre hoy (su calendario acaba el 27/05/2026). Sin horario vigente; las estaciones y líneas sí están.',
    );
    expect(out).not.toMatch(/\b\d{2}:\d{2}\b/);
    expect(out).not.toMatch(/cada \d/);
    expect(out).toContain('Puerta del Sol (Metro, metro:est_90_58)');
  });

  it('en un trayecto tampoco inventa nada; las estaciones y líneas sí se consultan', async () => {
    const out = await call('transporte_trayecto', {
      origen: 'metro:est_90_58',
      destino: 'Cuatro Caminos',
    });
    expect(out).toContain('no cubre hoy');
    expect(out).not.toMatch(/cada \d/);
    const lines = await call('transporte_lineas', { modo: 'metro' });
    expect(lines).toContain('- L1 · Pinar de Chamartín-Valdecarros');
    const stops = await call('transporte_paradas', { linea: 'L1' });
    expect(stops).toContain('Puerta del Sol · metro:est_90_58');
  });
});

describe('transporte_paradas', () => {
  it('busca sin acentos ni mayúsculas y da modo, líneas e id', async () => {
    const out = await call('transporte_paradas', { nombre: 'PLAZA DE CASTILLA' });
    expect(out).toContain('Intercambiador de Plaza de Castilla · Metro (L1) · metro:est_90_21');
    expect(out).toContain('Usa el id "modo:id"');
  });

  it('con varios candidatos los devuelve con su id y acotados', async () => {
    const out = await call('transporte_paradas', { nombre: 'pinar de chamartin' });
    expect(out).toContain('Encontradas 2 paradas o estaciones');
    expect(out).toContain('· metro:est_4_263');
    expect(out).toContain('· ml:est_10_1');
  });

  it('filtra por modo y por línea', async () => {
    const out = await call('transporte_paradas', { nombre: 'pinar', modo: 'ml' });
    expect(out).toContain('ml:est_10_1');
    expect(out).not.toContain('metro:');
    const byLine = await call('transporte_paradas', {
      nombre: 'castilla',
      linea: '27',
      modo: 'emt',
    });
    expect(byLine).toContain('emt:5602');
  });

  it('con linea y modo y sin nombre lista las paradas en orden con sus ids', async () => {
    const out = await call('transporte_paradas', { linea: 'ML1' });
    expect(out).toContain('Sentido Las Tablas (9 paradas):');
    expect(out).toContain('1. Pinar de Chamartin · ml:est_10_1');
    expect(out).toContain('9. Las Tablas · ml:est_10_9');
  });

  it('errores que orientan', async () => {
    expect(await error('transporte_paradas', {})).toContain('`nombre`');
    expect(await error('transporte_paradas', { nombre: 'zzzz' })).toContain('No encuentro');
    expect(await error('transporte_paradas', { nombre: 'sol', modo: 'tranvia' })).toContain(
      'modo debe ser',
    );
    // «1» existe en Metro (L1) y en la EMT (1): hay que decir el modo.
    expect(await error('transporte_paradas', { linea: '1' })).toContain('indicando modo');
  });
});

describe('transporte_lineas', () => {
  it('lista las líneas de un modo y las paradas de una línea en sus dos sentidos', async () => {
    const list = await call('transporte_lineas', { modo: 'emt' });
    expect(list).toContain('- 27 · Glorieta de Embajadores - Plaza de Castilla');
    const detail = await call('transporte_lineas', { modo: 'ml', linea: 'ML1' });
    expect(detail).toContain('Sentido Las Tablas (9 paradas):');
    expect(detail).toContain('Sentido Pinar de Chamartin (9 paradas):');
    expect(detail).toContain('Pinar de Chamartin → Fuente de la Mora');
  });

  it('exige el modo y dice cómo corregir una línea que no existe', async () => {
    expect(await error('transporte_lineas', {})).toContain('modo debe ser');
    expect(await error('transporte_lineas', { modo: 'ml', linea: 'ML9' })).toContain(
      'transporte_lineas',
    );
  });
});

describe('transporte_trayecto', () => {
  it('Metro Ligero: hora de salida y de llegada', async () => {
    const out = await call('transporte_trayecto', {
      origen: 'ml:est_10_1',
      destino: 'Las Tablas',
      max: 2,
    });
    expect(out).toContain('Trayectos directos de Pinar de Chamartin a Las Tablas');
    expect(out).toContain(
      '- ML1 hacia Las Tablas · sale 18:00 (en 26 min), llega 18:15 (15 min de viaje) · según horario',
    );
  });

  it('EMT: frecuencia y duración del viaje', async () => {
    const out = await call('transporte_trayecto', { origen: 'emt:86', destino: 'emt:82' });
    expect(out).toMatch(
      /- EMT 27 hacia Plaza Castilla · cada \d+ min \(hasta las \d\d:\d\d\), unos \d+ min de viaje · según horario/,
    );
  });

  it('sin directo lo dice y sugiere transporte_salidas', async () => {
    // Sentido contrario en la EMT: de Prado - Atocha a Embajadores no hay directo en esa línea.
    const out = await call('transporte_trayecto', { origen: 'emt:82', destino: 'emt:86' });
    expect(out).toContain('No hay trayecto directo');
    expect(out).toContain('transporte_salidas');
  });

  it('modos distintos, mismo origen y destino, y ambigüedad', async () => {
    const mixed = await call('transporte_trayecto', {
      origen: 'ml:est_10_1',
      destino: 'metro:est_90_58',
    });
    expect(mixed).toContain('Metro Ligero');
    expect(
      await error('transporte_trayecto', { origen: 'ml:est_10_1', destino: 'ml:est_10_1' }),
    ).toContain('la misma parada');
    const amb = await call('transporte_trayecto', {
      origen: 'pinar de chamartin',
      destino: 'Las Tablas',
    });
    expect(amb).toContain('coincide con 2 paradas');
    expect(amb).toContain('origen: "metro:est_4_263"');
  });
});

describe('autobuses urbanos de los municipios y interurbanos', () => {
  it('el interurbano da horas exactas con la línea y su destino', async () => {
    const out = await call('transporte_salidas', {
      parada: 'interurbano:par_8_15211',
      desde: '06:45',
      max: 2,
    });
    expect(out).toContain(
      'Salidas desde Aristóteles-Av.atenas (Autobús interurbano, interurbano:par_8_15211) a partir de las 06:45:',
    );
    expect(out).toContain('- 625 a Intercambiador Moncloa · sale 06:51 (en 7 min) · según horario');
    expect(out).toContain(
      '- 625 a Intercambiador Moncloa · sale 07:07 (en 23 min) · según horario',
    );
    expect(out).not.toMatch(/cada \d+ min/);
  });

  it('el interurbano también da trayectos con hora de llegada', async () => {
    const out = await call('transporte_trayecto', {
      origen: 'interurbano:par_8_15211',
      destino: 'interurbano:est_90_14',
      desde: '06:45',
      max: 1,
    });
    expect(out).toContain(
      'Trayectos directos de Aristóteles-Av.atenas a Intercambiador de Moncloa',
    );
    expect(out).toContain(
      '- 625 hacia Intercambiador Moncloa · sale 06:51 (en 7 min), llega 07:30 (39 min de viaje) · según horario',
    );
  });

  it('el urbano de otro municipio da horas exactas y dice de qué red es', async () => {
    const out = await call('transporte_salidas', {
      parada: 'urbano:par_8_09568',
      desde: '00:00',
      max: 2,
    });
    expect(out).toContain('(Autobús urbano, urbano:par_8_09568)');
    expect(out).toContain('- 1 a Estudios Cinematográficos-Mediodía · sale 00:15 (en 15 min)');
  });

  it('las líneas del urbano llevan el id cuando el número se repite entre municipios', async () => {
    const out = await call('transporte_lineas', { modo: 'urbano' });
    expect(out).toContain('Líneas de Autobús urbano (2):');
    // El nombre largo es lo único que dice el municipio, y el id desempata.
    expect(out).toContain('- 1 · CIRCULAR DE CIEMPOZUELOS · urbano:9__1__040_');
    expect(out).toContain('- 1 · L1 CIRCULAR (FFCC-Moreras-FFCC) · urbano:9__1__013_');
    expect(out).toContain('donde el número se repite');
  });

  it('con el id de la línea se resuelve el número repetido', async () => {
    const out = await call('transporte_paradas', { linea: 'urbano:9__1__040_', modo: 'urbano' });
    expect(out).toContain('Línea 1 de Autobús urbano: CIRCULAR DE CIEMPOZUELOS.');
    const detail = await call('transporte_lineas', { modo: 'urbano', linea: '9__1__040_' });
    expect(detail).toContain('Sentido Urbanización Parque Olimpia-Av.belén (14 paradas):');
    // El id también filtra por línea al buscar paradas por nombre.
    const named = await call('transporte_paradas', {
      nombre: 'av.san juan de dios-est.ciempozuelos',
      linea: 'urbano:9__1__040_',
      modo: 'urbano',
    });
    expect(named).toContain('urbano:par_8_15830');
  });

  it('una línea interurbana sin `modo` se resuelve sola: el número no está en otras redes', async () => {
    const out = await call('transporte_lineas', { modo: 'interurbano', linea: '625' });
    expect(out).toContain('Línea 625 de Autobús interurbano: MADRID (Moncloa)-MONTE ROZAS.');
    expect(out).toMatch(/Sentido Intercambiador Moncloa \(\d+ paradas\):/);
  });

  it('avisa de que el calendario no cubre hoy sin inventar horas', async () => {
    // Los fixtures del urbano y del interurbano acaban en noviembre de 2027.
    const out = await call(
      'transporte_salidas',
      { parada: 'interurbano:par_8_15211' },
      '2027-12-01T10:00:00Z',
    );
    expect(out).toContain(
      'El horario de Autobús interurbano publicado por el CRTM no cubre hoy (su calendario acaba el 27/11/2027)',
    );
    expect(out).not.toMatch(/\b\d{2}:\d{2}\b/);
  });
});

describe('la misma línea en varias redes', () => {
  it('sin `modo` devuelve los candidatos por red con su id, sin elegir', async () => {
    const msg = await error('transporte_paradas', { linea: '1' });
    expect(msg).toContain('La línea «1» no es una sola: hay 4 líneas con ese número');
    expect(msg).toContain('indicando modo');
    // Metro, EMT y los dos municipios que numeran su línea como «1».
    expect(msg).toContain('- L1 · Metro · ');
    expect(msg).toContain('· metro:');
    expect(msg).toContain('- 1 · EMT · ');
    expect(msg).toContain('· emt:001');
    expect(msg).toContain('- 1 · Autobús urbano · CIRCULAR DE CIEMPOZUELOS · urbano:9__1__040_');
    expect(msg).toContain(CRTM);
  });

  it('con `modo` sigue avisando si dentro de la red el número también se repite', async () => {
    const msg = await error('transporte_lineas', { modo: 'urbano', linea: '1' });
    expect(msg).toContain('La línea «1» no es una sola: hay 2 líneas con ese número');
    expect(msg).toContain('urbano:9__1__013_');
    expect(msg).toContain('urbano:9__1__040_');
  });

  it('transporte_lineas acepta `linea` sin `modo` para ver las redes que la tienen', async () => {
    const msg = await error('transporte_lineas', { linea: '1' });
    expect(msg).toContain('La línea «1» no es una sola');
    expect(msg).toContain('· Metro · ');
    expect(msg).toContain('· EMT · ');
    expect(msg).toContain('· Autobús urbano · ');
    // Sin `modo` ni `linea` sigue pidiendo el modo.
    expect(await error('transporte_lineas', {})).toContain('modo debe ser');
  });

  it('el modo que no tiene esa línea da un error que orienta', async () => {
    expect(await error('transporte_lineas', { modo: 'interurbano', linea: '1' })).toContain(
      'No encuentro la línea «1»',
    );
  });

  it('una parada del mismo nombre en varias redes se devuelve con su id', async () => {
    const out = await call('transporte_paradas', { nombre: 'moncloa' });
    expect(out).toContain('- Moncloa · EMT (1) · emt:3687');
    expect(out).toContain('· Autobús interurbano (625, 651) · interurbano:est_90_14');
  });
});

describe('candidatos ambiguos', () => {
  it('transporte_salidas no adivina: devuelve las candidatas con id y cómo repetir', async () => {
    const out = await call('transporte_salidas', { parada: 'Pinar de Chamartin' });
    expect(out).toContain('coincide con 2 paradas o estaciones');
    expect(out).toContain('parada: "metro:est_4_263"');
    expect(out).toContain('- Pinar de Chamartin · Metro Ligero (ML1) · ml:est_10_1');
  });

  it('la línea o el modo la resuelven', async () => {
    expect(
      await call('transporte_salidas', { parada: 'Pinar de Chamartin', linea: 'ML1', max: 1 }),
    ).toContain('(Metro Ligero, ml:est_10_1)');
    expect(
      await call('transporte_salidas', { parada: 'Pinar de Chamartin', modo: 'metro' }),
    ).toContain('metro:est_4_263');
  });

  it('un id que no existe orienta a transporte_paradas', async () => {
    const out = await call('transporte_salidas', { parada: 'ml:nope' });
    expect(out).toContain('transporte_paradas');
  });
});

describe('atribución y límites en toda salida', () => {
  const cases: Array<[string, object, ModeId[]]> = [
    ['transporte_paradas', { nombre: 'moncloa' }, ['emt']],
    ['transporte_paradas', { linea: 'ML1' }, ['ml']],
    ['transporte_lineas', { modo: 'metro' }, ['metro']],
    ['transporte_lineas', { modo: 'emt', linea: '27' }, ['emt']],
    ['transporte_salidas', { parada: 'ml:est_10_9' }, ['ml']],
    ['transporte_salidas', { parada: 'emt:3687' }, ['emt']],
    ['transporte_salidas', { parada: 'emt:3687' }, ['emt']],
    ['transporte_salidas', { parada: 'metro:est_90_58' }, ['metro']],
    ['transporte_salidas', { parada: 'Pinar de Chamartin' }, ['metro', 'ml']],
    ['transporte_trayecto', { origen: 'ml:est_10_1', destino: 'ml:est_10_9' }, ['ml']],
    ['transporte_trayecto', { origen: 'emt:86', destino: 'emt:82' }, ['emt']],
    ['transporte_trayecto', { origen: 'metro:est_90_58', destino: 'metro:est_4_6' }, ['metro']],
    ['transporte_trayecto', { origen: 'ml:est_10_1', destino: 'metro:est_90_58' }, ['ml']],
  ];

  it.each(cases)(
    '%s %j acaba con la atribución del CRTM (y la EMT si entra)',
    async (name, args) => {
      const out = await call(name, args);
      const last = out.split('\n').slice(-2);
      expect(out).toContain(CRTM);
      expect(out).toMatch(/horarios publicados el \d\d\/\d\d\/\d{4}/);
      if (out.includes('EMT')) {
        // Si la salida habla de la EMT, su atribución cierra la salida.
        expect(last[1]).toBe(EMT);
      } else {
        expect(out.split('\n').at(-1)!.startsWith(CRTM)).toBe(true);
      }
      expect(out).not.toMatch(/tiempo real/i);
    },
  );

  it('con modos de distinta fecha de publicación las da por modo', async () => {
    const out = await call('transporte_paradas', { nombre: 'pinar de chamartin' });
    expect(out).toContain('27/05/2025 (Metro), 28/10/2026 (Metro Ligero)');
  });

  it('nunca dice «tiempo real» ni que el CRTM o la EMT respalden el uso', async () => {
    for (const [name, args] of cases) {
      const out = await call(name, args);
      expect(out).not.toMatch(/respald|oficial/i);
    }
  });
});

describe('índices que faltan', () => {
  it('un modo sin índice dice que está preparando los horarios', async () => {
    const ctxTools = createCrtmTools(fixtureContext(dir, TUE_1735, ['ml']));
    const lineas = ctxTools.find((t) => t.name === 'transporte_lineas')!;
    await expect(lineas.handler({ modo: 'emt' })).rejects.toThrow(
      /Estoy preparando los horarios de emt/,
    );
  });

  it('en una búsqueda general sigue con los modos que hay y avisa de los que faltan', async () => {
    const out = await call('transporte_paradas', { nombre: 'las tablas' }, TUE_1735, ['ml']);
    expect(out).toContain('ml:est_10_9');
    expect(out).toContain(
      'Nota: los horarios de Metro, EMT, Autobús urbano, Autobús interurbano aún no están listos',
    );
  });

  it('sin ningún índice lo dice', async () => {
    const t = createCrtmTools(fixtureContext(dir, TUE_1735, []));
    await expect(
      t.find((x) => x.name === 'transporte_paradas')!.handler({ nombre: 'sol' }),
    ).rejects.toThrow(/preparando los horarios/);
  });
});

describe('argumentos', () => {
  it('rechazan valores inválidos con un mensaje claro', async () => {
    expect(await error('transporte_salidas', { parada: 'x', desde: '25h' })).toContain(
      'desde debe ser',
    );
    expect(await error('transporte_salidas', { parada: 'x', max: 99 })).toContain('max debe ser');
    expect(await error('transporte_salidas', {})).toContain('parada debe ser');
  });

  it('modo acepta alias y mayúsculas', async () => {
    const out = await call('transporte_lineas', { modo: ' Metro Ligero ' });
    expect(out).toContain('Líneas de Metro Ligero (1)');
  });
});

describe('atribución también en los errores', () => {
  const failing: Array<[string, object]> = [
    ['transporte_paradas', {}],
    ['transporte_paradas', { nombre: 'zzzz' }],
    ['transporte_paradas', { nombre: 'sol', modo: 'tranvia' }],
    ['transporte_paradas', { linea: '1' }],
    ['transporte_paradas', { linea: 'ML9' }],
    ['transporte_lineas', {}],
    ['transporte_lineas', { modo: 'ml', linea: 'ML9' }],
    ['transporte_salidas', {}],
    ['transporte_salidas', { parada: 'emt:3687', linea: '999' }],
    ['transporte_salidas', { parada: 'emt:3687', destino: 'zzzz' }],
    ['transporte_trayecto', { origen: 'ml:est_10_1', destino: 'ml:est_10_1' }],
  ];

  it.each(failing)('%s %j: el mensaje primero y la atribución después', async (name, args) => {
    const msg = await error(name, args);
    const lines = msg.split('\n');
    expect(lines[0]).not.toContain('Origen de los datos');
    expect(lines.at(-1)!.startsWith(CRTM) || lines.at(-1) === EMT).toBe(true);
    expect(msg).toContain(CRTM);
  });

  it('sin índice abiertos (preparando) lleva la atribución genérica, sin fecha', async () => {
    const t = createCrtmTools(fixtureContext(dir, TUE_1735, []));
    const err = await t
      .find((x) => x.name === 'transporte_paradas')!
      .handler({ nombre: 'sol' })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/^Estoy preparando los horarios de /);
    expect((err as Error).message.split('\n').at(-1)).toBe(CRTM);
  });

  it('las respuestas de resolución de parada (no encontrada, id inexistente) también', async () => {
    const none = await call('transporte_salidas', { parada: 'zzzz nada' });
    expect(none).toContain('No encuentro ninguna parada');
    expect(none).toContain(CRTM);
    const bad = await call('transporte_salidas', { parada: 'ml:nope' });
    expect(bad).toContain(CRTM);
    const noDest = await call('transporte_trayecto', {
      origen: 'zzzz nada',
      destino: 'Las Tablas',
    });
    expect(noDest).toContain(CRTM);
  });
});

describe('fecha de publicación por modo', () => {
  it('si a algún modo abierto le falta la fecha, la que hay se etiqueta con su modo', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'stratum-crtm-tools2-'));
    try {
      await buildFixtureIndex('metro', dir2, { feedModified: '' });
      await buildFixtureIndex('ml', dir2);
      const t = createCrtmTools(fixtureContext(dir2, TUE_1735, ['metro', 'ml']));
      const out = await t
        .find((x) => x.name === 'transporte_paradas')!
        .handler({ nombre: 'pinar de chamartin' });
      expect(out).toContain('horarios publicados el 28/10/2026 (Metro Ligero)');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

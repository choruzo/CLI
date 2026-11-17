/**
 * Tests de las tools del conector AEMET con las fixtures reales (`loc.xml`
 * diaria de Getafe, `h.xml` horaria, `esp.xml` el RSS de avisos y `cap.xml` un
 * CAP de vientos de A Mariña), servidas por un `fetch` falso y con el reloj fijo
 * el martes 17/11/2026 por la tarde (hora de Madrid).
 *
 * Lo que se vigila aquí: el formato de cada salida (texto breve, sin JSON) y la
 * atribución de la licencia en **toda** salida y en **todo** error, el «sin
 * dato» que nunca se convierte en 0, el municipio ambiguo y el municipio sin
 * previsión (con y sin vecino del que se segregó).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { AemetForecast, DIARIA_URL, HORARIA_URL } from './forecast.js';
import { ATRIBUCION, createAemetTools } from './tools.js';
import { AemetAvisos, enlacesCap, RSS_URL } from './warnings.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const locBytes = readFileSync(join(FIXTURES, 'loc.xml'));
const hBytes = readFileSync(join(FIXTURES, 'h.xml'));
const espXml = readFileSync(join(FIXTURES, 'esp.xml'), 'utf8');
const capXml = readFileSync(join(FIXTURES, 'cap.xml'), 'utf8');

/** Martes 17/11/2026, 20:30 en Madrid (UTC+1). */
const AHORA = '2026-11-17T19:30:00Z';

type Respuestas = Record<string, string | Uint8Array | { estado: number }>;

/** `fetch` falso: responde por URL y cuenta peticiones; `*` es el comodín. */
function fetchFalso(
  respuestas: Respuestas,
  estado = 200,
): { fetchImpl: typeof fetch; peticiones: string[] } {
  const peticiones: string[] = [];
  const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    peticiones.push(u);
    const cuerpo = respuestas[u] ?? respuestas['*'];
    // Una respuesta con su propio estado: así se hace fallar un solo CAP.
    if (cuerpo !== undefined && typeof cuerpo === 'object' && !(cuerpo instanceof Uint8Array)) {
      return new Response('', { status: cuerpo.estado });
    }
    if (cuerpo === undefined) return new Response('', { status: estado });
    return new Response(cuerpo as BodyInit, { status: estado });
  }) as typeof fetch;
  return { fetchImpl, peticiones };
}

/** Las respuestas de AEMET para Getafe (28065) y para Fuente Palmera (14030, el vecino de Fuente Carreteros). */
function base(extra: Respuestas = {}): Respuestas {
  return {
    [`${DIARIA_URL}28065.xml`]: locBytes,
    [`${HORARIA_URL}28065.xml`]: hBytes,
    [`${DIARIA_URL}14030.xml`]: locBytes,
    [`${HORARIA_URL}14030.xml`]: hBytes,
    [RSS_URL]: espXml,
    '*': capXml,
    ...extra,
  };
}

interface Opciones {
  ahora?: string;
  respuestas?: Respuestas;
  estado?: number;
}

/** Las tools con su `fetch` y su reloj fijos, y lo que se pidió a AEMET. */
function servidor(opts: Opciones = {}): {
  tools: Record<string, ConnectorTool>;
  peticiones: string[];
} {
  const { fetchImpl, peticiones } = fetchFalso(base(opts.respuestas), opts.estado);
  const now = (): Date => new Date(opts.ahora ?? AHORA);
  const ctx = {
    forecast: new AemetForecast({ fetchImpl, now }),
    avisos: new AemetAvisos({ fetchImpl, now }),
    now,
  };
  return { tools: Object.fromEntries(createAemetTools(ctx).map((t) => [t.name, t])), peticiones };
}

function tools(opts: Opciones = {}): Record<string, ConnectorTool> {
  return servidor(opts).tools;
}

async function call(name: string, args: object, opts: Opciones = {}): Promise<string> {
  return tools(opts)[name]!.handler(args);
}

async function error(name: string, args: object, opts: Opciones = {}): Promise<string> {
  try {
    await call(name, args, opts);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('debía fallar');
}

/** La última línea de una salida o de un error: la atribución de la licencia. */
function ultima(texto: string): string {
  return texto.split('\n').at(-1)!;
}

describe('aemet_prevision', () => {
  it('da 3 días por defecto, en texto breve y con la elaboración', async () => {
    const out = await call('aemet_prevision', { municipio: 'Getafe' });
    expect(out).toBe(
      [
        'Previsión de Getafe (Madrid, 28065) para 3 días:',
        '- Martes 17/11 · Muy nuboso con lluvia escasa · 9 a 16 °C · lluvia 90 % · viento SO 30 km/h (rachas 45)',
        '- Miércoles 18/11 · Cubierto con lluvia · 13 a 18 °C · lluvia 100 % · viento O 20 km/h (rachas 45)',
        '- Jueves 19/11 · Intervalos nubosos con lluvia escasa · 7 a 15 °C · lluvia 95 % · viento SO 15 km/h (rachas 60)',
        'Elaborado el 17/11 a las 19:05.',
        ATRIBUCION,
      ].join('\n'),
    );
  });

  it('acepta el código INE y el número de días', async () => {
    const uno = await call('aemet_prevision', { municipio: '28065', dias: 1 });
    expect(uno.split('\n')[0]).toBe('Previsión de Getafe (Madrid, 28065) para 1 día:');
    expect(uno.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    const siete = await call('aemet_prevision', { municipio: 'Getafe', dias: 7 });
    // La fixture trae 7 días: ninguno se inventa ni se repite.
    expect(siete.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(7);
  });

  it('«sin dato» cuando el feed no lo trae, 0 cuando el feed dice 0', async () => {
    // AEMET deja los elementos vacíos cuando no publica el valor: eso es «sin
    // dato», nunca 0; un 0 explícito del feed sí es un 0.
    const sinDato = `<?xml version='1.0' encoding='ISO-8859-15'?>
<root id="28065"><elaborado>2026-11-17T19:05:09</elaborado><nombre>Getafe</nombre><prediccion>
  <dia fecha="2026-11-17">
    <prob_precipitacion periodo="00-24">0</prob_precipitacion>
    <estado_cielo periodo="00-24" descripcion="Despejado">11</estado_cielo>
    <temperatura><maxima></maxima><minima></minima></temperatura>
    <viento periodo="00-24"><direccion></direccion><velocidad></velocidad></viento>
    <racha_max periodo="00-24"/>
  </dia>
</prediccion></root>`;
    const out = await call(
      'aemet_prevision',
      { municipio: 'Getafe', dias: 1 },
      { respuestas: { [`${DIARIA_URL}28065.xml`]: sinDato } },
    );
    expect(out).toContain(
      '- Martes 17/11 · Despejado · temperatura sin dato · lluvia 0 % · viento sin dato',
    );
    expect(out).not.toContain('lluvia sin dato');
  });

  it('los argumentos inválidos lo dicen y llevan la atribución', async () => {
    expect(await error('aemet_prevision', { municipio: 'Getafe', dias: 9 })).toContain(
      'dias debe ser un entero entre 1 y 7',
    );
    expect(await error('aemet_prevision', {})).toContain('municipio debe ser');
  });
});

describe('aemet_por_horas', () => {
  it('empieza en la hora actual y cruza al día siguiente con su orto y ocaso', async () => {
    const out = await call('aemet_por_horas', { municipio: 'Getafe' });
    const lineas = out.split('\n');
    expect(lineas[0]).toBe(
      'Por horas en Getafe (Madrid, 28065) desde ahora (hora de Madrid: 20:30), 12 horas:',
    );
    expect(lineas[1]).toBe('Hoy 17/11: orto 08:02, ocaso 17:56.');
    expect(lineas[2]).toBe(
      '- 20:00 · Muy nuboso · 16 °C · lluvia 15 % · viento SO 25 km/h (rachas 42)',
    );
    expect(lineas[3]).toBe(
      '- 21:00 · Cubierto · 16 °C · lluvia 15 % · viento SO 26 km/h (rachas 45)',
    );
    expect(out).toContain('Miércoles 18/11: orto 08:03, ocaso 17:55.');
    expect(out).toContain('- 00:00 · Cubierto · ');
    // 12 horas pedidas: 4 de hoy (20-23) y 8 de mañana (00-07).
    expect(lineas.filter((l) => l.startsWith('- '))).toHaveLength(12);
    expect(lineas.at(-2)).toContain('Elaborado el 17/11 a las 19:05.');
    expect(ultima(out)).toBe(ATRIBUCION);
  });

  it('respeta `horas` y no inventa horas que el feed no trae', async () => {
    const out = await call('aemet_por_horas', { municipio: 'Getafe', horas: 6 });
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(6);
    expect(out).toContain('Miércoles 18/11: orto 08:03, ocaso 17:55.');
    expect(out).not.toContain('- 02:00 ·');
    expect(await error('aemet_por_horas', { municipio: 'Getafe', horas: 2 })).toContain(
      'horas debe ser un entero entre 6 y 48',
    );
  });

  it('la probabilidad de las 00:00 es la del tramo envolvente del día anterior', async () => {
    // `1901` del 17 vale de las 19:00 del 17 a la 01:00 del 18 (15 %); el `1901`
    // del 18 (90 %) empieza a las 19:00 del 18. Las 00:00 del 18 son del 17.
    const out = await call('aemet_por_horas', { municipio: 'Getafe', horas: 12 });
    expect(out).toContain(
      '- 00:00 · Cubierto · 15 °C · lluvia 15 % · viento O 28 km/h (rachas 47)',
    );
    // Y a partir de la 01:00 manda el tramo no envolvente del propio día (`0107`).
    expect(out).toContain('- 01:00 · Cubierto · 14 °C · lluvia 45 %');
    // A las 19:00 del 17 el envolvente sí es suyo: 15 %, no el 60 % del `1319`.
    const tarde = await call(
      'aemet_por_horas',
      { municipio: 'Getafe', horas: 6 },
      { ahora: '2026-11-17T17:30:00Z' },
    );
    expect(tarde).toContain('- 19:00 · Cubierto · 16 °C · lluvia 15 %');
  });

  it('«sin dato» frente a 0 en la precipitación y el viento, hora a hora', async () => {
    const h = `<?xml version='1.0' encoding='ISO-8859-15'?>
<root id="28065"><elaborado>2026-11-17T19:05:09</elaborado><nombre>Getafe</nombre><prediccion>
  <dia fecha="2026-11-17" orto="08:02" ocaso="17:56">
    <estado_cielo periodo="20" descripcion="Cubierto">16n</estado_cielo>
    <precipitacion periodo="20">0</precipitacion>
    <temperatura periodo="20">16</temperatura>
    <viento periodo="20"><direccion>O</direccion><velocidad>0</velocidad></viento>
    <estado_cielo periodo="21" descripcion="Cubierto">16n</estado_cielo>
  </dia>
</prediccion></root>`;
    const out = await call(
      'aemet_por_horas',
      { municipio: 'Getafe', horas: 12 },
      { respuestas: { [`${HORARIA_URL}28065.xml`]: h } },
    );
    // 0 mm y 0 km/h son ceros de AEMET; lo que falta es «sin dato».
    expect(out).toContain('- 20:00 · Cubierto · 16 °C · 0 mm · viento O 0 km/h');
    expect(out).toContain(
      '- 21:00 · Cubierto · temperatura sin dato · lluvia sin dato · viento sin dato',
    );
  });

  it('«Ip» (inapreciable) se dice como tal: ni 0 ni «sin dato»', async () => {
    const h = `<?xml version='1.0' encoding='ISO-8859-15'?>
<root id="28065"><elaborado>2026-11-17T19:05:09</elaborado><nombre>Getafe</nombre><prediccion>
  <dia fecha="2026-11-17" orto="08:02" ocaso="17:56">
    <estado_cielo periodo="20" descripcion="Cubierto">16n</estado_cielo>
    <precipitacion periodo="20">Ip</precipitacion>
    <temperatura periodo="20">16</temperatura>
    <viento periodo="20"><direccion>O</direccion><velocidad>5</velocidad></viento>
  </dia>
</prediccion></root>`;
    const out = await call(
      'aemet_por_horas',
      { municipio: 'Getafe', horas: 6 },
      { respuestas: { [`${HORARIA_URL}28065.xml`]: h } },
    );
    expect(out).toContain(
      '- 20:00 · Cubierto · 16 °C · precipitación inapreciable · viento O 5 km/h',
    );
    expect(out).not.toContain('0 mm');
    expect(out).not.toContain('lluvia sin dato');
  });
});

describe('aemet_avisos', () => {
  it('por provincia: los de su zona Meteoalerta, con nivel, valor y vigencia en hora de Madrid', async () => {
    const lugo = await call('aemet_avisos', { provincia: 'Lugo' });
    expect(lugo.split('\n')[0]).toBe(
      'Avisos para la provincia de Lugo: Activos: 1 (amarillo: 1) · Previstos: 0',
    );
    expect(lugo).toContain(
      '- Nivel amarillo · Vientos · Rachas máximas: 80 km/h · A Mariña · de hoy 19:00 a mañana 23:59',
    );
    // El código INE de la provincia vale igual.
    await expect(call('aemet_avisos', { provincia: '27' })).resolves.toBe(lugo);
  });

  it('por provincia sin avisos: lo dice sin inventar ninguno', async () => {
    // Salida real (la atribución, que va siempre la última, se añade aparte):
    //   No hay avisos activos ni previstos para la provincia de A Coruña ahora mismo.
    //   Mira los de toda España con aemet_avisos sin argumentos, o los de un municipio con `municipio`.
    const out = await call('aemet_avisos', { provincia: 'A Coruña' });
    expect(out).toBe(
      [
        'No hay avisos activos ni previstos para la provincia de A Coruña ahora mismo.',
        'Mira los de toda España con aemet_avisos sin argumentos, o los de un municipio con `municipio`.',
        ATRIBUCION,
      ].join('\n'),
    );
  });

  it('por municipio: los de su zona, y ninguno si su zona no tiene', async () => {
    const foz = await call('aemet_avisos', { municipio: 'Foz' });
    expect(foz.split('\n')[0]).toBe(
      'Avisos para Foz (Lugo, 27019), zona Meteoalerta 712701: Activos: 1 (amarillo: 1) · Previstos: 0',
    );
    expect(foz).toContain('· A Mariña · de hoy 19:00 a mañana 23:59');
    expect(foz.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);

    const getafe = await call('aemet_avisos', { municipio: 'Getafe' });
    expect(getafe.split('\n')[0]).toBe(
      'No hay avisos activos ni previstos para Getafe (Madrid, 28065) ahora mismo.',
    );
  });

  it('sin filtro: recuento de activos y previstos, y cómo filtrar', async () => {
    const out = await call('aemet_avisos', {});
    expect(out).toBe(
      [
        'Avisos de España: Activos: 1 (amarillo: 1) · Previstos: 0',
        'Filtra con `municipio` o `provincia` para ver los de una zona.',
        ATRIBUCION,
      ].join('\n'),
    );
  });

  it('un aviso con `onset` futuro cuenta como previsto, no como activo', async () => {
    // El mismo CAP, pero empezando mañana a las 08:00: está publicado, aún no rige.
    const futuro = capXml
      .replaceAll('2026-11-17T19:00:00+01:00', '2026-11-18T08:00:00+01:00')
      .replaceAll('2026-11-18T23:59:59+01:00', '2026-11-19T23:59:59+01:00');
    const opts: Opciones = { respuestas: { '*': futuro } };
    const resumen = await call('aemet_avisos', {}, opts);
    expect(resumen).toBe(
      [
        'Avisos de España: Activos: 0 · Previstos: 1 (amarillo: 1)',
        'Filtra con `municipio` o `provincia` para ver los de una zona.',
        ATRIBUCION,
      ].join('\n'),
    );
    const lugo = await call('aemet_avisos', { provincia: 'Lugo' }, opts);
    expect(lugo.split('\n')[0]).toBe(
      'Avisos para la provincia de Lugo: Activos: 0 · Previstos: 1 (amarillo: 1)',
    );
    expect(lugo).toContain(
      '- Previsto · Nivel amarillo · Vientos · Rachas máximas: 80 km/h · A Mariña · de mañana 08:00 a el 19/11 a las 23:59',
    );
  });

  it('un `expires` vacío o ilegible no se esconde: «fin sin dato»', async () => {
    const sinFin = capXml.replace(
      '<expires>2026-11-18T23:59:59+01:00</expires>',
      '<expires></expires>',
    );
    const out = await call('aemet_avisos', { provincia: 'Lugo' }, { respuestas: { '*': sinFin } });
    expect(out.split('\n')[0]).toBe(
      'Avisos para la provincia de Lugo: Activos: 1 (amarillo: 1) · Previstos: 0',
    );
    expect(out).toContain('· de hoy 19:00 a fin sin dato');
  });

  it('un CAP que falla no tumba los demás y se dice cuántos no se descargaron', async () => {
    const [fallido] = enlacesCap(espXml);
    const out = await call(
      'aemet_avisos',
      { provincia: 'Lugo' },
      { respuestas: { [fallido!]: { estado: 503 } } },
    );
    // Los demás CAP responden: el aviso sigue saliendo, con el aviso de la descarga.
    expect(out).toContain('· A Mariña · de hoy 19:00 a mañana 23:59');
    expect(out.split('\n').at(-2)).toBe('(1 aviso no se pudo descargar)');
    expect(ultima(out)).toBe(ATRIBUCION);

    const resumen = await call('aemet_avisos', {}, { respuestas: { [fallido!]: { estado: 503 } } });
    expect(resumen).toContain('Activos: 1 (amarillo: 1)');
    expect(resumen).toContain('(1 aviso no se pudo descargar)');
  });

  it('una provincia que no existe orienta con la lista de las 52', async () => {
    const msg = await call('aemet_avisos', { provincia: 'Narnia' });
    expect(msg).toContain('No reconozco la provincia «Narnia»');
    expect(msg).toContain('A Coruña (15)');
    expect(ultima(msg)).toBe(ATRIBUCION);
  });
});

describe('aemet_municipios', () => {
  it('encuentra el municipio y dice cómo repetir con su código', async () => {
    const out = await call('aemet_municipios', { nombre: 'Getafe' });
    expect(out.split('\n')[0]).toBe('«Getafe» → 1 municipio:');
    expect(out.split('\n').slice(1)).toEqual([
      '- Getafe · Madrid · 28065',
      'Repite con ese código INE en `municipio` (aemet_prevision, aemet_por_horas o aemet_avisos).',
      ATRIBUCION,
    ]);
    // El código INE vale igual y da el mismo municipio.
    const porCodigo = await call('aemet_municipios', { nombre: '28065' });
    expect(porCodigo.split('\n').slice(1)).toEqual(out.split('\n').slice(1));
  });

  it('con varios candidatos los da todos con provincia y código, sin elegir', async () => {
    const out = await call('aemet_municipios', { nombre: 'sada' });
    expect(out).toContain('«sada» → 2 municipios:');
    expect(out).toContain('- Sada · A Coruña · 15075');
    expect(out).toContain('- Sada · Navarra · 31212');
  });

  it('sin resultados lo dice y orienta a aemet_municipios', async () => {
    const msg = await error('aemet_municipios', { nombre: 'zzzz' });
    expect(msg.split('\n')[0]).toContain('No encuentro ningún municipio llamado «zzzz»');
    expect(msg.split('\n')[0]).toContain('aemet_municipios');
    expect(ultima(msg)).toBe(ATRIBUCION);
  });

  it('por similitud nunca se presenta como coincidencia', async () => {
    // «getttafe» no existe: solo se parece a Getafe (nivel 2).
    const out = await call('aemet_municipios', { nombre: 'getttafe' });
    expect(out.split('\n')[0]).toContain('No encuentro «getttafe». ¿Quizá Getafe?');
    expect(out.split('\n')[0]).toContain('es una aproximación, no una coincidencia');
    expect(out).toContain('- Getafe · Madrid · 28065');
    expect(ultima(out)).toBe(ATRIBUCION);
  });
});

describe('municipio ambiguo', () => {
  it('no adivina: devuelve los candidatos con provincia y código y cómo repetir', async () => {
    // Arroyomolinos existe en Cáceres y en Madrid: la tool no elige.
    const out = await call('aemet_prevision', { municipio: 'arroyomolinos' });
    expect(out).toContain('«arroyomolinos» coincide con 2 municipios.');
    expect(out).toContain('Repite con el código INE en `municipio` (por ejemplo municipio: "');
    expect(out).toContain('- Arroyomolinos · Cáceres · 10023');
    expect(out).toContain('- Arroyomolinos · Madrid · 28015');
    expect(ultima(out)).toBe(ATRIBUCION);
  });

  it('con el código INE ya no hay duda', async () => {
    const out = await call(
      'aemet_prevision',
      { municipio: '10023', dias: 1 },
      { respuestas: { [`${DIARIA_URL}10023.xml`]: locBytes } },
    );
    expect(out.split('\n')[0]).toBe('Previsión de Arroyomolinos (Cáceres, 10023) para 1 día:');
  });
});

describe('municipio sin previsión', () => {
  it('con vecino: dice que no la publica y ofrece la del vecino como la de otro municipio', async () => {
    // Fuente Carreteros (14901) se segregó de Fuente Palmera (14030): la tabla lo
    // sabe (`flags.forecast === false`, `nearest`) y se ofrece la del vecino.
    const out = await call('aemet_prevision', { municipio: 'fuente carreteros', dias: 1 });
    const lineas = out.split('\n');
    expect(lineas[0]).toBe('AEMET no publica previsión para Fuente Carreteros (Córdoba, 14901).');
    expect(lineas[1]).toBe(
      'La de Fuente Palmera (Córdoba, 14030), el municipio del que se segregó, es esta (es de otro municipio, no suya):',
    );
    expect(lineas[2]).toBe('Previsión de Fuente Palmera (Córdoba, 14030) para 1 día:');
    expect(out).toContain('- Martes 17/11 · Muy nuboso con lluvia escasa · 9 a 16 °C');
    // Nunca se presenta la del vecino como si fuera suya.
    expect(out).not.toContain('Previsión de Fuente Carreteros');
    expect(ultima(out)).toBe(ATRIBUCION);
  });

  it('también por horas, y el municipio sin previsión sigue siendo el de la tabla', async () => {
    const out = await call('aemet_por_horas', { municipio: '14901', horas: 6 });
    expect(out).toContain('AEMET no publica previsión para Fuente Carreteros (Córdoba, 14901).');
    expect(out).toContain('La de Fuente Palmera (Córdoba, 14030)');
    expect(out).toContain('Por horas en Fuente Palmera (Córdoba, 14030)');
  });

  it('sin vecino (404 sin flags): dice que no hay previsión y orienta a aemet_municipios', async () => {
    // 404 en todo: AEMET no publica el municipio y la tabla no trae vecino.
    const out = await call('aemet_prevision', { municipio: 'Zamora' }, { estado: 404 });
    expect(out.split('\n')[0]).toBe(
      'AEMET no publica previsión para Zamora (Zamora, 49275). Prueba con un municipio de al lado o con la capital de su provincia; búscalos con aemet_municipios (por ejemplo "Zamora").',
    );
    expect(ultima(out)).toBe(ATRIBUCION);
  });
});

describe('AEMET caído', () => {
  it('previsión: «no responde ahora mismo» y qué hacer', async () => {
    const msg = await error('aemet_prevision', { municipio: 'Getafe' }, { estado: 503 });
    expect(msg.split('\n')[0]).toMatch(
      /^AEMET no responde ahora mismo \(HTTP 503 .*\); prueba en unos minutos\.$/,
    );
    expect(ultima(msg)).toBe(ATRIBUCION);
  });

  it('avisos: el fallo del RSS también se dice así, con la atribución', async () => {
    const msg = await error('aemet_avisos', {}, { estado: 503 });
    expect(msg.split('\n')[0]).toMatch(/^AEMET no responde ahora mismo \(/);
    expect(msg.split('\n')[0]).toContain('prueba en unos minutos');
    expect(ultima(msg)).toBe(ATRIBUCION);
  });
});

describe('municipio por aproximación', () => {
  it('un único candidato por similitud tampoco se resuelve solo: se pregunta', async () => {
    const out = await call('aemet_prevision', { municipio: 'getttafe' });
    expect(out.split('\n')[0]).toContain('No encuentro «getttafe». ¿Quizá Getafe?');
    expect(out.split('\n')[0]).toContain('es una aproximación, no una coincidencia');
    expect(out).toContain('- Getafe · Madrid · 28065');
    expect(out).not.toContain('Previsión de');
    expect(ultima(out)).toBe(ATRIBUCION);
  });

  it('sin nada cercano no se inventa una coincidencia', async () => {
    // «narnia» no está ni se parece lo bastante: ni Sarria ni Navia ni Haría salen.
    const out = await call('aemet_prevision', { municipio: 'narnia' });
    expect(out.split('\n')[0]).toBe(
      'No encuentro ningún municipio llamado «narnia»; busca con aemet_municipios (por nombre sin acentos ni artículos, como "la acebeda", o por el código INE de 5 dígitos).',
    );
    expect(out).not.toContain('coincide con');
    expect(ultima(out)).toBe(ATRIBUCION);
  });
});

describe('flags.from con forecast: true', () => {
  it('la previsión se pide con el código del municipio, no con el del origen', async () => {
    // Játar (18106) viene de un override con `forecast: true`, `from: 18020`
    // (Arenas del Rey): AEMET lo publica con su propio código.
    const s = servidor({ respuestas: { [`${DIARIA_URL}18106.xml`]: locBytes } });
    const out = await s.tools['aemet_prevision']!.handler({ municipio: 'jatar', dias: 1 });
    expect(out.split('\n')[0]).toBe('Previsión de Játar (Granada, 18106) para 1 día:');
    expect(out).not.toContain('Arenas del Rey');
    expect(s.peticiones).toEqual([`${DIARIA_URL}18106.xml`]);
  });

  it('si aun así no hay previsión, vale la respuesta normal de «no publica»', async () => {
    const out = await call(
      'aemet_prevision',
      { municipio: 'jatar', dias: 1 },
      { respuestas: { [`${DIARIA_URL}18106.xml`]: { estado: 404 } } },
    );
    expect(out.split('\n')[0]).toBe(
      'AEMET no publica previsión para Játar (Granada, 18106). Prueba con un municipio de al lado o con la capital de su provincia; búscalos con aemet_municipios (por ejemplo "Granada").',
    );
    expect(ultima(out)).toBe(ATRIBUCION);
  });
});

describe('atribución en toda salida y en todo error', () => {
  const ok: Array<[string, object]> = [
    ['aemet_municipios', { nombre: 'Getafe' }],
    ['aemet_municipios', { nombre: 'sada' }],
    ['aemet_municipios', { nombre: 'getttafe' }],
    ['aemet_prevision', { municipio: 'Getafe' }],
    ['aemet_prevision', { municipio: 'fuente carreteros' }],
    ['aemet_prevision', { municipio: 'arroyomolinos' }],
    ['aemet_prevision', { municipio: 'zzzz' }],
    ['aemet_prevision', { municipio: 'getttafe' }],
    ['aemet_por_horas', { municipio: '28065', horas: 6 }],
    ['aemet_avisos', { municipio: 'Foz' }],
    ['aemet_avisos', { municipio: 'zzzz' }],
    ['aemet_avisos', { provincia: 'Lugo' }],
    ['aemet_avisos', { provincia: 'A Coruña' }],
    ['aemet_avisos', { provincia: 'Narnia' }],
    ['aemet_avisos', {}],
  ];
  const mal: Array<[string, object]> = [
    ['aemet_municipios', {}],
    ['aemet_municipios', { nombre: 'zzzz' }],
    ['aemet_prevision', { municipio: 'Getafe', dias: 0 }],
    ['aemet_por_horas', { municipio: 'Getafe', horas: 99 }],
  ];

  it.each(ok)('%s %j acaba con la atribución de AEMET', async (name, args) => {
    const out = await call(name, args);
    expect(ultima(out)).toBe(ATRIBUCION);
    expect(out.match(/Fuente: AEMET/g)).toHaveLength(1);
    expect(out).not.toMatch(/respald|oficial de este servicio|datos propios/i);
  });

  it.each(mal)('%s %j: el mensaje primero y la atribución después', async (name, args) => {
    const msg = await error(name, args);
    expect(msg.split('\n')[0]).not.toContain('Fuente: AEMET');
    expect(ultima(msg)).toBe(ATRIBUCION);
  });
});

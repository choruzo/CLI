/**
 * Tests de `forecast.ts` con las fixtures reales (`loc.xml` diaria e `h.xml`
 * horaria, ambas ISO-8859-15) servidas por un `fetch` falso, reloj fijo para
 * la caché y los errores: 404 = sin previsión, resto = AEMET no disponible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AemetForecast,
  DIARIA_URL,
  HORARIA_URL,
  SinPrevision,
  AemetNoDisponible,
} from './forecast.js';
import { decodificarIso885915 } from './xml.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const locBytes = readFileSync(join(FIXTURES, 'loc.xml'));
const hBytes = readFileSync(join(FIXTURES, 'h.xml'));

/** `fetch` falso que responde por URL y cuenta peticiones. */
function fetchFalso(
  respuestas: Record<string, string | Uint8Array>,
  estado = 200,
): { fetchImpl: typeof fetch; peticiones: string[] } {
  const peticiones: string[] = [];
  const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    peticiones.push(u);
    const cuerpo = respuestas[u] ?? respuestas['*'];
    if (cuerpo === undefined) return new Response('', { status: estado });
    return new Response(cuerpo as BodyInit, { status: estado });
  }) as typeof fetch;
  return { fetchImpl, peticiones };
}

describe('decodificarIso885915', () => {
  it('corrige los puntos que ISO-8859-1 no acierta (al menos el €)', () => {
    const bytes = new Uint8Array([0xa4, 0xc9, 0xf1, 0xbe]);
    expect(decodificarIso885915(bytes.buffer)).toBe('€ÉñŸ');
  });
});

describe('AemetForecast.diaria (fixture real de Getafe)', () => {
  const { fetchImpl } = fetchFalso({ [`${DIARIA_URL}28065.xml`]: locBytes });
  const forecast = new AemetForecast({
    fetchImpl,
    now: (): Date => new Date('2026-11-17T20:00:00Z'),
  });

  it('parsea cabecera y días del XML diario', async () => {
    const d = await forecast.diaria('28065');
    expect(d.municipio).toBe('Getafe');
    expect(d.ine).toBe('28065');
    expect(d.elaborado).toBe('2026-11-17T19:05:09');
    expect(d.dias.length).toBeGreaterThan(3);
    const hoy = d.dias[0]!;
    expect(hoy.fecha).toBe('2026-11-17');
    expect(hoy.probPrecipitacion['12-24']).toBe(90);
    expect(hoy.probPrecipitacion['00-24']).toBe(null); // elemento vacío = sin dato, nunca 0
    expect(hoy.cotaNieve['12-24']).toBe(null);
    expect(hoy.estadoCielo['06-12']).toEqual({ descripcion: 'Niebla', valor: '81' });
    expect(hoy.estadoCielo['12-24']).toEqual({
      descripcion: 'Muy nuboso con lluvia escasa',
      valor: '45',
    });
    expect(hoy.estadoCielo['18-24']!.valor).toBe('15n');
    expect(hoy.estadoCielo['00-24']).toEqual({ descripcion: '', valor: null });
    expect(hoy.uvMax).toBe(2);
  });

  it('parsea viento, rachas y temperatura con sus horas', async () => {
    const d = await forecast.diaria('28065');
    const hoy = d.dias[0]!;
    expect(hoy.viento['12-24']).toEqual({ direccion: 'SO', velocidad: 30 });
    expect(hoy.viento['00-06']).toEqual({ direccion: null, velocidad: null });
    expect(hoy.rachaMax['12-24']).toBe(45);
    expect(hoy.temperatura).toEqual({
      maxima: 16,
      minima: 9,
      dato: { '06': null, '12': 14, '18': 16, '24': 14 },
    });
    expect(hoy.sensTermica.minima).toBe(11);
    expect(hoy.humedadRelativa.maxima).toBe(95);
  });
});

describe('AemetForecast.horaria (fixture real de Getafe)', () => {
  const { fetchImpl } = fetchFalso({ [`${HORARIA_URL}28065.xml`]: hBytes });
  const forecast = new AemetForecast({ fetchImpl });

  it('parsea orto, ocaso y valores por hora', async () => {
    const h = await forecast.horaria('28065');
    expect(h.municipio).toBe('Getafe');
    expect(h.dias[0]!.fecha).toBe('2026-11-17');
    expect(h.dias[0]!.orto).toBe('08:02');
    expect(h.dias[0]!.ocaso).toBe('17:56');
    expect(h.dias[0]!.estadoCielo['13']).toEqual({
      descripcion: 'Cubierto con lluvia escasa',
      valor: '46',
    });
    expect(h.dias[0]!.precipitacion['13']).toBe(0.1);
    expect(h.dias[0]!.viento['16']).toEqual({ direccion: 'SO', velocidad: 21 });
    expect(h.dias[0]!.rachaMax['16']).toBe(49);
    expect(h.dias[0]!.probTormenta['1319']).toBe(0);
  });
});

describe('la caché no crece sin límite', () => {
  it('al guardar una entrada nueva se tiran las caducadas', async () => {
    let reloj = new Date('2026-11-17T20:00:00Z').getTime();
    const { fetchImpl } = fetchFalso({ '*': locBytes });
    const forecast = new AemetForecast({ fetchImpl, now: (): Date => new Date(reloj) });
    await forecast.diaria('28065');
    await forecast.diaria('28070');
    expect(forecast.cacheSize).toBe(2);
    reloj += 31 * 60_000; // pasados los 30 min, las dos están caducadas
    await forecast.diaria('28079');
    expect(forecast.cacheSize).toBe(1);
  });
});

describe('«Ip» en la precipitación (inapreciable)', () => {
  it('no es 0 ni «sin dato»: se marca aparte', async () => {
    const { fetchImpl } = fetchFalso({ [`${HORARIA_URL}28065.xml`]: hBytes });
    const h = await new AemetForecast({ fetchImpl }).horaria('28065');
    const dia = h.dias[1]!; // 2026-11-18: las 04 a 09 son «Ip»
    expect(dia.precipitacion['04']).toBe(null);
    expect(dia.precipitacionInapreciable['04']).toBe(true);
    expect(dia.precipitacion['00']).toBe(0);
    expect(dia.precipitacionInapreciable['00']).toBe(false);
  });
});

describe('caché y errores', () => {
  it('una segunda llamada dentro de 30 min no repite la petición', async () => {
    let reloj = new Date('2026-11-17T20:00:00Z').getTime();
    const { fetchImpl, peticiones } = fetchFalso({ [`${DIARIA_URL}28065.xml`]: locBytes });
    const forecast = new AemetForecast({ fetchImpl, now: (): Date => new Date(reloj) });
    await forecast.diaria('28065');
    await forecast.diaria('28065');
    expect(peticiones).toHaveLength(1);
    reloj += 31 * 60_000;
    await forecast.diaria('28065');
    expect(peticiones).toHaveLength(2);
  });

  it('404: AEMET no publica previsión para ese municipio', async () => {
    const { fetchImpl } = fetchFalso({}, 404);
    const forecast = new AemetForecast({ fetchImpl });
    await expect(forecast.diaria('99999')).rejects.toThrow(SinPrevision);
    await expect(forecast.horaria('99999')).rejects.toThrow(
      /no publica previsión para el municipio 99999/,
    );
  });

  it('otros fallos HTTP y de red: AEMET no responde', async () => {
    const { fetchImpl } = fetchFalso({}, 503);
    const forecast = new AemetForecast({ fetchImpl });
    await expect(forecast.diaria('28065')).rejects.toThrow(AemetNoDisponible);
    await expect(forecast.diaria('28065')).rejects.toThrow(/AEMET no responde/);

    const roto = (async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new AemetForecast({ fetchImpl: roto }).diaria('28065')).rejects.toThrow(
      /AEMET no responde/,
    );
  });

  it('un XML sin días es un error, no una previsión vacía', async () => {
    const { fetchImpl } = fetchFalso({
      [`${DIARIA_URL}28065.xml`]: '<root><nombre>Getafe</nombre></root>',
    });
    const forecast = new AemetForecast({ fetchImpl });
    await expect(forecast.diaria('28065')).rejects.toThrow(/no trae días/);
  });
});

import { describe, expect, it } from 'vitest';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { createOpenMeteoTools } from './tools.js';

type Route = (url: URL) => unknown;

function fakeFetch(route: Route): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const r = route(url);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, urls };
}

function tool(tools: ConnectorTool[], name: string): ConnectorTool {
  return tools.find((t) => t.name === name)!;
}

const madrid = {
  id: 3117735,
  name: 'Madrid',
  latitude: 40.4165,
  longitude: -3.70256,
  country: 'España',
  country_code: 'ES',
  admin1: 'Comunidad de Madrid',
  population: 3255944,
};
const madridCo = {
  id: 3675707,
  name: 'Madrid',
  latitude: 4.73245,
  longitude: -74.26419,
  country: 'Colombia',
  country_code: 'CO',
  admin1: 'Cundinamarca',
  population: 80000,
};
const sprA = {
  id: 1,
  name: 'Springfield',
  latitude: 39.8,
  longitude: -89.6,
  country: 'Estados Unidos',
  country_code: 'US',
  admin1: 'Illinois',
  population: 100000,
};
const sprB = {
  id: 2,
  name: 'Springfield',
  latitude: 42.1,
  longitude: -72.5,
  country: 'Estados Unidos',
  country_code: 'US',
  admin1: 'Massachusetts',
  population: 90000,
};

const current = {
  timezone: 'Europe/Madrid',
  current: {
    time: '2026-11-11T18:40',
    temperature_2m: 21.34,
    relative_humidity_2m: 45,
    apparent_temperature: 20.1,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 12.2,
    wind_gusts_10m: 25.4,
    wind_direction_10m: 225,
  },
};

function standardRoute(forecast: unknown): Route {
  return (url) => {
    if (url.pathname.endsWith('/search')) {
      const name = url.searchParams.get('name');
      if (name === 'Madrid') return { results: [madrid, madridCo] };
      if (name === 'Springfield') return { results: [sprA, sprB] };
      return {};
    }
    if (url.pathname.endsWith('/get')) return madrid;
    return forecast;
  };
}

describe('buscar_lugar', () => {
  it('lista candidatos con id', async () => {
    const { fetch, urls } = fakeFetch(standardRoute(null));
    const out = await tool(createOpenMeteoTools({ fetch }), 'buscar_lugar').handler({
      nombre: 'Madrid',
    });
    expect(out).toBe(
      [
        'Lugares para «Madrid» (2):',
        '1. Madrid — Comunidad de Madrid, España · 40.42, -3.70 · id geo:3117735',
        '2. Madrid — Cundinamarca, Colombia · 4.73, -74.26 · id geo:3675707',
        'Usa el id en tiempo_actual o prevision.',
      ].join('\n'),
    );
    expect(urls[0]).toContain('language=es');
    expect(urls[0]).toContain('count=5');
  });

  it('filtra por país sin distinguir mayúsculas', async () => {
    const { fetch } = fakeFetch(standardRoute(null));
    const out = (await tool(createOpenMeteoTools({ fetch }), 'buscar_lugar').handler({
      nombre: 'Madrid',
      pais: 'co',
    })) as string;
    expect(out).toContain('(1)');
    expect(out).toContain('Colombia');
    expect(out).not.toContain('Comunidad de Madrid');
  });

  it('sin resultados no es error', async () => {
    const { fetch } = fakeFetch(() => ({}));
    const out = await tool(createOpenMeteoTools({ fetch }), 'buscar_lugar').handler({
      nombre: 'Xyzzy',
    });
    expect(out).toBe(
      'No encontré ningún lugar llamado «Xyzzy». Prueba con otro nombre o añade el país (pais: "ES").',
    );
  });

  it('argumentos inválidos → ToolUserError con el argumento', async () => {
    const { fetch } = fakeFetch(() => ({}));
    const t = tool(createOpenMeteoTools({ fetch }), 'buscar_lugar');
    await expect(t.handler({ nombre: 'Madrid', max: 99 })).rejects.toThrow(
      /max debe ser un entero entre 1 y 10/,
    );
    await expect(t.handler({})).rejects.toBeInstanceOf(ToolUserError);
  });
});

describe('tiempo_actual', () => {
  it('formatea el tiempo y avisa de la interpretación', async () => {
    const { fetch, urls } = fakeFetch(standardRoute(current));
    const out = (await tool(createOpenMeteoTools({ fetch }), 'tiempo_actual').handler({
      lugar: 'Madrid',
    })) as string;
    expect(out).toBe(
      [
        'Tiempo en Madrid (Comunidad de Madrid, España) · 18:40 hora local (Europe/Madrid)',
        'Cielo: parcialmente nuboso',
        'Temperatura: 21,3 °C (sensación 20,1 °C)',
        'Humedad: 45 %',
        'Viento: 12 km/h del suroeste, rachas de 25 km/h',
        'Precipitación: 0,0 mm',
        '(Interpreté «Madrid» como Madrid, España; si era otro, usa buscar_lugar.)',
        'Datos: Open-Meteo.com (CC BY 4.0)',
      ].join('\n'),
    );
    expect(urls[1]).toContain('timezone=auto');
  });

  it('un null es «sin dato», nunca 0', async () => {
    const { fetch } = fakeFetch(
      standardRoute({
        timezone: 'Europe/Madrid',
        current: { time: '2026-11-11T18:40', temperature_2m: null, weather_code: null },
      }),
    );
    const out = (await tool(createOpenMeteoTools({ fetch }), 'tiempo_actual').handler({
      lugar: 'geo:3117735',
    })) as string;
    expect(out).toContain('Temperatura: sin dato (sensación sin dato)');
    expect(out).toContain('Humedad: sin dato');
    expect(out).toContain('Viento: sin dato');
    expect(out).toContain('Cielo: sin dato');
    expect(out).not.toContain('Interpreté');
  });

  it('lugar ambiguo: devuelve la lista sin adivinar', async () => {
    const { fetch, urls } = fakeFetch(standardRoute(current));
    const out = (await tool(createOpenMeteoTools({ fetch }), 'tiempo_actual').handler({
      lugar: 'Springfield',
    })) as string;
    expect(out).toContain('Hay varios lugares llamados «Springfield»:');
    expect(out).toContain('id geo:2');
    expect(out).toContain('Repite con lugar: "geo:<id>".');
    expect(urls).toHaveLength(1);
  });

  it('lugar inexistente → ToolUserError', async () => {
    const { fetch } = fakeFetch(() => ({}));
    await expect(
      tool(createOpenMeteoTools({ fetch }), 'tiempo_actual').handler({ lugar: 'Nada' }),
    ).rejects.toThrow('No encontré «Nada». Usa buscar_lugar para ver candidatos.');
  });

  it('error HTTP y de red → ToolUserError', async () => {
    const http = fakeFetch(() => new Response('x', { status: 503 }));
    await expect(
      tool(createOpenMeteoTools({ fetch: http.fetch }), 'tiempo_actual').handler({
        lugar: 'Madrid',
      }),
    ).rejects.toThrow(
      /No pude consultar Open-Meteo \(HTTP 503\)\. Inténtalo de nuevo en un momento\./,
    );
    const net = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      tool(createOpenMeteoTools({ fetch: net }), 'tiempo_actual').handler({ lugar: 'Madrid' }),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe('prevision', () => {
  const daily = {
    timezone: 'Europe/Madrid',
    daily: {
      time: ['2026-11-12', '2026-11-13'],
      weather_code: [61, null],
      temperature_2m_max: [16.2, null],
      temperature_2m_min: [9.4, null],
      precipitation_sum: [2.34, null],
      precipitation_probability_max: [70, null],
      wind_speed_10m_max: [20.1, null],
      sunrise: ['2026-11-12T07:58', null],
      sunset: ['2026-11-12T18:00', null],
    },
  };

  it('previsión diaria', async () => {
    const { fetch, urls } = fakeFetch(standardRoute(daily));
    const out = (await tool(createOpenMeteoTools({ fetch }), 'prevision').handler({
      lugar: 'geo:3117735',
      dias: 2,
    })) as string;
    expect(out).toBe(
      [
        'Previsión para Madrid (Comunidad de Madrid, España), hora local Europe/Madrid:',
        '· jue 12 nov: lluvia ligera · 9–16 °C · lluvia 2,3 mm (prob. 70 %) · viento máx. 20 km/h · sol 07:58–18:00',
        '· vie 13 nov: sin dato · sin dato · lluvia sin dato (prob. sin dato) · viento máx. sin dato · sol sin dato',
        'Datos: Open-Meteo.com (CC BY 4.0)',
      ].join('\n'),
    );
    expect(urls[1]).toContain('forecast_days=2');
  });

  it('por horas: desde la hora actual, cada 3 h', async () => {
    const times = Array.from({ length: 48 }, (_, i) => {
      const day = i < 24 ? '2026-11-11' : '2026-11-12';
      return `${day}T${String(i % 24).padStart(2, '0')}:00`;
    });
    const { fetch } = fakeFetch(
      standardRoute({
        timezone: 'Europe/Madrid',
        current: { time: '2026-11-11T18:40' },
        hourly: {
          time: times,
          temperature_2m: times.map(() => 14),
          weather_code: times.map(() => 0),
          // La hora 22:00 del día 11 (índice 22) no trae probabilidad.
          precipitation_probability: times.map((_, i) => (i === 22 ? null : 5)),
        },
      }),
    );
    const out = (await tool(createOpenMeteoTools({ fetch }), 'prevision').handler({
      lugar: 'geo:3117735',
      por_horas: true,
    })) as string;
    const rows = out.split('\n').filter((l) => l.startsWith('·'));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe('· mié 19:00 — 14 °C · despejado · prob. lluvia 5 %');
    expect(rows[1]).toBe('· mié 22:00 — 14 °C · despejado · prob. lluvia sin dato');
  });

  it('dias fuera de rango → ToolUserError', async () => {
    const { fetch } = fakeFetch(() => ({}));
    await expect(
      tool(createOpenMeteoTools({ fetch }), 'prevision').handler({ lugar: 'Madrid', dias: 9 }),
    ).rejects.toThrow(/dias debe ser un entero entre 1 y 7/);
  });
});

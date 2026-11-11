/**
 * Tools del conector Open-Meteo: buscar_lugar, tiempo_actual y prevision.
 * `fetch` es inyectable para testear sin red. Las salidas son texto breve en
 * español para un agente, nunca JSON crudo.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import {
  NO_DATA,
  clock,
  dayLabel,
  dec1,
  hourLabel,
  int,
  normalizeName,
  windDirection,
  withUnit,
} from './format.js';
import { weatherText } from './weather-codes.js';

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'stratum-connector-open-meteo/1.0';
const ATTRIBUTION = 'Datos: Open-Meteo.com (CC BY 4.0)';

export interface OpenMeteoOptions {
  fetch: typeof fetch;
  /** Reloj para el caso en que la respuesta no traiga la hora local actual. */
  now?: () => Date;
}

interface Place {
  id: number | null;
  name: string;
  latitude: number;
  longitude: number;
  country: string | null;
  countryCode: string | null;
  admin1: string | null;
  population: number;
}

// --- Argumentos --------------------------------------------------------------

const PAIS_MSG = 'pais debe ser un código de país ISO de 2 letras (p. ej. "ES")';
const pais = z
  .string({ message: PAIS_MSG })
  .regex(/^[A-Za-z]{2}$/, PAIS_MSG)
  .optional();
const lugar = z
  .string({ message: 'lugar debe ser un texto: un nombre o un id "geo:<número>"' })
  .trim()
  .min(1, 'lugar no puede estar vacío')
  .max(100, 'lugar admite como máximo 100 caracteres');

const NOMBRE_MSG = 'nombre debe ser un texto de 1 a 100 caracteres';
const MAX_MSG = 'max debe ser un entero entre 1 y 10';
const DIAS_MSG = 'dias debe ser un entero entre 1 y 7';

const BuscarSchema = z.object({
  nombre: z.string({ message: NOMBRE_MSG }).trim().min(1, NOMBRE_MSG).max(100, NOMBRE_MSG),
  pais,
  max: z.number({ message: MAX_MSG }).int(MAX_MSG).min(1, MAX_MSG).max(10, MAX_MSG).optional(),
});
const TiempoSchema = z.object({ lugar, pais });
const PrevisionSchema = z.object({
  lugar,
  pais,
  dias: z.number({ message: DIAS_MSG }).int(DIAS_MSG).min(1, DIAS_MSG).max(7, DIAS_MSG).optional(),
  por_horas: z.boolean({ message: 'por_horas debe ser true o false' }).optional(),
});

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ToolUserError(`Argumento inválido: ${issue?.message ?? 'argumentos no válidos'}.`);
}

// --- Red ---------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'tiempo de espera agotado';
    return err.message || err.name;
  }
  return String(err);
}

function unavailable(motivo: string): ToolUserError {
  return new ToolUserError(
    `No pude consultar Open-Meteo (${motivo}). Inténtalo de nuevo en un momento.`,
  );
}

function createClient(opts: OpenMeteoOptions) {
  return async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await opts.fetch(url, { signal: sig, headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      throw unavailable(reason(err));
    }
    if (!res.ok) throw unavailable(`HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw unavailable('respuesta no válida');
    }
  };
}

// --- Lugares -----------------------------------------------------------------

function toPlace(v: unknown): Place | null {
  if (!isRecord(v)) return null;
  const latitude = numOrNull(v.latitude);
  const longitude = numOrNull(v.longitude);
  const name = strOrNull(v.name);
  if (latitude === null || longitude === null || name === null) return null;
  return {
    id: numOrNull(v.id),
    name,
    latitude,
    longitude,
    country: strOrNull(v.country),
    countryCode: strOrNull(v.country_code),
    admin1: strOrNull(v.admin1),
    population: numOrNull(v.population) ?? 0,
  };
}

/** `Comunidad de Madrid, España`, omitiendo lo ausente. */
function region(p: Place): string {
  return [p.admin1, p.country].filter((x): x is string => !!x).join(', ');
}

/** `Madrid (Comunidad de Madrid, España)` */
function placeLabel(p: Place): string {
  const r = region(p);
  return r ? `${p.name} (${r})` : p.name;
}

function candidateList(places: Place[]): string {
  return places
    .map((p, i) => {
      const r = region(p);
      const head = r ? `${p.name} — ${r}` : p.name;
      const id = p.id !== null ? ` · id geo:${p.id}` : '';
      return `${i + 1}. ${head} · ${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}${id}`;
    })
    .join('\n');
}

function filterCountry(places: Place[], code: string | undefined): Place[] {
  if (!code) return places;
  const c = code.toUpperCase();
  return places.filter((p) => p.countryCode?.toUpperCase() === c);
}

export function createOpenMeteoTools(opts: OpenMeteoOptions): ConnectorTool[] {
  const getJson = createClient(opts);
  const now = opts.now ?? (() => new Date());

  async function search(name: string, count: number, signal?: AbortSignal): Promise<Place[]> {
    const url = `${GEOCODING}/search?name=${encodeURIComponent(name)}&count=${count}&language=es&format=json`;
    const data = await getJson(url, signal);
    const results = isRecord(data) ? array(data.results) : [];
    return results.map(toPlace).filter((p): p is Place => p !== null);
  }

  async function byId(id: string, signal?: AbortSignal): Promise<Place | null> {
    return toPlace(await getJson(`${GEOCODING}/get?id=${id}&language=es`, signal));
  }

  /** Resuelve `lugar`: un `Place` (con nota opcional) o el texto de ambigüedad. */
  async function resolve(
    raw: string,
    code: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ place: Place; note?: string } | { text: string }> {
    const notFound = new ToolUserError(
      `No encontré «${raw}». Usa buscar_lugar para ver candidatos.`,
    );
    const idMatch = /^geo:(\d+)$/i.exec(raw);
    if (idMatch) {
      const place = await byId(idMatch[1]!, signal);
      if (!place) throw notFound;
      return { place };
    }
    let candidates = filterCountry(await search(raw, 10, signal), code);
    if (candidates.length === 0) throw notFound;
    const wanted = normalizeName(raw);
    const exact = candidates.filter((p) => normalizeName(p.name) === wanted);
    if (exact.length > 0) candidates = exact;
    const first = candidates[0]!;
    const second = candidates[1];
    if (!second) return { place: first };
    if (first.population >= 10 * second.population) {
      const r = first.country ? `${first.name}, ${first.country}` : first.name;
      return {
        place: first,
        note: `(Interpreté «${raw}» como ${r}; si era otro, usa buscar_lugar.)`,
      };
    }
    return {
      text:
        `Hay varios lugares llamados «${raw}»:\n${candidateList(candidates)}\n` +
        'Repite con lugar: "geo:<id>".',
    };
  }

  async function forecast(
    place: Place,
    blocks: string,
    days: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url =
      `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}&timezone=auto` +
      `&${blocks}&forecast_days=${days}`;
    const data = await getJson(url, signal);
    if (!isRecord(data)) throw unavailable('respuesta no válida');
    return data;
  }

  const buscarLugar: ConnectorTool = {
    name: 'buscar_lugar',
    description:
      'Busca un lugar por su nombre y devuelve candidatos con su id (geo:<número>). ' +
      'Úsala cuando el nombre sea ambiguo (varias ciudades con el mismo nombre) o para obtener el id exacto.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', minLength: 1, maxLength: 100, description: 'Nombre del lugar.' },
        pais: { type: 'string', description: 'Código de país ISO-2 para filtrar (p. ej. "ES").' },
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Máximo de candidatos (por defecto 5).',
        },
      },
      required: ['nombre'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(BuscarSchema, args);
      const max = a.max ?? 5;
      // Con filtro de país se pide de más: el filtro se aplica aquí, no en la API.
      const found = filterCountry(await search(a.nombre, a.pais ? 50 : max, signal), a.pais).slice(
        0,
        max,
      );
      if (found.length === 0) {
        return `No encontré ningún lugar llamado «${a.nombre}». Prueba con otro nombre o añade el país (pais: "ES").`;
      }
      return (
        `Lugares para «${a.nombre}» (${found.length}):\n${candidateList(found)}\n` +
        'Usa el id en tiempo_actual o prevision.'
      );
    },
  };

  const tiempoActual: ConnectorTool = {
    name: 'tiempo_actual',
    description:
      'El tiempo que hace ahora en un lugar: cielo, temperatura, humedad, viento y precipitación. ' +
      'El lugar es un nombre ("Madrid") o un id "geo:<número>" de buscar_lugar.',
    inputSchema: {
      type: 'object',
      properties: {
        lugar: { type: 'string', description: 'Nombre del lugar o id "geo:<número>".' },
        pais: { type: 'string', description: 'Código de país ISO-2 para desambiguar (opcional).' },
      },
      required: ['lugar'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(TiempoSchema, args);
      const r = await resolve(a.lugar, a.pais, signal);
      if ('text' in r) return r.text;
      const data = await forecast(
        r.place,
        'current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
        1,
        signal,
      );
      const cur = isRecord(data.current) ? data.current : {};
      const tz = strOrNull(data.timezone);
      const speed = numOrNull(cur.wind_speed_10m);
      const gusts = numOrNull(cur.wind_gusts_10m);
      const dir = numOrNull(cur.wind_direction_10m);
      let wind = NO_DATA;
      if (speed !== null) {
        wind = `${int(speed)} km/h`;
        if (dir !== null) wind += ` del ${windDirection(dir)}`;
        wind += gusts !== null ? `, rachas de ${int(gusts)} km/h` : `, rachas ${NO_DATA}`;
      }
      const lines = [
        `Tiempo en ${placeLabel(r.place)} · ${clock(strOrNull(cur.time))} hora local${tz ? ` (${tz})` : ''}`,
        `Cielo: ${weatherText(numOrNull(cur.weather_code))}`,
        `Temperatura: ${withUnit(dec1(numOrNull(cur.temperature_2m)), '°C')} (sensación ${withUnit(dec1(numOrNull(cur.apparent_temperature)), '°C')})`,
        `Humedad: ${withUnit(int(numOrNull(cur.relative_humidity_2m)), '%')}`,
        `Viento: ${wind}`,
        `Precipitación: ${withUnit(dec1(numOrNull(cur.precipitation)), 'mm')}`,
      ];
      if (r.note) lines.push(r.note);
      lines.push(ATTRIBUTION);
      return lines.join('\n');
    },
  };

  const prevision: ConnectorTool = {
    name: 'prevision',
    description:
      'La previsión del tiempo de los próximos días (hasta 7), o por horas (próximas 24 h, cada 3 h) con por_horas. ' +
      'Úsala para "¿llueve mañana?", temperaturas máximas y mínimas o el fin de semana.',
    inputSchema: {
      type: 'object',
      properties: {
        lugar: { type: 'string', description: 'Nombre del lugar o id "geo:<número>".' },
        pais: { type: 'string', description: 'Código de país ISO-2 para desambiguar (opcional).' },
        dias: {
          type: 'integer',
          minimum: 1,
          maximum: 7,
          description: 'Días de previsión (por defecto 3). "Mañana" es dias: 2.',
        },
        por_horas: {
          type: 'boolean',
          description: 'Si es true, devuelve las próximas 24 h cada 3 h en lugar de días.',
        },
      },
      required: ['lugar'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(PrevisionSchema, args);
      const r = await resolve(a.lugar, a.pais, signal);
      if ('text' in r) return r.text;
      const head = (tz: string | null): string =>
        `Previsión${a.por_horas ? ' por horas' : ''} para ${placeLabel(r.place)}, hora local${tz ? ` ${tz}` : ''}:`;
      const tail = [...(r.note ? [r.note] : []), ATTRIBUTION];

      if (a.por_horas) {
        const data = await forecast(
          r.place,
          'current=temperature_2m&hourly=temperature_2m,weather_code,precipitation_probability',
          2,
          signal,
        );
        const tz = strOrNull(data.timezone);
        const h = isRecord(data.hourly) ? data.hourly : {};
        const times = array(h.time).map(strOrNull);
        const temps = array(h.temperature_2m);
        const codes = array(h.weather_code);
        const probs = array(h.precipitation_probability);
        let nowLocal = strOrNull(isRecord(data.current) ? data.current.time : null);
        if (!nowLocal) {
          const off = numOrNull(data.utc_offset_seconds) ?? 0;
          nowLocal = new Date(now().getTime() + off * 1000).toISOString().slice(0, 16);
        }
        const since = nowLocal;
        let start = times.findIndex((t) => t !== null && t >= since);
        if (start < 0) start = 0;
        const rows: string[] = [];
        for (let i = start; i < times.length && i < start + 24; i += 3) {
          const t = times[i];
          if (!t) continue;
          rows.push(
            `· ${hourLabel(t)} — ${withUnit(int(numOrNull(temps[i])), '°C')} · ${weatherText(numOrNull(codes[i]))} · prob. lluvia ${withUnit(int(numOrNull(probs[i])), '%')}`,
          );
        }
        return [head(tz), ...rows, ...tail].join('\n');
      }

      const data = await forecast(
        r.place,
        'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
        a.dias ?? 3,
        signal,
      );
      const tz = strOrNull(data.timezone);
      const d = isRecord(data.daily) ? data.daily : {};
      const rows: string[] = [];
      array(d.time)
        .map(strOrNull)
        .forEach((day, i) => {
          if (!day) return;
          const tmin = numOrNull(array(d.temperature_2m_min)[i]);
          const tmax = numOrNull(array(d.temperature_2m_max)[i]);
          const temp = tmin === null || tmax === null ? NO_DATA : `${int(tmin)}–${int(tmax)} °C`;
          const sunrise = clock(strOrNull(array(d.sunrise)[i]));
          const sunset = clock(strOrNull(array(d.sunset)[i]));
          const sun = sunrise === NO_DATA || sunset === NO_DATA ? NO_DATA : `${sunrise}–${sunset}`;
          const rain = withUnit(dec1(numOrNull(array(d.precipitation_sum)[i])), 'mm');
          const prob = withUnit(int(numOrNull(array(d.precipitation_probability_max)[i])), '%');
          const wind = withUnit(int(numOrNull(array(d.wind_speed_10m_max)[i])), 'km/h');
          rows.push(
            `· ${dayLabel(day)}: ${weatherText(numOrNull(array(d.weather_code)[i]))} · ${temp} · lluvia ${rain} (prob. ${prob}) · viento máx. ${wind} · sol ${sun}`,
          );
        });
      return [head(tz), ...rows, ...tail].join('\n');
    },
  };

  return [buscarLugar, tiempoActual, prevision];
}

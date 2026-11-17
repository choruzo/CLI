/**
 * Previsión de AEMET para un municipio: XML públicos diaria y horaria, que
 * vienen en ISO-8859-15. Parser propio con regex, tolerante: un elemento vacío
 * es «sin dato», nunca 0. Caché en memoria de 30 min por municipio y tipo;
 * timeout de 15 s por petición. `fetch` inyectable, sin red en los tests.
 */
import { decodificarIso885915, elementos, primer, texto } from './xml.js';

export const DIARIA_URL = 'https://www.aemet.es/xml/municipios/localidad_';
export const HORARIA_URL = 'https://www.aemet.es/xml/municipios_h/localidad_h_';

const TIMEOUT_MS = 15_000;
const CACHE_MS = 30 * 60_000;
/** Tope de municipios en la caché en memoria (por municipio y tipo). */
const MAX_CACHE = 200;

/** Error cuando AEMET no publica previsión para un municipio (404). */
export class SinPrevision extends Error {
  constructor(ine: string) {
    super(`AEMET no publica previsión para el municipio ${ine}`);
  }
}

/** Error de AEMET no disponible (red, respuesta no válida). */
export class AemetNoDisponible extends Error {
  constructor(detalle: string) {
    super(`AEMET no responde: ${detalle}`);
  }
}

export interface EstadoCielo {
  descripcion: string;
  /** Código del tiempo presente del feed («45», «15n»); `null` si no trae. */
  valor: string | null;
}

export interface Valores {
  maxima: number | null;
  minima: number | null;
  /** Valores por hora (`dato hora="06"`); «sin dato» si la hora no viene. */
  dato: Record<string, number | null>;
}

export interface Dia {
  fecha: string;
  probPrecipitacion: Record<string, number | null>;
  cotaNieve: Record<string, number | null>;
  estadoCielo: Record<string, EstadoCielo>;
  viento: Record<string, { direccion: string | null; velocidad: number | null }>;
  rachaMax: Record<string, number | null>;
  temperatura: Valores;
  sensTermica: Valores;
  humedadRelativa: Valores;
  uvMax: number | null;
}

export interface Diaria {
  municipio: string;
  ine: string;
  /** Fecha de elaboración del feed, tal cual («2026-11-17T19:05:09»). */
  elaborado: string;
  dias: Dia[];
}

export interface DiaHorario {
  fecha: string;
  orto: string | null;
  ocaso: string | null;
  estadoCielo: Record<string, EstadoCielo>;
  precipitacion: Record<string, number | null>;
  /**
   * Horas con `Ip` («inapreciable») en la precipitación: llueve, pero tan poco que
   * AEMET no da litros. Ni 0 ni «sin dato»: `precipitacion[hora]` es `null` y esto
   * lo dice; quien lo enseñe tiene que decir «inapreciable».
   */
  precipitacionInapreciable: Record<string, boolean>;
  probPrecipitacion: Record<string, number | null>;
  probTormenta: Record<string, number | null>;
  nieve: Record<string, number | null>;
  probNieve: Record<string, number | null>;
  temperatura: Record<string, number | null>;
  sensTermica: Record<string, number | null>;
  humedadRelativa: Record<string, number | null>;
  viento: Record<string, { direccion: string | null; velocidad: number | null }>;
  rachaMax: Record<string, number | null>;
}

export interface Horaria {
  municipio: string;
  ine: string;
  elaborado: string;
  dias: DiaHorario[];
}

export interface AemetForecastOptions {
  /** Cliente HTTP inyectable (tests sin red). Por defecto, el `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Reloj inyectable para la caché. */
  now?: () => Date;
}

interface CacheEntry<T> {
  dato: T;
  ts: number;
}

/** Número del texto; `null` si vacío, no numérico o ausente («sin dato»). */
function numero(s: string | null | undefined): number | null {
  if (!s || !s.trim()) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

function textoO(valor: string): string | null {
  return valor.trim() === '' ? null : valor.trim();
}

/** Mapa `periodo` → valor numérico de los elementos de un `<dia>`. */
function porPeriodoNum(dia: string, nombre: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const e of elementos(dia, nombre)) {
    const p = e.attrs['periodo'];
    if (p) out[p] = numero(e.texto);
  }
  return out;
}

/** Mapa `periodo` → `true` en los tramos con `Ip` («inapreciable») de un elemento. */
function porPeriodoIp(dia: string, nombre: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const e of elementos(dia, nombre)) {
    const p = e.attrs['periodo'];
    if (p) out[p] = e.texto.trim().toLowerCase() === 'ip';
  }
  return out;
}

/** Mapa `periodo` → estado del cielo (descripción del atributo + código). */ function porPeriodoCielo(
  dia: string,
): Record<string, EstadoCielo> {
  const out: Record<string, EstadoCielo> = {};
  for (const e of elementos(dia, 'estado_cielo')) {
    const p = e.attrs['periodo'];
    if (p) out[p] = { descripcion: (e.attrs['descripcion'] ?? '').trim(), valor: textoO(e.texto) };
  }
  return out;
}

function porPeriodoViento(
  dia: string,
): Record<string, { direccion: string | null; velocidad: number | null }> {
  const out: Record<string, { direccion: string | null; velocidad: number | null }> = {};
  for (const e of elementos(dia, 'viento')) {
    const p = e.attrs['periodo'];
    if (p)
      out[p] = {
        direccion: texto(e.inner, 'direccion'),
        velocidad: numero(texto(e.inner, 'velocidad')),
      };
  }
  return out;
}

function valores(dia: string, nombre: string): Valores {
  const e = primer(dia, nombre);
  const dato: Record<string, number | null> = {};
  if (e) {
    for (const d of elementos(e.inner, 'dato')) {
      const hora = d.attrs['hora'];
      if (hora) dato[hora] = numero(d.texto);
    }
    return {
      maxima: numero(texto(e.inner, 'maxima')),
      minima: numero(texto(e.inner, 'minima')),
      dato,
    };
  }
  return { maxima: null, minima: null, dato };
}

/** Parsea el XML diario tal cual lo sirve AEMET. */
export function parseDiaria(xml: string, ine: string): Diaria {
  const dias: Dia[] = [];
  for (const e of elementos(xml, 'dia')) {
    const dia: Dia = {
      fecha: e.attrs['fecha'] ?? '',
      probPrecipitacion: porPeriodoNum(e.inner, 'prob_precipitacion'),
      cotaNieve: porPeriodoNum(e.inner, 'cota_nieve_prov'),
      estadoCielo: porPeriodoCielo(e.inner),
      viento: porPeriodoViento(e.inner),
      rachaMax: porPeriodoNum(e.inner, 'racha_max'),
      temperatura: valores(e.inner, 'temperatura'),
      sensTermica: valores(e.inner, 'sens_termica'),
      humedadRelativa: valores(e.inner, 'humedad_relativa'),
      uvMax: numero(texto(e.inner, 'uv_max')),
    };
    dias.push(dia);
  }
  return {
    municipio: texto(xml, 'nombre') ?? '',
    ine,
    elaborado: texto(xml, 'elaborado') ?? '',
    dias,
  };
}

/** Parsea el XML horario tal cual lo sirve AEMET. */
export function parseHoraria(xml: string, ine: string): Horaria {
  const dias: DiaHorario[] = [];
  for (const e of elementos(xml, 'dia')) {
    const d: DiaHorario = {
      fecha: e.attrs['fecha'] ?? '',
      orto: textoO(e.attrs['orto'] ?? ''),
      ocaso: textoO(e.attrs['ocaso'] ?? ''),
      estadoCielo: porPeriodoCielo(e.inner),
      precipitacion: porPeriodoNum(e.inner, 'precipitacion'),
      precipitacionInapreciable: porPeriodoIp(e.inner, 'precipitacion'),
      probPrecipitacion: porPeriodoNum(e.inner, 'prob_precipitacion'),
      probTormenta: porPeriodoNum(e.inner, 'prob_tormenta'),
      nieve: porPeriodoNum(e.inner, 'nieve'),
      probNieve: porPeriodoNum(e.inner, 'prob_nieve'),
      temperatura: porPeriodoNum(e.inner, 'temperatura'),
      sensTermica: porPeriodoNum(e.inner, 'sens_termica'),
      humedadRelativa: porPeriodoNum(e.inner, 'humedad_relativa'),
      viento: porPeriodoViento(e.inner),
      rachaMax: porPeriodoNum(e.inner, 'racha_max'),
    };
    dias.push(d);
  }
  return {
    municipio: texto(xml, 'nombre') ?? '',
    ine,
    elaborado: texto(xml, 'elaborado') ?? '',
    dias,
  };
}

export class AemetForecast {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry<Diaria | Horaria>>();

  constructor(opts: AemetForecastOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? ((): Date => new Date());
  }

  private async xml(url: string, ine: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new AemetNoDisponible(err instanceof Error ? err.message : String(err));
    }
    if (res.status === 404) throw new SinPrevision(ine);
    if (!res.ok)
      throw new AemetNoDisponible(`HTTP ${res.status} ${res.statusText} al pedir ${url}`);
    try {
      return decodificarIso885915(await res.arrayBuffer());
    } catch (err) {
      throw new AemetNoDisponible(err instanceof Error ? err.message : String(err));
    }
  }

  private async cached<T extends Diaria | Horaria>(
    tipo: string,
    ine: string,
    url: string,
    parse: (xml: string) => T,
  ): Promise<T> {
    const key = `${tipo}/${ine}`;
    const ts = this.now().getTime();
    const c = this.cache.get(key);
    if (c && ts - c.ts < CACHE_MS) return c.dato as T;
    const dato = parse(await this.xml(url, ine));
    if (dato.dias.length === 0)
      throw new AemetNoDisponible(`el XML de ${tipo} de ${ine} no trae días`);
    this.purgar(ts);
    this.cache.set(key, { dato, ts });
    return dato;
  }

  /** Tira las entradas caducadas y, si aun así sobran, las más antiguas (`Map` va por inserción). */
  private purgar(ts: number): void {
    for (const [k, v] of this.cache) if (ts - v.ts >= CACHE_MS) this.cache.delete(k);
    while (this.cache.size >= MAX_CACHE) {
      const primera = this.cache.keys().next().value;
      if (primera === undefined) break;
      this.cache.delete(primera);
    }
  }

  /** Entradas en la caché: diagnóstico y tests de que no crece sin límite. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Previsión diaria (`localidad_<ine>.xml`). */
  async diaria(ine: string): Promise<Diaria> {
    return this.cached('diaria', ine, `${DIARIA_URL}${ine}.xml`, (xml) => parseDiaria(xml, ine));
  }

  /** Previsión horaria (`localidad_h_<ine>.xml`). */
  async horaria(ine: string): Promise<Horaria> {
    return this.cached('horaria', ine, `${HORARIA_URL}${ine}.xml`, (xml) => parseHoraria(xml, ine));
  }
}

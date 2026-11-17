/**
 * Avisos Meteoalerta de AEMET: RSS de España (UTF-8), cada `<item>` enlaza a un
 * CAP 1.2 XML (se ignoran los `.tar.gz` y los enlaces a la web). De cada CAP se
 * parsea el `<info>` en es-ES: evento, cabecera, vigencia, severidad, nivel,
 * fenómeno, parámetro, probabilidad y las zonas Meteoalerta (6 dígitos).
 *
 * Los CAP se descargan en paralelo con un límite de 6 y se cachean por URL para
 * siempre (cada URL es inmutable: el RSS publica un CAP nuevo por aviso; al
 * refrescar se tiran las URLs que ya no están en el RSS, para que la caché no
 * crezca sin límite). Un CAP que falla (timeout, 503, 404) no tumba el resto:
 * se descarta, se cuenta en `noDescargados` y el RSS se cachea igual. El RSS se
 * refresca cada 5 min. El filtro por provincia usa el índice zona → provincia de
 * la tabla real (`zonasPorProvincia`), no el formato del código.
 *
 * `avisos()` devuelve también los **previstos** (`onset` futuro): separarlos es
 * cosa de quien los enseña. Solo se descartan los caducados con `expires`
 * legible; uno con `expires` vacío o ilegible se devuelve («fin sin dato»), nunca
 * se esconde.
 */
import { elementos, texto } from './xml.js';
import { zonasPorProvincia } from './municipios.js';

export const RSS_URL =
  'https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml';

const TIMEOUT_MS = 15_000;
const RSS_CACHE_MS = 5 * 60_000;
const CAPS_EN_PARALELO = 6;

export interface AemetAvisosOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Zonas Meteoalerta de una provincia (2 dígitos CPRO); por defecto, el índice de `municipios.json`. */
  zonasDeProvincia?: (provincia: string) => Set<string>;
}

export interface Aviso {
  /** Identificador del CAP. */
  id: string;
  /** URL del CAP, para la atribución y la auditoría. */
  url: string;
  event: string;
  headline: string;
  /** Inicio de vigencia, tal cual el CAP («2026-11-17T19:00:00+01:00»). */
  onset: string;
  /** Fin de vigencia, tal cual el CAP. */
  expires: string;
  /** Severidad CAP («Moderate», «Severe», «Extreme»). */
  severity: string;
  /** Nivel Meteoalerta («amarillo», «naranja», «rojo»); `null` si no viene. */
  nivel: string | null;
  /** Fenómeno («VI;Vientos»); `null` si no viene. */
  fenomeno: string | null;
  /** Parámetro («RM;Rachas máximas;80 km/h»); `null` si no viene. */
  parametro: string | null;
  /** Probabilidad («40%-70%»); `null` si no viene. */
  probabilidad: string | null;
  descripcion: string;
  areaDesc: string;
  /** Zonas Meteoalerta del `<area>` (geocodes de 6 dígitos). */
  zonas: string[];
}

export interface FiltroAvisos {
  /** Zona Meteoalerta de 6 dígitos (la del municipio en la tabla). */
  zona?: string;
  /** Provincia como código CPRO de 2 dígitos. */
  provincia?: string;
}

/** URLs de CAP del RSS: `<item><link>` que apuntan a un XML de `/cap/`. */
export function enlacesCap(rss: string): string[] {
  const urls: string[] = [];
  for (const item of elementos(rss, 'item')) {
    const link = texto(item.inner, 'link');
    if (link && link.includes('/cap/') && link.endsWith('.xml') && !urls.includes(link))
      urls.push(link);
  }
  return urls;
}

/** Valor de `<value>` del bloque cuyo `valueName` coincide (en `<parameter>` y `<eventCode>`). */
function valorDe(info: string, valueName: string): string | null {
  for (const nombre of ['parameter', 'eventCode']) {
    for (const bloque of elementos(info, nombre)) {
      if ((texto(bloque.inner, 'valueName') ?? '').trim() === valueName) {
        const valor = texto(bloque.inner, 'value');
        if (valor && valor.trim() !== '') return valor.trim();
      }
    }
  }
  return null;
}

/** Un `<info>` del CAP a `Aviso`; `null` si no está en es-ES o le falta lo imprescindible. `id` es el `<identifier>` del CAP (fuera del `<info>`). */
export function parseInfo(info: string, url: string, id: string): Aviso | null {
  const language = (texto(info, 'language') ?? '').trim();
  if (language !== 'es-ES') return null;
  const expires = (texto(info, 'expires') ?? '').trim();
  const zonas: string[] = [];
  for (const area of elementos(info, 'area')) {
    for (const geo of elementos(area.inner, 'geocode')) {
      if ((texto(geo.inner, 'valueName') ?? '').trim() !== 'AEMET-Meteoalerta zona') continue;
      const zona = (texto(geo.inner, 'value') ?? '').trim();
      if (/^\d{6}$/.test(zona) && !zonas.includes(zona)) zonas.push(zona);
    }
  }
  return {
    id,
    url,
    event: (texto(info, 'event') ?? '').trim(),
    headline: (texto(info, 'headline') ?? '').trim(),
    onset: (texto(info, 'onset') ?? '').trim(),
    expires,
    severity: (texto(info, 'severity') ?? '').trim(),
    nivel: valorDe(info, 'AEMET-Meteoalerta nivel'),
    fenomeno: valorDe(info, 'AEMET-Meteoalerta fenomeno'),
    parametro: valorDe(info, 'AEMET-Meteoalerta parametro'),
    probabilidad: valorDe(info, 'AEMET-Meteoalerta probabilidad'),
    descripcion: (texto(info, 'description') ?? '').trim(),
    areaDesc: (texto(info, 'areaDesc') ?? '').trim(),
    zonas,
  };
}

/** Todos los `Aviso` de un CAP (los `<info>` en es-ES). El `<identifier>` está fuera del `<info>`. */
export function parseCap(capXml: string, url: string): Aviso[] {
  const id = texto(capXml, 'identifier') ?? url;
  const out: Aviso[] = [];
  for (const info of elementos(capXml, 'info')) {
    const aviso = parseInfo(info.inner, url, id);
    if (aviso) out.push(aviso);
  }
  return out;
}

export class AemetAvisos {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly zonasDe: (provincia: string) => Set<string>;
  private rssCache: { avisos: Aviso[]; ts: number; noDescargados: number } | null = null;
  private readonly caps = new Map<string, Promise<Aviso[]>>();

  constructor(opts: AemetAvisosOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? ((): Date => new Date());
    this.zonasDe =
      opts.zonasDeProvincia ??
      ((provincia: string): Set<string> => zonasPorProvincia().get(provincia) ?? new Set());
  }

  /** CAP del último RSS que no se pudieron descargar (`0` si respondieron todos). */
  get noDescargados(): number {
    return this.rssCache?.noDescargados ?? 0;
  }

  /** URLs de CAP retenidas: diagnóstico y tests de que la caché no crece sin límite. */
  get capsCacheados(): number {
    return this.caps.size;
  }

  private async get(url: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(
        `AEMET no responde: ${err instanceof Error ? err.message : String(err)} al pedir ${url}`,
      );
    }
    if (!res.ok)
      throw new Error(`AEMET no responde: HTTP ${res.status} ${res.statusText} al pedir ${url}`);
    try {
      return await res.text();
    } catch (err) {
      throw new Error(
        `AEMET no responde: ${err instanceof Error ? err.message : String(err)} al pedir ${url}`,
      );
    }
  }

  private async cap(url: string): Promise<Aviso[]> {
    // Cada URL de CAP es inmutable: se pide una vez y se guarda la promesa.
    let enMarcha = this.caps.get(url);
    if (!enMarcha) {
      enMarcha = this.get(url)
        .then((xml) => parseCap(xml, url))
        .catch((err) => {
          this.caps.delete(url);
          throw err;
        });
      this.caps.set(url, enMarcha);
    }
    return enMarcha;
  }

  /**
   * Los avisos del RSS de España: los vigentes y también los previstos (`onset`
   * futuro). Solo se descartan los caducados con `expires` legible; uno con
   * `expires` vacío o ilegible se devuelve (quien lo enseña dice «fin sin dato»).
   *
   * Un CAP que falla no tumba la lista ni impide cachear el RSS: se cuenta en
   * `noDescargados` y se sigue con los demás.
   */
  async avisos(): Promise<Aviso[]> {
    const ahora = this.now();
    if (this.rssCache && ahora.getTime() - this.rssCache.ts < RSS_CACHE_MS)
      return this.rssCache.avisos;
    const rss = await this.get(RSS_URL);
    const urls = enlacesCap(rss);
    const avisos: Aviso[] = [];
    let noDescargados = 0;
    for (let i = 0; i < urls.length; i += CAPS_EN_PARALELO) {
      const bloque = await Promise.allSettled(
        urls.slice(i, i + CAPS_EN_PARALELO).map((u) => this.cap(u)),
      );
      for (const r of bloque) {
        if (r.status === 'fulfilled') avisos.push(...r.value);
        else noDescargados++;
      }
    }
    this.olvidarCaps(urls);
    const vigentes = avisos.filter((a) => {
      const t = Date.parse(a.expires);
      // Sin `expires` legible no se descarta: es «fin sin dato», no un caducado.
      return !Number.isFinite(t) || t > ahora.getTime();
    });
    this.rssCache = { avisos: vigentes, ts: ahora.getTime(), noDescargados };
    return vigentes;
  }

  /** Tira de la caché los CAP que ya no están en el RSS (cada URL es inmutable). */
  private olvidarCaps(urls: readonly string[]): void {
    const vigentes = new Set(urls);
    for (const url of [...this.caps.keys()]) if (!vigentes.has(url)) this.caps.delete(url);
  }

  /**
   * Los avisos (vigentes y previstos) que afectan a la zona Meteoalerta dada o a
   * alguna zona de la provincia dada (código CPRO de 2 dígitos, índice de la
   * tabla real). Sin filtro, devuelve todos.
   */
  async avisosPara(filtro: FiltroAvisos = {}): Promise<Aviso[]> {
    const todos = await this.avisos();
    const { zona, provincia } = filtro;
    if (!zona && !provincia) return todos;
    return todos.filter((a) => {
      if (zona && !a.zonas.includes(zona)) return false;
      if (provincia) {
        const zonas = this.zonasDe(provincia);
        if (!a.zonas.some((z) => zonas.has(z))) return false;
      }
      return true;
    });
  }
}

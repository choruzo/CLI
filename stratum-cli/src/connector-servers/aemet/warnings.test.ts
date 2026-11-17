/**
 * Tests de `warnings.ts` con las fixtures reales: `esp.xml` (el RSS) y
 * `cap.xml` (un CAP de vientos de A Mariña), servidos por un `fetch` falso con
 * reloj fijo; la caché del RSS de 5 min y la inmutabilidad de los CAP.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AemetAvisos, enlacesCap, parseCap, RSS_URL } from './warnings.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const espXml = readFileSync(join(FIXTURES, 'esp.xml'), 'utf8');
const capXml = readFileSync(join(FIXTURES, 'cap.xml'), 'utf8');

const AHORA = new Date('2026-11-17T19:30:00Z');

/** `fetch` falso: el RSS y un CAP por URL; cuenta peticiones por tipo. */
function fetchFalso(): { fetchImpl: typeof fetch; rss: number; caps: number } {
  let rss = 0;
  let caps = 0;
  const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u === RSS_URL) {
      rss++;
      return new Response(espXml, { status: 200 });
    }
    caps++;
    return new Response(capXml, { status: 200 });
  }) as typeof fetch;
  return {
    fetchImpl,
    get rss(): number {
      return rss;
    },
    get caps(): number {
      return caps;
    },
  };
}

describe('enlacesCap', () => {
  it('extrae solo los `<link>` a CAP XML, sin duplicados ni .tar.gz ni la web', () => {
    const urls = enlacesCap(espXml);
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) {
      expect(u).toContain('/cap/');
      expect(u.endsWith('.xml')).toBe(true);
      expect(u.endsWith('.tar.gz')).toBe(false);
    }
    expect(new Set(urls).size).toBe(urls.length);
    // Un RSS sintético con los tres tipos de enlace: solo el CAP pasa.
    const sintetico = `<rss><channel>
      <link>https://www.aemet.es/es/eltiempo/prediccion/avisos</link>
      <item><link>https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/A.xml</link></item>
      <item><link>https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/B.tar.gz</link></item>
      <item><link>https://www.aemet.es/es/eltiempo/prediccion/avisos/hoy</link></item>
      <item><link>https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/A.xml</link></item>
    </channel></rss>`;
    expect(enlacesCap(sintetico)).toEqual([
      'https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/A.xml',
    ]);
  });
});

describe('parseCap (fixture real: vientos amarillos en A Mariña)', () => {
  const avisos = parseCap(
    capXml,
    'https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/X.xml',
  );

  it('parsea el <info> en es-ES con nivel, fenómeno, parámetro y probabilidad', () => {
    expect(avisos).toHaveLength(1);
    const a = avisos[0]!;
    expect(a.id).toContain('712701VIRM1823');
    expect(a.event).toBe('Aviso de vientos de nivel amarillo');
    expect(a.headline).toBe('Aviso de vientos de nivel amarillo. A Mariña');
    expect(a.severity).toBe('Moderate');
    expect(a.nivel).toBe('amarillo');
    expect(a.fenomeno).toBe('VI;Vientos');
    expect(a.parametro).toBe('RM;Rachas máximas;80 km/h');
    expect(a.probabilidad).toBe('40%-70%');
    expect(a.descripcion).toContain('Rachas máximas: 80 km/h');
    expect(a.areaDesc).toBe('A Mariña');
    expect(a.onset).toBe('2026-11-17T19:00:00+01:00');
    expect(a.expires).toBe('2026-11-18T23:59:59+01:00');
    expect(a.zonas).toEqual(['712701']);
  });

  it('un <info> que no es es-ES se ignora', () => {
    const cap = capXml.replace('<language>es-ES</language>', '<language>gl-ES</language>');
    expect(parseCap(cap, 'u')).toEqual([]);
  });
});

describe('AemetAvisos', () => {
  it('descarga el RSS, los CAP en paralelo y filtra por zona y provincia', async () => {
    const f = fetchFalso();
    const avisos = new AemetAvisos({ fetchImpl: f.fetchImpl, now: (): Date => new Date(AHORA) });
    const todos = await avisos.avisos();
    expect(todos.length).toBeGreaterThan(0);
    for (const a of todos) expect(Date.parse(a.expires)).toBeGreaterThan(AHORA.getTime());

    const porZona = await avisos.avisosPara({ zona: '712701' });
    expect(porZona.length).toBeGreaterThan(0);
    expect(porZona.every((a) => a.zonas.includes('712701'))).toBe(true);

    const porProvincia = await avisos.avisosPara({ provincia: '27' }); // Lugo: A Mariña
    expect(porProvincia.length).toBeGreaterThan(0);
    await expect(avisos.avisosPara({ provincia: '28' })).resolves.toEqual([]);
    await expect(avisos.avisosPara({ zona: '719999' })).resolves.toEqual([]);

    // El RSS se pidió una vez; los CAP, tantas veces como URLs distintas.
    expect(f.rss).toBe(1);
    expect(f.caps).toBe(enlacesCap(espXml).length);
  });

  it('el RSS se refresca a los 5 min, pero los CAP (inmutables) no se repiden', async () => {
    let reloj = AHORA.getTime();
    const f = fetchFalso();
    const avisos = new AemetAvisos({ fetchImpl: f.fetchImpl, now: (): Date => new Date(reloj) });
    await avisos.avisos();
    reloj += 4 * 60_000;
    await avisos.avisos();
    expect(f.rss).toBe(1);
    reloj += 2 * 60_000; // 6 min desde la primera
    await avisos.avisos();
    expect(f.rss).toBe(2);
    expect(f.caps).toBe(enlacesCap(espXml).length);
  });

  it('los avisos expirados no se devuelven', async () => {
    const f = fetchFalso();
    const avisos = new AemetAvisos({
      fetchImpl: f.fetchImpl,
      now: (): Date => new Date('2026-11-19T12:00:00Z'),
    });
    await expect(avisos.avisos()).resolves.toEqual([]);
  });

  it('si el RSS falla, el error lo dice', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response('', { status: 503 })) as typeof fetch;
    const avisos = new AemetAvisos({ fetchImpl, now: (): Date => new Date(AHORA) });
    await expect(avisos.avisos()).rejects.toThrow(/AEMET no responde/);
  });
});

describe('AEMET: un CAP que falla, la caché del RSS y su límite', () => {
  /** `fetch` falso que sirve el RSS y falla solo en las URLs indicadas. */
  function fetchConFallos(fallidos: Set<string>): {
    fetchImpl: typeof fetch;
    rssPeticiones: () => number;
  } {
    let rssPeticiones = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === RSS_URL) {
        rssPeticiones++;
        return new Response(espXml, { status: 200 });
      }
      if (fallidos.has(u)) return new Response('', { status: 503 });
      return new Response(capXml, { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, rssPeticiones: () => rssPeticiones };
  }

  it('un CAP que falla no tumba los demás: se descarta y se cuenta', async () => {
    const urls = enlacesCap(espXml);
    const { fetchImpl } = fetchConFallos(new Set([urls[0]!]));
    const avisos = new AemetAvisos({ fetchImpl, now: (): Date => new Date(AHORA) });
    const lista = await avisos.avisos();
    expect(lista.length).toBeGreaterThan(0);
    expect(avisos.noDescargados).toBe(1);
    // El CAP que falló no se queda cacheado como promesa rechazada.
    expect(avisos.capsCacheados).toBe(urls.length - 1);
  });

  it('el RSS se cachea aunque algún CAP haya fallado', async () => {
    const urls = enlacesCap(espXml);
    const f = fetchConFallos(new Set([urls[0]!]));
    const avisos = new AemetAvisos({ fetchImpl: f.fetchImpl, now: (): Date => new Date(AHORA) });
    await avisos.avisos();
    await avisos.avisos();
    expect(f.rssPeticiones()).toBe(1);
    expect(avisos.noDescargados).toBe(1);
  });

  it('al refrescar el RSS se olvidan los CAP que ya no están', async () => {
    const urls = enlacesCap(espXml);
    let reloj = new Date(AHORA).getTime();
    // El segundo RSS solo trae el segundo CAP.
    let rss = espXml;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === RSS_URL) return new Response(rss, { status: 200 });
      return new Response(capXml, { status: 200 });
    }) as typeof fetch;
    const avisos = new AemetAvisos({ fetchImpl, now: (): Date => new Date(reloj) });
    await avisos.avisos();
    expect(avisos.capsCacheados).toBe(urls.length);
    rss = `<rss><channel><item><link>${urls[1]!}</link></item></channel></rss>`;
    reloj += 6 * 60_000; // el RSS se refresca a los 5 min
    await avisos.avisos();
    expect(avisos.capsCacheados).toBe(1);
  });
});

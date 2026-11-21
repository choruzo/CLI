import { describe, expect, it } from 'vitest';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { createGrocyClient, parseBaseUrl } from './client.js';

const KEY = 'clave-SECRETA-123';
const URL_OK = 'http://grocy.casa:9283/api';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

function failing(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as typeof fetch;
}

function withCause(cause: Error): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = cause;
  return e;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('se esperaba un fallo');
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe('parseBaseUrl', () => {
  it('añade /api si falta, lo respeta si está y quita la barra final', () => {
    expect(parseBaseUrl('http://casa:9283')?.href).toBe('http://casa:9283/api');
    expect(parseBaseUrl('http://casa:9283/')?.href).toBe('http://casa:9283/api');
    expect(parseBaseUrl('http://casa:9283/api')?.href).toBe('http://casa:9283/api');
    expect(parseBaseUrl('http://casa:9283/api/')?.href).toBe('http://casa:9283/api');
    expect(parseBaseUrl('  https://casa/grocy  ')?.href).toBe('https://casa/grocy/api');
  });

  it('rechaza otro esquema, credenciales, query, hash, vacío e inválido', () => {
    expect(parseBaseUrl('ftp://casa/api')).toBeNull();
    expect(parseBaseUrl('http://user:pass@casa/api')).toBeNull();
    expect(parseBaseUrl('http://user@casa/api')).toBeNull();
    expect(parseBaseUrl('http://casa/api?x=1')).toBeNull();
    expect(parseBaseUrl('http://casa/api#h')).toBeNull();
    expect(parseBaseUrl('')).toBeNull();
    expect(parseBaseUrl(undefined)).toBeNull();
    expect(parseBaseUrl('no es una url')).toBeNull();
  });
});

describe('createGrocyClient', () => {
  it('devuelve null sin URL, sin clave o con una URL que no vale', () => {
    const f = failing(new Error('no se llama'));
    expect(createGrocyClient({ fetch: f, apiKey: KEY })).toBeNull();
    expect(createGrocyClient({ fetch: f, url: URL_OK })).toBeNull();
    expect(createGrocyClient({ fetch: f, url: URL_OK, apiKey: '   ' })).toBeNull();
    expect(createGrocyClient({ fetch: f, url: 'ftp://x', apiKey: KEY })).toBeNull();
  });

  it('hace GET con la clave en la cabecera, sin redirecciones, y con la query', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({ ok: true }));
    const c = createGrocyClient({ fetch: f, url: 'http://grocy.casa:9283', apiKey: KEY })!;
    expect(c.host).toBe('grocy.casa:9283');
    expect(await c.get('/stock/volatile', { due_soon_days: '7' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://grocy.casa:9283/api/stock/volatile?due_soon_days=7');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.redirect).toBe('error');
    expect((calls[0]!.init.headers as Record<string, string>)['GROCY-API-KEY']).toBe(KEY);
  });

  it('solo alcanza rutas de la lista de lectura y no llama a fetch con las demás', async () => {
    const { fetch: f, calls } = fakeFetch(() => json([]));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    for (const path of [
      '/stock/add',
      '/stock/products/1/consume',
      '/objects/api_keys',
      '/objects/products/1',
      '/../x',
      '/stock?x=1',
      'stock',
      '',
    ]) {
      expect(await failure(c.get(path))).toBe('Ruta de Grocy no permitida.');
    }
    expect(calls).toHaveLength(0);
    // Y las permitidas sí pasan.
    await c.get('/system/info');
    await c.get('/stock');
    await c.get('/recipes/fulfillment');
    await c.get('/objects/recipes_pos');
    expect(calls).toHaveLength(4);
  });

  it('401 con una URL normal habla de la clave rechazada y del comando de ajuste', async () => {
    const { fetch: f } = fakeFetch(() => new Response('', { status: 401 }));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    const msg = await failure(c.get('/stock'));
    expect(msg).toContain('rechazó la clave de API (HTTP 401)');
    expect(msg).toContain('stratum connectors setup grocy');
    expect(msg).not.toContain('Ingress');
  });

  it('401 con una URL de Ingress explica el Ingress y el puerto publicado', async () => {
    const { fetch: f } = fakeFetch(() => new Response('', { status: 401 }));
    const c = createGrocyClient({
      fetch: f,
      url: 'http://ha:8123/api/hassio_ingress/abc',
      apiKey: KEY,
    })!;
    const msg = await failure(c.get('/stock'));
    expect(msg).toContain('Ingress de Home Assistant');
    expect(msg).toContain('puerto publicado');
    expect(msg).not.toContain('rechazó la clave');
  });

  it('la clave nunca aparece en un mensaje de error', async () => {
    const { fetch: f } = fakeFetch(() => json({ error_message: `bad ${KEY}` }, 500));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    const msg = await failure(c.get('/stock'));
    expect(msg).toContain('HTTP 500');
    expect(msg).toContain('bad ***');
    expect(msg).not.toContain(KEY);
  });

  it('un 500 con cuerpo que no es JSON no enseña el cuerpo', async () => {
    const { fetch: f } = fakeFetch(() => new Response(`<html>${KEY}</html>`, { status: 500 }));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    expect(await failure(c.get('/stock'))).toBe('Grocy respondió HTTP 500.');
  });

  it('ENOTFOUND dice que el nombre no se resuelve', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const c = createGrocyClient({ fetch: failing(withCause(cause)), url: URL_OK, apiKey: KEY })!;
    const msg = await failure(c.get('/stock'));
    expect(msg).toContain('No se resuelve el nombre grocy.casa:9283');
    expect(msg).toContain('GROCY_URL');
  });

  it('una redirección se avisa y no se sigue', async () => {
    const c = createGrocyClient({
      fetch: failing(withCause(new Error('unexpected redirect'))),
      url: URL_OK,
      apiKey: KEY,
    })!;
    expect(await failure(c.get('/stock'))).toContain('respondió con una redirección');
  });

  it('plazo agotado, cancelación y fallo de red genérico', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    const mk = (e: Error) =>
      createGrocyClient({ fetch: failing(e), url: URL_OK, apiKey: KEY })!.get('/stock');
    expect(await failure(mk(timeout))).toContain('tiempo de espera agotado');
    expect(await failure(mk(abort))).toBe('Consulta a Grocy cancelada.');
    const generic = await failure(mk(new TypeError('fetch failed')));
    expect(generic).toContain('No se llega a Grocy en grocy.casa:9283');
    expect(generic).toContain('puerto tiene que estar publicado');
  });

  it('un JSON que no lo es es una respuesta no válida', async () => {
    const { fetch: f } = fakeFetch(() => new Response('esto no es json'));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    expect(await failure(c.get('/stock'))).toContain('no válida');
  });

  it('objects exige una lista y descarta lo que no son registros', async () => {
    const { fetch: f } = fakeFetch((url) =>
      url.endsWith('/objects/products') ? json({ no: 'lista' }) : json([{ id: 1 }, 5, null, [1]]),
    );
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY })!;
    expect(await failure(c.objects('products'))).toContain('no válida (products)');
    expect(await c.objects('locations')).toEqual([{ id: 1 }]);
  });
});

describe('caché del catálogo', () => {
  it('las tablas de catálogo se piden una vez y caducan a los 5 minutos', async () => {
    let t = 1_000_000;
    const { fetch: f, calls } = fakeFetch(() => json([{ id: 1 }]));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY, now: () => t })!;
    await c.objects('products');
    await c.objects('products');
    expect(calls).toHaveLength(1);
    // Otra tabla tiene su propia entrada.
    await c.objects('locations');
    expect(calls).toHaveLength(2);
    t += 299_999;
    await c.objects('products');
    expect(calls).toHaveLength(2);
    t += 1;
    await c.objects('products');
    expect(calls).toHaveLength(3);
  });

  it('las tablas que cambian (recetas) no se guardan nunca', async () => {
    const { fetch: f, calls } = fakeFetch(() => json([{ id: 1 }]));
    const c = createGrocyClient({ fetch: f, url: URL_OK, apiKey: KEY, now: () => 0 })!;
    await c.objects('recipes');
    await c.objects('recipes');
    expect(calls).toHaveLength(2);
    await c.objects('shopping_list');
    await c.objects('shopping_list');
    expect(calls).toHaveLength(4);
  });
});

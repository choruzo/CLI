import { describe, expect, it } from 'vitest';
import { ToolUserError, type ConnectorTool, type ToolOutput } from '../lib/mcp-stdio.js';
import { createHaClient, parseBaseUrl } from './client.js';
import { createHomeAssistantTools } from './tools.js';

const TOKEN = 'tok-SECRETO-123';

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

function withCause(code: string): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return e;
}

function estado(tools: ConnectorTool<string | ToolOutput>[]): ConnectorTool<string | ToolOutput> {
  return tools.find((t) => t.name === 'ha_estado')!;
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('no lanzó');
}

describe('parseBaseUrl', () => {
  it('acepta http y https, con puerto y prefijo', () => {
    expect(parseBaseUrl('http://homeassistant.home:8123')?.host).toBe('homeassistant.home:8123');
    expect(parseBaseUrl('https://casa.example/ha/')?.pathname).toBe('/ha/');
  });
  it('rechaza esquemas, credenciales, query y fragmento', () => {
    for (const u of [
      'ftp://x',
      'file:///etc',
      'http://u:p@x',
      'http://x?a=1',
      'http://x#f',
      'nada',
      '',
      undefined,
    ]) {
      expect(parseBaseUrl(u)).toBeNull();
    }
  });
});

describe('cliente de Home Assistant', () => {
  it('envía el token, redirect: error y un plazo, y respeta el prefijo de ruta', async () => {
    const f = fakeFetch(() => new Response('[]'));
    const c = createHaClient({ fetch: f.fetch, url: 'https://casa.example/ha/', token: TOKEN })!;
    await c.getJson('/api/states');
    expect(f.calls[0]!.url).toBe('https://casa.example/ha/api/states');
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(f.calls[0]!.init.redirect).toBe('error');
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('no llama a rutas fuera de /api/', async () => {
    const f = fakeFetch(() => new Response('[]'));
    const c = createHaClient({ fetch: f.fetch, url: 'http://ha:8123', token: TOKEN })!;
    await expect(c.getJson('/auth/token')).rejects.toBeInstanceOf(ToolUserError);
    expect(f.calls).toHaveLength(0);
  });

  it('sin URL o token devuelve null', () => {
    const f = fakeFetch(() => new Response('[]'));
    expect(createHaClient({ fetch: f.fetch, token: TOKEN })).toBeNull();
    expect(createHaClient({ fetch: f.fetch, url: 'http://ha' })).toBeNull();
    expect(createHaClient({ fetch: f.fetch, url: 'ftp://ha', token: TOKEN })).toBeNull();
  });

  it('cachea config y áreas 5 min y no cachea un fallo de áreas', async () => {
    let t = 0;
    let templateFails = true;
    const f = fakeFetch((url) => {
      if (url.endsWith('/api/config')) return new Response('{"location_name":"Casa"}');
      if (url.endsWith('/api/template')) {
        return templateFails
          ? new Response('x', { status: 500 })
          : new Response('light.a|Salón\nlight.b|\n');
      }
      return new Response('[]');
    });
    const c = createHaClient({ fetch: f.fetch, url: 'http://ha', token: TOKEN, now: () => t })!;
    await c.getConfig();
    await c.getConfig();
    expect(f.calls.filter((x) => x.url.endsWith('/config'))).toHaveLength(1);
    t = 5 * 60_000 + 1;
    await c.getConfig();
    expect(f.calls.filter((x) => x.url.endsWith('/config'))).toHaveLength(2);

    expect(await c.getAreas()).toBeNull();
    templateFails = false;
    const areas = await c.getAreas();
    expect([...areas!.entries()]).toEqual([['light.a', 'Salón']]);
    await c.getAreas();
    expect(f.calls.filter((x) => x.url.endsWith('/template'))).toHaveLength(2);
  });
});

describe('errores para el agente (y el token nunca sale)', () => {
  const cases: Array<{ name: string; fetch: typeof fetch; match: RegExp }> = [
    {
      name: '401',
      fetch: fakeFetch(() => new Response('', { status: 401 })).fetch,
      match: /rechazó el token.*stratum connectors setup home-assistant/,
    },
    {
      name: '403',
      fetch: fakeFetch(() => new Response('', { status: 403 })).fetch,
      match: /rechazó el token/,
    },
    {
      name: 'ENOTFOUND',
      fetch: failing(withCause('ENOTFOUND')),
      match: /No se resuelve el nombre ha\.casa.*homeassistant\.home/,
    },
    {
      name: 'ECONNREFUSED',
      fetch: failing(withCause('ECONNREFUSED')),
      match: /No se llega a Home Assistant en ha\.casa/,
    },
    {
      name: 'EHOSTUNREACH',
      fetch: failing(withCause('EHOSTUNREACH')),
      match: /No se llega a Home Assistant en ha\.casa/,
    },
    {
      name: 'timeout',
      fetch: failing(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      match: /No se llega a Home Assistant en ha\.casa.*tiempo de espera/,
    },
    {
      name: 'redirección',
      fetch: failing(
        Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }),
      ),
      match: /redirección/,
    },
    {
      name: 'HTTP 500 con message que contiene el token',
      fetch: fakeFetch(
        () =>
          new Response(JSON.stringify({ message: `boom ${TOKEN} ${'x'.repeat(400)}` }), {
            status: 500,
          }),
      ).fetch,
      match: /HTTP 500: boom \*\*\* x+/,
    },
    {
      name: 'HTTP 502 con cuerpo HTML',
      fetch: fakeFetch(() => new Response(`<html>${TOKEN}</html>`, { status: 502 })).fetch,
      match: /^Home Assistant respondió HTTP 502\.$/,
    },
    {
      name: 'respuesta no JSON',
      fetch: fakeFetch(() => new Response('<html>')).fetch,
      match: /no válida/,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const tools = createHomeAssistantTools({
        fetch: c.fetch,
        url: 'http://ha.casa:8123',
        token: TOKEN,
      });
      const msg = await messageOf(estado(tools).handler({ entity_id: 'light.a' }));
      expect(msg).toMatch(c.match);
      expect(msg).not.toContain(TOKEN);
      expect(msg.length).toBeLessThan(400);
    });
  }

  it('404 de una entidad remite a ha_buscar', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('/api/config') ? new Response('{}') : new Response('{}', { status: 404 }),
    );
    const tools = createHomeAssistantTools({ fetch: f.fetch, url: 'http://ha', token: TOKEN });
    const msg = await messageOf(estado(tools).handler({ entity_id: 'light.nada' }));
    expect(msg).toBe('La entidad light.nada no existe: usa ha_buscar.');
  });

  it('sin configurar, cada tool dice cómo configurarlo', async () => {
    const f = fakeFetch(() => new Response('[]'));
    for (const cfg of [
      {},
      { url: 'http://ha' },
      { token: TOKEN },
      { url: 'ftp://ha', token: TOKEN },
    ]) {
      const tools = createHomeAssistantTools({ fetch: f.fetch, ...cfg });
      for (const t of tools) {
        const msg = await messageOf(t.handler({}));
        expect(msg).toContain('Home Assistant no está configurado');
        expect(msg).toContain('stratum connectors setup home-assistant');
        expect(msg).not.toContain(TOKEN);
      }
    }
    expect(f.calls).toHaveLength(0);
  });
});

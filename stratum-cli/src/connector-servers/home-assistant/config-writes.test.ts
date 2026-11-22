import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parseConnectorManifest, forcedToolsOf } from '../../connectors/manifest.js';
import { ToolUserError, type ConnectorTool, type ToolOutput } from '../lib/mcp-stdio.js';
import { createHaClient } from './client.js';
import { createHomeAssistantTools } from './tools.js';

const TOKEN = 'tok-SECRETO-123';
const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'connectors',
  'home-assistant',
  'connector.json',
);

const AUTOMATION = {
  alias: 'Luz pasillo',
  description: 'Enciende la luz al detectar movimiento',
  triggers: [{ trigger: 'state', entity_id: 'binary_sensor.pasillo', to: 'on' }],
  conditions: [{ condition: 'sun', after: 'sunset' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.pasillo' } }],
  mode: 'single',
};
const SCRIPT = {
  alias: 'Buenas noches',
  sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.salon' } }],
};
const SCENE = { name: 'Cine', entities: { 'light.salon': { state: 'off' } } };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Options {
  version?: string | null;
  /** Rutas de configuración que existen (GET 200). */
  exists?: string[];
  /** Respuesta de cada POST/DELETE, por orden; sin ella, `{"result":"ok"}`. */
  reply?: (call: Call, n: number) => Response | Error;
  states?: unknown[];
}

const okResponse = (): Response => new Response(JSON.stringify({ result: 'ok' }));

function setup(opts: Options = {}) {
  const calls: Call[] = [];
  let writes = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path: url.pathname, body };
    calls.push(call);
    if (url.pathname === '/api/config') {
      return new Response(
        JSON.stringify(opts.version === null ? {} : { version: opts.version ?? '2026.11.2' }),
      );
    }
    if (url.pathname === '/api/states') return new Response(JSON.stringify(opts.states ?? []));
    if (method === 'GET' && url.pathname.startsWith('/api/config/')) {
      return opts.exists?.includes(url.pathname)
        ? new Response(JSON.stringify({ alias: 'Existente', name: 'Existente' }))
        : new Response(JSON.stringify({ message: 'Resource not found' }), { status: 404 });
    }
    if (method === 'POST' || method === 'DELETE') {
      const r = opts.reply ? opts.reply(call, writes++) : okResponse();
      if (r instanceof Error) throw r;
      return r;
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const tools = createHomeAssistantTools({
    fetch: f,
    url: 'http://ha.casa:8123',
    token: TOKEN,
    sleep: async () => {},
  });
  const get = (name: string): ConnectorTool<string | ToolOutput> =>
    tools.find((t) => t.name === name)!;
  const writesOf = (): Call[] => calls.filter((c) => c.method !== 'GET');
  return { get, calls, writesOf };
}

const textOf = (out: string | ToolOutput): string => (typeof out === 'string' ? out : out.text);

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('no lanzó');
}

function withCause(code: string): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return e;
}

const AUTO_PATH = '/api/config/automation/config/stratum_luz_pasillo';
const autoState = (state: string) => ({
  entity_id: 'automation.stratum_luz_pasillo',
  state,
  attributes: { id: 'stratum_luz_pasillo', friendly_name: 'Luz pasillo' },
});

const propose = (over: Record<string, unknown> = {}) => ({
  accion: 'crear',
  tipo: 'automatizacion',
  id: 'stratum_luz_pasillo',
  config: AUTOMATION,
  ...over,
});

describe('ha_proponer_automatizacion', () => {
  it('crear deshabilitada: primero con initial_state false y luego sin él', async () => {
    const s = setup({ states: [autoState('off')] });
    const out = textOf(await s.get('ha_proponer_automatizacion').handler(propose()));
    const w = s.writesOf();
    expect(w).toHaveLength(2);
    expect(w.map((c) => [c.method, c.path])).toEqual([
      ['POST', AUTO_PATH],
      ['POST', AUTO_PATH],
    ]);
    expect(w[0]!.body).toEqual({ ...AUTOMATION, initial_state: false });
    expect(w[1]!.body).toEqual(AUTOMATION);
    expect(out).toContain('Creada la automatización «Luz pasillo» (stratum_luz_pasillo)');
    expect(out).toContain('entity_id: automation.stratum_luz_pasillo');
    expect(out).toContain('Estado: desactivada');
    expect(out).toContain('Para activarla: ha_encender con automation.stratum_luz_pasillo');
    expect(out).not.toContain(TOKEN);
  });

  it('crear habilitada: un solo POST sin initial_state', async () => {
    const s = setup({ states: [autoState('on')] });
    const out = textOf(
      await s.get('ha_proponer_automatizacion').handler(propose({ habilitada: true })),
    );
    expect(s.writesOf()).toHaveLength(1);
    expect(s.writesOf()[0]!.body).toEqual(AUTOMATION);
    expect(out).toContain('Estado: activada');
    expect(out).not.toContain('Para activarla');
  });

  it('modificar: un POST sin initial_state y conserva el estado', async () => {
    const s = setup({ exists: [AUTO_PATH], states: [autoState('on')] });
    const out = textOf(
      await s.get('ha_proponer_automatizacion').handler(propose({ accion: 'modificar' })),
    );
    expect(s.writesOf()).toHaveLength(1);
    expect(s.writesOf()[0]!.body).toEqual(AUTOMATION);
    expect(out).toContain('Modificada la automatización');
    expect(out).toContain('Conserva su estado (activada)');
  });

  it('sin la entidad todavía: lo dice y no inventa el estado', async () => {
    const out = textOf(
      await setup()
        .get('ha_proponer_automatizacion')
        .handler(propose({ habilitada: true })),
    );
    expect(out).toContain('sin dato: aún no aparece');
    expect(out).toContain('Estado: sin dato');
  });

  it('script: POST a su ruta, entidad script.<id>', async () => {
    const s = setup({
      states: [{ entity_id: 'script.stratum_noches', state: 'off', attributes: {} }],
    });
    const out = textOf(
      await s
        .get('ha_proponer_automatizacion')
        .handler({ accion: 'crear', tipo: 'script', id: 'stratum_noches', config: SCRIPT }),
    );
    expect(s.writesOf()).toHaveLength(1);
    expect(s.writesOf()[0]).toMatchObject({
      method: 'POST',
      path: '/api/config/script/config/stratum_noches',
      body: SCRIPT,
    });
    expect(out).toContain('Creada el script «Buenas noches»');
    expect(out).toContain('entity_id: script.stratum_noches');
  });

  it('escena: POST a su ruta, entidad por attributes.id y no se activa', async () => {
    const s = setup({
      states: [
        {
          entity_id: 'scene.cine',
          state: 'unknown',
          attributes: { id: 'stratum_cine' },
        },
      ],
    });
    const out = textOf(
      await s
        .get('ha_proponer_automatizacion')
        .handler({ accion: 'crear', tipo: 'escena', id: 'stratum_cine', config: SCENE }),
    );
    expect(s.writesOf()[0]).toMatchObject({
      path: '/api/config/scene/config/stratum_cine',
      body: SCENE,
    });
    expect(out).toContain('entity_id: scene.cine');
    expect(out).toContain('Crearla no la activa');
  });

  it('crear cuando ya existe: no escribe', async () => {
    const s = setup({ exists: [AUTO_PATH] });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toMatch(/ya existe: usa accion modificar/);
    expect(s.writesOf()).toHaveLength(0);
  });

  it('modificar cuando no existe: no escribe', async () => {
    const s = setup();
    const msg = await failure(
      s.get('ha_proponer_automatizacion').handler(propose({ accion: 'modificar' })),
    );
    expect(msg).toMatch(/no existe: usa accion crear/);
    expect(s.writesOf()).toHaveLength(0);
  });

  it('un 400 enseña el mensaje de HA y dice que no se cambió nada', async () => {
    const s = setup({
      reply: () =>
        new Response(
          JSON.stringify({ message: `Message malformed: Invalid trigger 'nope' ${TOKEN}` }),
          { status: 400 },
        ),
    });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('Home Assistant rechazó la configuración');
    expect(msg).toContain("Invalid trigger 'nope'");
    expect(msg).toContain('No se cambió nada');
    expect(msg).not.toContain(TOKEN);
    expect(s.writesOf()).toHaveLength(1);
  });

  it('una respuesta que no es exactamente {"result":"ok"} no se da por buena y no sigue', async () => {
    const s = setup({ reply: () => new Response(JSON.stringify({ result: 'ok', extra: 1 })) });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('no reconozco');
    expect(msg).toContain('no sé si aplicó el cambio');
    expect(s.writesOf()).toHaveLength(1);
  });

  it('una respuesta que no es JSON tampoco', async () => {
    const s = setup({ reply: () => new Response('<html>') });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('no reconozco');
  });

  it('fallo de red ambiguo: «No sé» y no se reintenta', async () => {
    const s = setup({ reply: () => withCause('ECONNRESET') });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('No sé si Home Assistant llegó a hacer el cambio');
    expect(msg).toContain('ha_automatizaciones');
    expect(s.writesOf()).toHaveLength(1);
  });

  it('un plazo agotado también es ambiguo', async () => {
    const s = setup({
      reply: () => Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toMatch(/No sé/);
    expect(s.writesOf()).toHaveLength(1);
  });

  it('un 5xx al escribir es ambiguo (HA guarda antes de recargar): «No sé» y no se reintenta', async () => {
    const s = setup({ reply: () => new Response('{}', { status: 500 }) });
    const msg = await failure(
      s.get('ha_proponer_automatizacion').handler(propose({ habilitada: true })),
    );
    expect(msg).toMatch(/HTTP 500/);
    expect(msg).toContain('No sé si Home Assistant llegó a hacer el cambio');
    expect(s.writesOf()).toHaveLength(1);
  });

  it('ECONNREFUSED: un error normal, sin «No sé»', async () => {
    const s = setup({ reply: () => withCause('ECONNREFUSED') });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('No se llega a Home Assistant');
    expect(msg).not.toMatch(/No sé/);
    expect(s.writesOf()).toHaveLength(1);
  });

  it('si falla la segunda escritura, dice que quedó apagada con initial_state guardado', async () => {
    const s = setup({
      reply: (_c, n) => (n === 0 ? okResponse() : new Response('{}', { status: 500 })),
    });
    const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
    expect(msg).toContain('quedó creada y apagada');
    expect(msg).toContain('initial_state: false guardado');
    expect(msg).toContain('accion modificar');
    expect(s.writesOf()).toHaveLength(2);
  });

  it.each([['2024.9.1'], ['2028.1.0'], ['dev'], [null]])(
    'versión %s: no escribe ni mira si existe',
    async (version) => {
      const s = setup({ version });
      const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose()));
      expect(msg).toContain('No escribo en esta versión de Home Assistant');
      expect(s.writesOf()).toHaveLength(0);
      expect(s.calls.filter((c) => c.path.startsWith('/api/config/'))).toHaveLength(0);
    },
  );

  it('las versiones de los extremos del rango sí valen', async () => {
    for (const version of ['2024.10.0', '2027.12.3']) {
      const s = setup({ version });
      await s.get('ha_proponer_automatizacion').handler(propose({ habilitada: true }));
      expect(s.writesOf()).toHaveLength(1);
    }
  });

  describe('validación', () => {
    it.each([
      ['initial_state', { initial_state: true }],
      ['id', { id: 'stratum_x' }],
      ['foo', { foo: 1 }],
    ])('rechaza la clave %s de config sin llamar a la red', async (key, extra) => {
      const s = setup();
      const msg = await failure(
        s
          .get('ha_proponer_automatizacion')
          .handler(propose({ config: { ...AUTOMATION, ...extra } })),
      );
      expect(msg).toContain(key);
      expect(s.calls).toHaveLength(0);
    });

    it('una clave de otro tipo se rechaza (sequence en una automatización)', async () => {
      const s = setup();
      const msg = await failure(
        s
          .get('ha_proponer_automatizacion')
          .handler(propose({ config: { ...AUTOMATION, sequence: [] } })),
      );
      expect(msg).toContain('sequence');
      expect(s.calls).toHaveLength(0);
    });

    it('exige alias, triggers y actions', async () => {
      const s = setup();
      const t = s.get('ha_proponer_automatizacion');
      expect(await failure(t.handler(propose({ config: { ...AUTOMATION, alias: '' } })))).toMatch(
        /alias/,
      );
      expect(
        await failure(t.handler(propose({ config: { ...AUTOMATION, triggers: [] } }))),
      ).toMatch(/triggers/);
      const { actions: _a, ...sinActions } = AUTOMATION;
      expect(await failure(t.handler(propose({ config: sinActions })))).toMatch(/actions/);
      expect(s.calls).toHaveLength(0);
    });

    it('la escena exige entities con forma de entity_id', async () => {
      const s = setup();
      const msg = await failure(
        s.get('ha_proponer_automatizacion').handler({
          accion: 'crear',
          tipo: 'escena',
          id: 'stratum_cine',
          config: { name: 'Cine', entities: { 'sin-forma': {} } },
        }),
      );
      expect(msg).toMatch(/entities/);
      expect(s.calls).toHaveLength(0);
    });

    it('habilitada solo vale al crear una automatización', async () => {
      const s = setup();
      const t = s.get('ha_proponer_automatizacion');
      expect(
        await failure(
          t.handler({
            accion: 'crear',
            tipo: 'script',
            id: 'stratum_noches',
            config: SCRIPT,
            habilitada: true,
          }),
        ),
      ).toMatch(/habilitada solo vale/);
      expect(await failure(t.handler(propose({ accion: 'modificar', habilitada: false })))).toMatch(
        /habilitada solo vale/,
      );
      expect(s.calls).toHaveLength(0);
    });
  });

  it.each(['luz_escritorio', 'Stratum_x', 'stratum_', 'stratum_con-guion', 'stratum_../x'])(
    'el id %s no pasa la validación: ninguna llamada',
    async (id) => {
      const s = setup();
      const msg = await failure(s.get('ha_proponer_automatizacion').handler(propose({ id })));
      expect(msg).toContain('stratum_');
      expect(s.calls).toHaveLength(0);
    },
  );
});

describe('ha_borrar_automatizacion', () => {
  const del = (over: Record<string, unknown> = {}) => ({
    tipo: 'automatizacion',
    id: 'stratum_luz_pasillo',
    ...over,
  });

  it('borra una propia', async () => {
    const s = setup({ exists: [AUTO_PATH] });
    const out = textOf(await s.get('ha_borrar_automatizacion').handler(del()));
    expect(s.writesOf()).toEqual([{ method: 'DELETE', path: AUTO_PATH, body: undefined }]);
    expect(out).toContain('Borrada la automatización «Existente» (stratum_luz_pasillo)');
  });

  it('no existe: nada que borrar y sin DELETE', async () => {
    const s = setup();
    const out = textOf(await s.get('ha_borrar_automatizacion').handler(del()));
    expect(out).toContain('no existe (nada que borrar)');
    expect(s.writesOf()).toHaveLength(0);
  });

  it('un 400 «Resource not found» es que ya no existe', async () => {
    const s = setup({
      exists: [AUTO_PATH],
      reply: () => new Response(JSON.stringify({ message: 'Resource not found' }), { status: 400 }),
    });
    expect(await failure(s.get('ha_borrar_automatizacion').handler(del()))).toContain(
      'ya no existe',
    );
  });

  it('otro 400 se propaga y una respuesta rara es «no sé»', async () => {
    const s = setup({
      exists: [AUTO_PATH],
      reply: () => new Response(JSON.stringify({ result: 'ko' })),
    });
    expect(await failure(s.get('ha_borrar_automatizacion').handler(del()))).toContain(
      'no sé si aplicó el cambio',
    );
  });

  it('fallo de red ambiguo: «No sé» y no se reintenta', async () => {
    const s = setup({ exists: [AUTO_PATH], reply: () => withCause('ECONNRESET') });
    expect(await failure(s.get('ha_borrar_automatizacion').handler(del()))).toMatch(/No sé/);
    expect(s.writesOf()).toHaveLength(1);
  });

  it('script y escena van a su ruta', async () => {
    const s = setup({
      exists: ['/api/config/script/config/stratum_noches', '/api/config/scene/config/stratum_cine'],
    });
    const t = s.get('ha_borrar_automatizacion');
    await t.handler({ tipo: 'script', id: 'stratum_noches' });
    await t.handler({ tipo: 'escena', id: 'stratum_cine' });
    expect(s.writesOf().map((c) => c.path)).toEqual([
      '/api/config/script/config/stratum_noches',
      '/api/config/scene/config/stratum_cine',
    ]);
  });

  it('versión desconocida: no toca nada', async () => {
    const s = setup({ version: '2023.1.0', exists: [AUTO_PATH] });
    expect(await failure(s.get('ha_borrar_automatizacion').handler(del()))).toContain(
      'No escribo en esta versión',
    );
    expect(s.writesOf()).toHaveLength(0);
  });

  it('un id ajeno no sale de la validación: ninguna llamada', async () => {
    const s = setup({ exists: ['/api/config/automation/config/luz_escritorio'] });
    const msg = await failure(
      s.get('ha_borrar_automatizacion').handler(del({ id: 'luz_escritorio' })),
    );
    expect(msg).toContain('stratum_');
    expect(s.calls).toHaveLength(0);
  });
});

describe('el cliente solo escribe lo propio', () => {
  function client() {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return okResponse();
    }) as typeof fetch;
    return { c: createHaClient({ fetch: f, url: 'http://ha:8123', token: TOKEN })!, calls };
  }

  it('writeConfig y deleteConfig con una ruta ajena no llaman a la red', async () => {
    const { c, calls } = client();
    for (const id of [
      'luz_escritorio',
      'stratum_',
      'stratum_../../x',
      'stratum_a/b',
      'STRATUM_a',
    ]) {
      await expect(c.writeConfig('automation', id, {})).rejects.toBeInstanceOf(ToolUserError);
      await expect(c.deleteConfig('automation', id)).rejects.toBeInstanceOf(ToolUserError);
    }
    await expect(c.writeConfig('helper' as never, 'stratum_a', {})).rejects.toBeInstanceOf(
      ToolUserError,
    );
    expect(calls).toHaveLength(0);
  });

  it('con un id propio sí llama, con el método y la ruta', async () => {
    const { c, calls } = client();
    await expect(c.writeConfig('script', 'stratum_a', { alias: 'x' })).resolves.toEqual({
      result: 'ok',
    });
    await expect(c.deleteConfig('scene', 'stratum_a')).resolves.toEqual({ result: 'ok' });
    expect(calls).toEqual([
      'http://ha:8123/api/config/script/config/stratum_a',
      'http://ha:8123/api/config/scene/config/stratum_a',
    ]);
  });
});

describe('ha_automatizaciones marca las propias', () => {
  it('la lista pone « · de Stratum» a las de id stratum_', async () => {
    const s = setup({
      states: [
        autoState('off'),
        {
          entity_id: 'automation.otra',
          state: 'on',
          attributes: { id: 'abc', friendly_name: 'Otra' },
        },
        { entity_id: 'script.stratum_noches', state: 'off', attributes: {} },
      ],
    });
    const out = textOf(await s.get('ha_automatizaciones').handler({}));
    expect(out).toMatch(
      /automation\.stratum_luz_pasillo — Luz pasillo — desactivada · de Stratum —/,
    );
    expect(out).toMatch(/script\.stratum_noches — script\.stratum_noches — script · de Stratum —/);
    expect(out).toMatch(/automation\.otra — Otra — activada —/);
    expect(out).not.toMatch(/Otra — activada · de Stratum/);
  });
});

describe('manifiesto', () => {
  it('marca las dos tools de escritura como forced y no de solo lectura', () => {
    const manifest = parseConnectorManifest(
      JSON.parse(readFileSync(MANIFEST, 'utf8')),
      'home-assistant',
    );
    expect(forcedToolsOf(manifest).sort()).toEqual([
      'ha_borrar_automatizacion',
      'ha_proponer_automatizacion',
    ]);
    for (const name of ['ha_borrar_automatizacion', 'ha_proponer_automatizacion']) {
      expect(manifest.tools.find((t) => t.name === name)?.readOnly).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ToolUserError, type ConnectorTool, type ToolOutput } from '../lib/mcp-stdio.js';
import { createHomeAssistantTools } from './tools.js';

const TOKEN = 'tok-SECRETO-123';

const STATES = [
  {
    entity_id: 'light.salon',
    state: 'on',
    attributes: {
      friendly_name: 'Luz del salón',
      brightness: 128,
      color_temp_kelvin: 2700,
      effect: 'x',
    },
    last_changed: '2026-11-12T20:03:00+00:00',
  },
  {
    entity_id: 'light.cocina',
    state: 'off',
    attributes: { friendly_name: 'Luz cocina' },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
  {
    entity_id: 'switch.enchufe',
    state: 'on',
    attributes: { friendly_name: 'Enchufe' },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
  {
    entity_id: 'sensor.temp_salon',
    state: '21.5',
    attributes: {
      friendly_name: 'Temperatura salón',
      unit_of_measurement: '°C',
      device_class: 'temperature',
    },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
  {
    entity_id: 'sensor.roto',
    state: 'unavailable',
    attributes: { friendly_name: 'Roto' },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
  {
    entity_id: 'climate.sala',
    state: 'heat',
    attributes: {
      friendly_name: 'Termostato',
      current_temperature: 20.4,
      temperature: 22,
      hvac_action: 'heating',
      hvac_mode: 'heat',
      battery_level: 80,
    },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
  {
    entity_id: 'media_player.tele',
    state: 'playing',
    attributes: {
      friendly_name: 'Tele',
      media_title: 'Canción',
      media_artist: 'Alguien',
      volume_level: 0.3,
    },
    last_changed: '2026-11-12T19:00:00+00:00',
  },
];
const AREAS = 'light.salon|Salón\nsensor.temp_salon|Salón\nlight.cocina|Cocina\nswitch.enchufe|\n';

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

function setup(
  opts: {
    areasFail?: boolean;
    services?: (path: string) => unknown;
    history?: unknown;
    now?: () => number;
  } = {},
) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, body });
    const p = url.pathname;
    if (p === '/api/config') {
      return new Response(
        JSON.stringify({
          location_name: 'Casa',
          version: '2026.11.1',
          time_zone: 'Europe/Madrid',
          unit_system: { temperature: '°C' },
        }),
      );
    }
    if (p === '/api/states') return new Response(JSON.stringify(STATES));
    if (p.startsWith('/api/states/')) {
      const s = STATES.find((x) => x.entity_id === decodeURIComponent(p.slice(12)));
      return s ? new Response(JSON.stringify(s)) : new Response('{}', { status: 404 });
    }
    if (p === '/api/template') {
      return opts.areasFail ? new Response('no', { status: 400 }) : new Response(AREAS);
    }
    if (p.startsWith('/api/history/period/'))
      return new Response(JSON.stringify(opts.history ?? []));
    if (p.startsWith('/api/services/')) {
      return new Response(JSON.stringify(opts.services ? opts.services(p) : []));
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const tools = createHomeAssistantTools({
    fetch: f,
    url: 'http://ha.casa:8123',
    token: TOKEN,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const get = (name: string): ConnectorTool<string | ToolOutput> =>
    tools.find((t) => t.name === name)!;
  return {
    tools,
    get,
    calls,
    services: () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/services/')),
  };
}

/** El texto de una tool (las comprobaciones devuelvan además lo estructurado). */
function textOf(out: string | ToolOutput): string {
  return typeof out === 'string' ? out : out.text;
}

/** Lo estructurado de una comprobación (M22). */
function structuredOf(out: string | ToolOutput): Record<string, unknown> {
  if (typeof out === 'string') throw new Error('la tool devolvió solo texto');
  return out.structured;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return (err as Error).message;
  }
  throw new Error('no lanzó');
}

describe('tools de Home Assistant', () => {
  it('expone las 13 tools con ha_resumen primero', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'ha_resumen',
      'ha_buscar',
      'ha_estado',
      'ha_historial',
      'ha_comprobar',
      'ha_acceso',
      'ha_encender',
      'ha_apagar',
      'ha_accion',
      'ha_automatizaciones',
      'ha_trazas',
      'ha_registro',
      'ha_avisos',
    ]);
    expect(tools[0]!.description).toMatch(/Primera tool/);
    expect(tools[8]!.description).toMatch(/aprobación/);
  });

  describe('ha_resumen', () => {
    it('cuenta dominios y áreas', async () => {
      const out = await setup().get('ha_resumen').handler({});
      expect(out).toContain('Casa: Casa · Home Assistant 2026.11.1');
      expect(out).toContain('Entidades: 7 en 5 dominios');
      expect(out).toContain('· light: 2');
      expect(out).toContain('· Salón: 2 entidades');
      expect(out).toContain('· Cocina: 1 entidades');
      expect(out).not.toContain(TOKEN);
    });
    it('sin áreas dice sin dato en vez de fallar', async () => {
      const out = await setup({ areasFail: true }).get('ha_resumen').handler({});
      expect(out).toContain('Áreas: sin dato');
    });
  });

  describe('ha_buscar', () => {
    it('pide un filtro', async () => {
      expect(await failure(setup().get('ha_buscar').handler({}))).toMatch(/al menos un filtro/);
    });
    it('busca sin acentos ni mayúsculas, también por área', async () => {
      const t = setup().get('ha_buscar');
      const a = await t.handler({ texto: 'SALON' });
      expect(a).toContain('light.salon — Luz del salón — on — Salón');
      expect(a).toContain('sensor.temp_salon — Temperatura salón — 21.5 °C — Salón');
      expect(a).not.toContain('light.cocina');
      const b = await t.handler({ area: 'cocina' });
      expect(b).toContain('light.cocina — Luz cocina — off — Cocina');
      const c = await t.handler({ dominio: 'switch' });
      expect(c).toContain('switch.enchufe — Enchufe — on — sin área');
      const d = await t.handler({ texto: 'luz salon', dominio: 'light' });
      expect(d).toContain('(1)');
    });
    it('estados especiales y sin áreas', async () => {
      const out = await setup({ areasFail: true }).get('ha_buscar').handler({ texto: 'roto' });
      expect(out).toContain('sensor.roto — Roto — no disponible — sin dato');
      expect(
        await failure(setup({ areasFail: true }).get('ha_buscar').handler({ area: 'x' })),
      ).toMatch(/áreas/);
    });
    it('trunca con limite y dice cuántos faltan', async () => {
      const out = textOf(await setup().get('ha_buscar').handler({ texto: 'e', limite: 2 }));
      expect(out.split('\n').filter((l) => l.includes(' — '))).toHaveLength(2);
      expect(out).toMatch(/faltan \d+ más/);
    });
    it('valida limite y sin resultados', async () => {
      const t = setup().get('ha_buscar');
      expect(await failure(t.handler({ texto: 'a', limite: 101 }))).toMatch(/limite/);
      expect(await t.handler({ texto: 'zzz' })).toMatch(/No encontré/);
    });
  });

  describe('ha_estado', () => {
    it('detalla una luz con brillo en % y hora local', async () => {
      const out = await setup().get('ha_estado').handler({ entity_id: 'light.salon' });
      expect(out).toContain('Estado: on (desde 12 nov 21:03)');
      expect(out).toContain('Brillo: 50 %');
      expect(out).toContain('Temperatura de color: 2700 K');
      expect(out).toContain('Otros atributos: effect');
    });
    it('clima, medios y batería', async () => {
      const out = await setup()
        .get('ha_estado')
        .handler({ entity_id: ['climate.sala', 'media_player.tele'] });
      expect(out).toContain('Temperatura actual: 20,4 °C');
      expect(out).toContain('Temperatura objetivo: 22 °C');
      expect(out).toContain('Acción: heating');
      expect(out).toContain('Modo: heat');
      expect(out).toContain('Batería: 80 %');
      expect(out).toContain('Reproduciendo: Canción — Alguien');
      expect(out).toContain('Volumen: 30 %');
    });
    it('una lista informa de la que no existe y un id solo falla', async () => {
      const t = setup().get('ha_estado');
      const out = await t.handler({ entity_id: ['light.salon', 'light.nada'] });
      expect(out).toContain('light.nada: no existe (usa ha_buscar).');
      expect(await failure(t.handler({ entity_id: 'light.nada' }))).toMatch(/no existe/);
    });
    it('valida el id y el tope de 20, y codifica la ruta', async () => {
      const s = setup();
      const t = s.get('ha_estado');
      expect(await failure(t.handler({ entity_id: 'Light Salon' }))).toMatch(/entity_id/);
      expect(await failure(t.handler({ entity_id: '../x' }))).toMatch(/entity_id/);
      expect(await failure(t.handler({}))).toMatch(/entity_id/);
      const many = Array.from({ length: 21 }, (_, i) => `light.l${i}`);
      expect(await failure(t.handler({ entity_id: many }))).toMatch(/hasta 20/);
    });
  });

  describe('ha_comprobar', () => {
    it('on y off: estado tal cual y valor sin dato (nunca 0)', async () => {
      const t = setup().get('ha_comprobar');
      const on = structuredOf(await t.handler({ entity_id: 'light.salon' }));
      expect(on).toEqual({
        estado: 'on',
        valor: null,
        detalle: 'Luz del salón — on',
      });
      const off = structuredOf(await t.handler({ entity_id: 'light.cocina' }));
      expect(off).toMatchObject({ estado: 'off', valor: null });
    });

    it('un sensor numérico da el número como valor', async () => {
      const out = await setup().get('ha_comprobar').handler({ entity_id: 'sensor.temp_salon' });
      expect(structuredOf(out)).toEqual({
        estado: '21.5',
        valor: 21.5,
        detalle: 'Temperatura salón — 21.5 °C',
      });
      expect(textOf(out)).toContain('sensor.temp_salon — Temperatura salón — 21.5 °C');
      expect(textOf(out)).toContain('Para vigilantes: estado «21.5», valor 21.5');
    });

    it('unavailable es «no disponible» en el texto y null como valor', async () => {
      const out = await setup().get('ha_comprobar').handler({ entity_id: 'sensor.roto' });
      expect(structuredOf(out)).toMatchObject({ estado: 'unavailable', valor: null });
      expect(textOf(out)).toContain('Para vigilantes: estado «unavailable», valor sin dato');
    });

    it('un atributo numérico presente', async () => {
      const out = await setup()
        .get('ha_comprobar')
        .handler({ entity_id: 'climate.sala', atributo: 'current_temperature' });
      expect(structuredOf(out)).toEqual({
        estado: '20.4',
        valor: 20.4,
        detalle: 'Termostato — heat — current_temperature: 20.4',
      });
    });

    it('un atributo que no existe es sin_dato, nunca 0', async () => {
      const out = await setup()
        .get('ha_comprobar')
        .handler({ entity_id: 'light.salon', atributo: 'battery_level' });
      expect(structuredOf(out)).toEqual({
        estado: 'sin_dato',
        valor: null,
        detalle: 'Luz del salón — on — battery_level: sin dato',
      });
      // Una clave heredada del prototipo no es un atributo.
      const proto = await setup()
        .get('ha_comprobar')
        .handler({ entity_id: 'light.salon', atributo: 'constructor' });
      expect(structuredOf(proto)).toMatchObject({ estado: 'sin_dato', valor: null });
    });

    it('una entidad que no existe es un fallo de la comprobación', async () => {
      const t = setup().get('ha_comprobar');
      const msg = await failure(t.handler({ entity_id: 'light.nada' }));
      expect(msg).toMatch(/no existe/);
    });

    it('una sola entidad: rechaza listas y ids mal formados', async () => {
      const t = setup().get('ha_comprobar');
      expect(await failure(t.handler({ entity_id: ['light.salon', 'light.cocina'] }))).toMatch(
        /entity_id/,
      );
      expect(await failure(t.handler({ entity_id: 'Light Salon' }))).toMatch(/entity_id/);
      expect(await failure(t.handler({ entity_id: '../x' }))).toMatch(/entity_id/);
      expect(await failure(t.handler({}))).toMatch(/entity_id/);
      expect(await failure(t.handler({ entity_id: 'light.salon', atributo: 'No Válido' }))).toMatch(
        /atributo/,
      );
    });

    it('sin configurar avisa como las demás tools', async () => {
      const tools = createHomeAssistantTools({
        fetch: (async () => new Response('')) as typeof fetch,
      });
      const msg = await failure(
        tools.find((t) => t.name === 'ha_comprobar')!.handler({ entity_id: 'light.salon' }),
      );
      expect(msg).toContain('Home Assistant no está configurado');
    });
  });

  describe('ha_encender / ha_apagar', () => {
    it('agrupa por dominio con una llamada por dominio', async () => {
      const s = setup({
        services: () => [
          {
            entity_id: 'light.salon',
            state: 'on',
            attributes: { friendly_name: 'Luz del salón' },
            last_changed: null,
          },
        ],
      });
      const out = await s.get('ha_encender').handler({
        entity_id: ['light.salon', 'switch.enchufe', 'light.cocina'],
      });
      const calls = s.services();
      expect(calls.map((c) => c.path)).toEqual([
        '/api/services/light/turn_on',
        '/api/services/switch/turn_on',
      ]);
      expect(calls[0]!.body).toEqual({ entity_id: ['light.salon', 'light.cocina'] });
      expect(out).toContain('Hecho. Estados que cambiaron (2):');
      expect(out).toContain('· light.salon — Luz del salón — on');
    });
    it('brillo como brightness_pct, solo con luces', async () => {
      const s = setup();
      await s.get('ha_encender').handler({ entity_id: 'light.salon', brillo: 40 });
      expect(s.services()[0]!.body).toEqual({ entity_id: ['light.salon'], brightness_pct: 40 });
      const msg = await failure(
        s.get('ha_encender').handler({ entity_id: ['light.salon', 'switch.enchufe'], brillo: 40 }),
      );
      expect(msg).toMatch(/brillo solo/);
      expect(s.services()).toHaveLength(1);
      expect(
        await failure(s.get('ha_encender').handler({ entity_id: 'light.a', brillo: 101 })),
      ).toMatch(/brillo/);
    });
    it('persianas, scenes y dominios no admitidos', async () => {
      const s = setup();
      await s.get('ha_encender').handler({ entity_id: ['cover.salon', 'scene.cine', 'script.x'] });
      await s.get('ha_apagar').handler({ entity_id: 'cover.salon' });
      expect(s.services().map((c) => c.path)).toEqual([
        '/api/services/cover/open_cover',
        '/api/services/scene/turn_on',
        '/api/services/script/turn_on',
        '/api/services/cover/close_cover',
      ]);
      const lock = await failure(s.get('ha_encender').handler({ entity_id: 'lock.puerta' }));
      expect(lock).toMatch(/ha_accion/);
      expect(await failure(s.get('ha_apagar').handler({ entity_id: 'scene.cine' }))).toMatch(
        /ha_accion/,
      );
      expect(await failure(s.get('ha_apagar').handler({ entity_id: 'script.x' }))).toMatch(
        /ha_accion/,
      );
      expect(s.services()).toHaveLength(4);
    });
    it('un id de más de 10 y la forma {changed_states}', async () => {
      const s = setup({
        services: () => ({
          changed_states: [
            { entity_id: 'light.a', state: 'off', attributes: {}, last_changed: null },
          ],
        }),
      });
      const many = Array.from({ length: 11 }, (_, i) => `light.l${i}`);
      expect(await failure(s.get('ha_apagar').handler({ entity_id: many }))).toMatch(/hasta 10/);
      const out = await s.get('ha_apagar').handler({ entity_id: 'light.a' });
      expect(out).toContain('· light.a — light.a — off');
    });
    it('sin cambios y con más de 20 cambios', async () => {
      const none = await setup().get('ha_apagar').handler({ entity_id: 'light.a' });
      expect(none).toBe(
        'Hecho. Home Assistant no informó de cambios (puede tardar unos segundos; compruébalo con ha_estado).',
      );
      const big = setup({
        services: () =>
          Array.from({ length: 25 }, (_, i) => ({
            entity_id: `light.l${i}`,
            state: 'off',
            attributes: {},
            last_changed: null,
          })),
      });
      const out = textOf(await big.get('ha_apagar').handler({ entity_id: 'light.a' }));
      expect(out.split('\n').filter((l) => l.startsWith('·'))).toHaveLength(20);
      expect(out).toContain('… y 5 más.');
    });
  });

  describe('ha_accion', () => {
    it('llama al servicio con datos y entity_id', async () => {
      const s = setup();
      await s.get('ha_accion').handler({
        dominio: 'lock',
        servicio: 'unlock',
        entity_id: 'lock.puerta',
        datos: { code: '1234' },
      });
      expect(s.services()[0]).toMatchObject({
        path: '/api/services/lock/unlock',
        body: { code: '1234', entity_id: ['lock.puerta'] },
      });
    });
    it('sin entity_id ni datos envía un cuerpo vacío', async () => {
      const s = setup();
      await s.get('ha_accion').handler({ dominio: 'notify', servicio: 'notify' });
      expect(s.services()[0]!.body).toEqual({});
    });
    it('valida dominio, servicio y datos', async () => {
      const s = setup();
      const t = s.get('ha_accion');
      expect(await failure(t.handler({ dominio: 'Lock', servicio: 'unlock' }))).toMatch(/dominio/);
      expect(await failure(t.handler({ dominio: 'lock', servicio: '../x' }))).toMatch(/servicio/);
      expect(await failure(t.handler({ dominio: 'lock', servicio: 'a'.repeat(65) }))).toMatch(
        /servicio/,
      );
      expect(await failure(t.handler({ dominio: 'lock' }))).toMatch(/servicio/);
      expect(
        await failure(t.handler({ dominio: 'a', servicio: 'b', datos: { entity_id: 'x.y' } })),
      ).toMatch(/entity_id/);
      expect(
        await failure(
          t.handler({ dominio: 'a', servicio: 'b', datos: { texto: 'x'.repeat(3000) } }),
        ),
      ).toMatch(/2 KB/);
      expect(await failure(t.handler({ dominio: 'a', servicio: 'b', datos: [1] }))).toMatch(
        /datos/,
      );
      expect(s.services()).toHaveLength(0);
    });
  });

  it('el token no sale en ninguna salida correcta', async () => {
    const s = setup();
    const outs = [
      await s.get('ha_resumen').handler({}),
      await s.get('ha_buscar').handler({ texto: 'luz' }),
      await s.get('ha_estado').handler({ entity_id: 'light.salon' }),
      await s.get('ha_encender').handler({ entity_id: 'light.salon' }),
    ];
    for (const o of outs) expect(o).not.toContain(TOKEN);
  });

  it('una lista metida en un texto (JSON o con comas) vale como lista; cada id se valida', async () => {
    const s = setup();
    const estado = s.get('ha_estado');
    const asList = await estado.handler({ entity_id: ['light.salon', 'sensor.temp_salon'] });
    expect(await estado.handler({ entity_id: '["light.salon", "sensor.temp_salon"]' })).toBe(
      asList,
    );
    expect(await estado.handler({ entity_id: 'light.salon, sensor.temp_salon' })).toBe(asList);
    // Un id malo dentro del texto sigue rechazado, y un JSON roto también.
    await expect(estado.handler({ entity_id: '["light.salon", "../x"]' })).rejects.toThrow(
      /dominio\.nombre/,
    );
    await expect(estado.handler({ entity_id: '["light.salon",' })).rejects.toThrow(
      /dominio\.nombre/,
    );
  });
});

describe('ha_historial', () => {
  // 2026-11-20 13:00 en Madrid: por defecto, desde el 19 nov 13:00.
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const HISTORY = [
    [
      {
        entity_id: 'light.wled',
        state: 'on',
        attributes: { friendly_name: 'WLED' },
        last_changed: '2026-11-19T12:00:00+00:00',
      },
      { state: 'unavailable', last_changed: '2026-11-20T02:00:00+00:00' },
      { state: 'on', last_changed: '2026-11-20T02:30:00+00:00' },
    ],
    [
      {
        entity_id: 'sensor.temp',
        state: '20.5',
        attributes: { friendly_name: 'Temperatura', unit_of_measurement: '°C' },
        last_changed: '2026-11-18T10:00:00+00:00',
      },
      { state: '18.2', last_changed: '2026-11-20T04:00:00+00:00' },
      { state: '21', last_changed: '2026-11-20T10:00:00+00:00' },
    ],
  ];

  it('pide el periodo con filtro, fin y respuesta mínima', async () => {
    const s = setup({ history: HISTORY, now: () => NOW });
    await s.get('ha_historial').handler({ entity_id: ['light.wled', 'sensor.temp'] });
    const call = s.calls.find((c) => c.path.startsWith('/api/history/period/'))!;
    expect(decodeURIComponent(call.path)).toBe('/api/history/period/2026-11-19T12:00:00.000Z');
    const q = new URLSearchParams(call.search);
    expect(q.get('filter_entity_id')).toBe('light.wled,sensor.temp');
    expect(q.get('end_time')).toBe('2026-11-20T12:00:00.000Z');
    expect(q.has('minimal_response')).toBe(true);
    expect(call.method).toBe('GET');
  });

  it('resume cambios con su hora local y el tiempo en cada estado', async () => {
    const out = await setup({ history: HISTORY, now: () => NOW })
      .get('ha_historial')
      .handler({ entity_id: 'light.wled' });
    expect(out).toBe(
      [
        'light.wled — WLED',
        '2 cambios en las últimas 24 h.',
        'Al empezar (19 nov 13:00): on',
        'Tiempo en cada estado: on 23 h 30 min · no disponible 30 min',
        'Ahora: on (desde 20 nov 03:30)',
        'Cambios:',
        '· 20 nov 03:00 → no disponible',
        '· 20 nov 03:30 → on',
      ].join('\n'),
    );
  });

  it('en un sensor numérico da mínimo y máximo con su unidad y hora', async () => {
    const out = await setup({ history: HISTORY, now: () => NOW })
      .get('ha_historial')
      .handler({ entity_id: 'sensor.temp', horas: 24 });
    expect(out).toContain('Al empezar (19 nov 13:00): 20.5 °C');
    expect(out).toContain('Mínimo: 18.2 °C (20 nov 05:00) · máximo: 21 °C (20 nov 11:00)');
    expect(out).not.toContain('Tiempo en cada estado');
    // 24 h justas: sin resumen por día.
    expect(out).not.toContain('Por día');
    expect(out).toContain('Ahora: 21 °C (desde 20 nov 11:00)');
  });

  it('una entidad sin datos lo dice sin inventar un estado', async () => {
    const out = await setup({ history: HISTORY, now: () => NOW })
      .get('ha_historial')
      .handler({ entity_id: ['light.wled', 'sensor.nada'] });
    expect(out).toContain(
      'sensor.nada\nSin datos en las últimas 24 h: o no existe (usa ha_buscar)',
    );
    expect(out).toContain('light.wled — WLED');
  });

  it('sin cambios en el periodo, el estado de partida cubre todo', async () => {
    const out = await setup({
      history: [
        [
          {
            entity_id: 'switch.x',
            state: 'off',
            attributes: {},
            last_changed: '2026-11-10T00:00:00+00:00',
          },
        ],
      ],
      now: () => NOW,
    })
      .get('ha_historial')
      .handler({ entity_id: 'switch.x', horas: 2 });
    expect(out).toContain('Sin cambios en las últimas 2 h.');
    expect(out).toContain('Tiempo en cada estado: off 2 h 00 min');
    expect(out).toContain('Ahora: off (desde 10 nov 01:00)');
    expect(out).not.toContain('Cambios:');
  });

  it('sin cambios y con el estado de partida a la hora de inicio, no inventa desde cuándo', async () => {
    // Así lo devuelve Home Assistant (medido el 2026-11-20 con un HA real).
    const out = await setup({
      history: [
        [
          {
            entity_id: 'switch.x',
            state: 'on',
            attributes: {},
            last_changed: '2026-11-19T12:00:00+00:00',
          },
        ],
      ],
      now: () => NOW,
    })
      .get('ha_historial')
      .handler({ entity_id: 'switch.x' });
    expect(out).toContain('Ahora: on (desde antes de 19 nov 13:00)');
  });

  it('una entidad que aparece a mitad del periodo dice desde cuándo hay dato', async () => {
    const out = await setup({
      history: [
        [
          {
            entity_id: 'switch.x',
            state: 'on',
            attributes: {},
            last_changed: '2026-11-20T11:00:00+00:00',
          },
        ],
      ],
      now: () => NOW,
    })
      .get('ha_historial')
      .handler({ entity_id: 'switch.x' });
    expect(out).toContain('1 cambio en las últimas 24 h (sin dato antes de 20 nov 12:00).');
    expect(out).not.toContain('Al empezar');
    expect(out).toContain('Tiempo en cada estado: on 1 h 00 min');
  });

  it('muchos cambios: enseña los últimos y dice cuántos omite', async () => {
    const series: unknown[] = [
      {
        entity_id: 'binary_sensor.puerta',
        state: 'off',
        attributes: {},
        last_changed: '2026-11-19T12:00:00+00:00',
      },
    ];
    for (let i = 1; i <= 50; i++) {
      series.push({
        state: i % 2 ? 'on' : 'off',
        last_changed: new Date(Date.parse('2026-11-19T12:00:00Z') + i * 60_000 * 10).toISOString(),
      });
    }
    const out = String(
      await setup({ history: [series], now: () => NOW })
        .get('ha_historial')
        .handler({ entity_id: 'binary_sensor.puerta' }),
    );
    expect(out).toContain('50 cambios en las últimas 24 h.');
    expect(out).toContain('Cambios (los 40 últimos):');
    expect(out).toContain(
      '… 10 anteriores omitidos: para verlos, pide un periodo más corto con desde y hasta.',
    );
    expect(out.split('\n').filter((l) => l.startsWith('· '))).toHaveLength(40);
  });

  it('con desde y hasta (hora de la casa) pide ese periodo y no habla de «ahora»', async () => {
    const s = setup({ history: HISTORY, now: () => NOW });
    const out = String(
      await s.get('ha_historial').handler({
        entity_id: 'light.wled',
        desde: '2026-11-20T01:00',
        hasta: '2026-11-20T04:00',
      }),
    );
    const call = s.calls.find((c) => c.path.startsWith('/api/history/period/'))!;
    // 01:00 en Madrid (UTC+1 en noviembre) es 00:00 UTC.
    expect(decodeURIComponent(call.path)).toBe('/api/history/period/2026-11-20T00:00:00.000Z');
    expect(new URLSearchParams(call.search).get('end_time')).toBe('2026-11-20T03:00:00.000Z');
    expect(out).toContain('2 cambios en el periodo de 20 nov 01:00 a 20 nov 04:00.');
    expect(out).toContain('Al acabar (20 nov 04:00): on (desde 20 nov 03:30)');
    expect(out).not.toContain('Ahora:');
    expect(out).toContain('Tiempo en cada estado: on 2 h 30 min · no disponible 30 min');
  });

  it('desde sin hasta, o un hasta futuro, acaba ahora', async () => {
    const s = setup({ history: HISTORY, now: () => NOW });
    const t = s.get('ha_historial');
    const a = String(await t.handler({ entity_id: 'light.wled', desde: '2026-11-20' }));
    expect(a).toContain('en el periodo de 20 nov 00:00 a ahora (20 nov 13:00).');
    expect(a).toContain('Ahora: on');
    // Un día entero en hasta lo incluye: hasta el 21 a las 00:00, recortado a ahora.
    const b = String(
      await t.handler({ entity_id: 'light.wled', desde: '2026-11-20', hasta: '2026-11-20' }),
    );
    expect(b).toContain('a ahora (20 nov 13:00).');
    const ends = s.calls
      .filter((c) => c.path.startsWith('/api/history/period/'))
      .map((c) => new URLSearchParams(c.search).get('end_time'));
    expect(ends).toEqual(['2026-11-20T12:00:00.000Z', '2026-11-20T12:00:00.000Z']);
  });

  it('un sensor numérico de más de 24 h da mínimo y máximo por día local, y solo 10 cambios', async () => {
    const series: unknown[] = [
      {
        entity_id: 'sensor.t',
        state: '20.0',
        attributes: { unit_of_measurement: '°C' },
        last_changed: '2026-11-18T12:00:00+00:00',
      },
    ];
    // Cada hora desde el 19 nov 00:00 UTC: 20.0, 20.5, 21.0…
    for (let i = 0; i < 30; i++) {
      series.push({
        state: (20 + (i % 6) * 0.5).toFixed(1),
        last_changed: new Date(Date.parse('2026-11-19T00:00:00Z') + i * 3_600_000).toISOString(),
      });
    }
    const out = String(
      await setup({ history: [series], now: () => NOW })
        .get('ha_historial')
        .handler({ entity_id: 'sensor.t', horas: 48 }),
    );
    expect(out).toContain('Por día (mínimo – máximo):');
    // El 18 nov (desde las 13:00 en Madrid) solo tiene el valor de partida.
    expect(out).toContain('· 18 nov: 20.0 °C');
    expect(out).toContain('· 19 nov: 20.0 – 22.5 °C');
    expect(out).toContain('· 20 nov: 20.0 – 22.5 °C');
    expect(out).toContain('Cambios (los 10 últimos):');
    expect(out.split('\n').filter((l) => l.startsWith('· ') && l.includes('→'))).toHaveLength(10);
  });

  it('valida horas y el número de entidades', async () => {
    const t = setup().get('ha_historial');
    expect(await failure(t.handler({ entity_id: 'light.a', horas: 200 }))).toMatch(/168/);
    expect(await failure(t.handler({ entity_id: 'light.a', horas: 0 }))).toMatch(/entre 1/);
    expect(await failure(t.handler({ entity_id: 'light.a', horas: 1.5 }))).toMatch(/entero/);
    const many = Array.from({ length: 11 }, (_, i) => `light.l${i}`);
    expect(await failure(t.handler({ entity_id: many }))).toMatch(/hasta 10/);
    expect(await failure(t.handler({ entity_id: '../x' }))).toMatch(/dominio\.nombre/);
  });

  it('valida desde y hasta', async () => {
    const t = setup({ now: () => NOW }).get('ha_historial');
    const bad = (extra: Record<string, unknown>): Promise<string> =>
      failure(t.handler({ entity_id: 'light.a', ...extra }));
    expect(await bad({ horas: 5, desde: '2026-11-19T21:00' })).toMatch(/no los dos/);
    expect(await bad({ hasta: '2026-11-19T21:00' })).toMatch(/hasta necesita desde/);
    expect(await bad({ desde: 'ayer' })).toMatch(/AAAA-MM-DDTHH:MM/);
    expect(await bad({ desde: '2026-02-30' })).toMatch(/AAAA-MM-DD/);
    expect(await bad({ desde: '2026-11-19T25:00' })).toMatch(/AAAA-MM-DD/);
    expect(await bad({ desde: '2026-11-19T21:00', hasta: 'luego' })).toMatch(/^.*hasta debe ser/);
    expect(await bad({ desde: '2026-11-21T10:00' })).toMatch(/futuro/);
    expect(await bad({ desde: '2026-11-19T22:00', hasta: '2026-11-19T21:00' })).toMatch(
      /posterior a desde/,
    );
    expect(await bad({ desde: '2026-11-01', hasta: '2026-11-10' })).toMatch(/7 días/);
  });

  it('sin configurar pide el setup', async () => {
    const t = createHomeAssistantTools({
      fetch: (() => {
        throw new Error('no debe llamar');
      }) as unknown as typeof fetch,
    }).find((x) => x.name === 'ha_historial')!;
    expect(await failure(t.handler({ entity_id: 'light.a' }))).toMatch(/connectors setup/);
  });
});

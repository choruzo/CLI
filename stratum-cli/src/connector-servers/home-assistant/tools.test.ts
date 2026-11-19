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
  body: unknown;
}

function setup(opts: { areasFail?: boolean; services?: (path: string) => unknown } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
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
    if (p.startsWith('/api/services/')) {
      return new Response(JSON.stringify(opts.services ? opts.services(p) : []));
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const tools = createHomeAssistantTools({ fetch: f, url: 'http://ha.casa:8123', token: TOKEN });
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
  it('expone las 7 tools con ha_resumen primero', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'ha_resumen',
      'ha_buscar',
      'ha_estado',
      'ha_comprobar',
      'ha_encender',
      'ha_apagar',
      'ha_accion',
    ]);
    expect(tools[0]!.description).toMatch(/Primera tool/);
    expect(tools[6]!.description).toMatch(/aprobación/);
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

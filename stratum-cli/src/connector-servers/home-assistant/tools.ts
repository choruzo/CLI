/**
 * Tools del conector Home Assistant: ha_resumen, ha_buscar, ha_estado,
 * ha_historial, ha_comprobar, ha_encender, ha_apagar y ha_accion, y (M27, solo
 * lectura) ha_automatizaciones, ha_trazas, ha_registro y ha_avisos, y (M27 fase 2,
 * escritura forzada de lo propio) ha_proponer_automatizacion y ha_borrar_automatizacion. `fetch` y
 * `WebSocket` inyectables para testear sin red. Las salidas son texto breve en español para un agente,
 * nunca JSON crudo; `ha_comprobar` (M22) devuelve además lo estructurado que
 * lee un vigilante.
 */
import { z } from 'zod';
import { accessCheckTool } from '../lib/access.js';
import { ToolUserError, type ConnectorTool, type ToolOutput } from '../lib/mcp-stdio.js';
import {
  createHaClient,
  HaNotFoundError,
  isRecord,
  notConfigured,
  toStates,
  type HaClient,
  type HaState,
} from './client.js';
import {
  NO_DATA,
  domainOf,
  friendlyName,
  localTime,
  normalizeName,
  num,
  pct,
  stateText,
} from './format.js';
import { describeHistory, parseHistory } from './history.js';
import {
  DEFAULT_HISTORY_HOURS,
  MAX_HISTORY_HOURS,
  assertPeriodArgs,
  entityId,
  entityIds,
  idList,
  isoParam,
  parseArgs,
  periodFields,
  resolvePeriod,
  type HaToolContext,
} from './args.js';
import { createAutomationTools } from './automations.js';
import { createConfigWriteTools } from './config-writes.js';
import { createLogbookTool } from './logbook.js';
import { createRepairsTool } from './repairs.js';
import { createHaWs, type WebSocketCtor } from './ws.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_STATE_IDS = 20;
const MAX_ACTION_IDS = 10;
const MAX_CHANGED = 20;
const MAX_DOMAINS = 15;
const MAX_AREAS = 30;
const MAX_OTHER_ATTRS = 25;
const MAX_DATA_BYTES = 2048;
/** Historial (M22 parte 4): periodo acotado a 7 días y pocas entidades. */
const MAX_HISTORY_IDS = 10;
/** Cambios enseñados entre todas las entidades, y el mínimo y máximo por entidad. */
const HISTORY_CHANGES_BUDGET = 60;
const MIN_CHANGES_PER_ENTITY = 10;
const MAX_CHANGES_PER_ENTITY = 40;
/** Tope del `detalle` de una comprobación (M22): lo que enseña un aviso. */
const MAX_DETAIL = 300;
/** `estado` de una comprobación cuyo atributo no existe: nunca 0. */
const SIN_DATO = 'sin_dato';

/** Dominios con `<dominio>.turn_on` / `turn_off`. */
const TURN_DOMAINS = [
  'light',
  'switch',
  'fan',
  'input_boolean',
  'media_player',
  'climate',
  'automation',
  'siren',
  'humidifier',
  'remote',
];
/** Dominios que solo se encienden (se ejecutan), no se apagan. */
const ON_ONLY = ['scene', 'script'];

function onService(domain: string): string | null {
  if (TURN_DOMAINS.includes(domain) || ON_ONLY.includes(domain)) return 'turn_on';
  if (domain === 'cover') return 'open_cover';
  return null;
}

function offService(domain: string): string | null {
  if (TURN_DOMAINS.includes(domain)) return 'turn_off';
  if (domain === 'cover') return 'close_cover';
  return null;
}

export interface HomeAssistantOptions {
  fetch: typeof fetch;
  /** `WebSocket` global (Node 24); sin él no se leen trazas ni avisos (M27). */
  WebSocket?: WebSocketCtor;
  url?: string;
  token?: string;
  now?: () => number;
  /** Espera (ms) entre intentos de ver lo recién escrito (M27 fase 2); por defecto `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

// --- Argumentos --------------------------------------------------------------

const SERVICE_RE = /^[a-z_][a-z0-9_]{0,63}$/;
const ATTRIBUTE_RE = /^[a-z_][a-z0-9_]{0,63}$/;
const ATTRIBUTE_MSG = 'atributo no es válido (minúsculas, números y _; p. ej. current_temperature)';

const BuscarSchema = z.object({
  texto: z
    .string({ message: 'texto debe ser un texto' })
    .trim()
    .max(100, 'texto admite como máximo 100 caracteres')
    .optional(),
  dominio: z
    .string({ message: 'dominio debe ser un texto (p. ej. light)' })
    .trim()
    .regex(SERVICE_RE, 'dominio no es válido (p. ej. light)')
    .optional(),
  area: z
    .string({ message: 'area debe ser un texto' })
    .trim()
    .max(100, 'area admite como máximo 100 caracteres')
    .optional(),
  limite: z
    .number({ message: `limite debe ser un entero entre 1 y ${MAX_LIMIT}` })
    .int(`limite debe ser un entero entre 1 y ${MAX_LIMIT}`)
    .min(1, `limite debe ser un entero entre 1 y ${MAX_LIMIT}`)
    .max(MAX_LIMIT, `limite debe ser un entero entre 1 y ${MAX_LIMIT}`)
    .optional(),
});
const EstadoSchema = z.object({ entity_id: entityIds(MAX_STATE_IDS) });
const HistorialSchema = z.object({
  entity_id: entityIds(MAX_HISTORY_IDS),
  ...periodFields,
});
const ComprobarSchema = z.object({
  entity_id: entityId,
  atributo: z
    .string({ message: ATTRIBUTE_MSG })
    .trim()
    .regex(ATTRIBUTE_RE, ATTRIBUTE_MSG)
    .optional(),
});
const EncenderSchema = z.object({
  entity_id: entityIds(MAX_ACTION_IDS),
  brillo: z
    .number({ message: 'brillo debe ser un número entre 0 y 100' })
    .min(0, 'brillo debe ser un número entre 0 y 100')
    .max(100, 'brillo debe ser un número entre 0 y 100')
    .optional(),
});
const ApagarSchema = z.object({ entity_id: entityIds(MAX_ACTION_IDS) });
const AccionSchema = z.object({
  dominio: z
    .string({ message: 'dominio debe ser un texto (p. ej. lock)' })
    .regex(SERVICE_RE, 'dominio no es válido (minúsculas, números y _; p. ej. lock)'),
  servicio: z
    .string({ message: 'servicio debe ser un texto (p. ej. unlock)' })
    .regex(SERVICE_RE, 'servicio no es válido (minúsculas, números y _; p. ej. unlock)'),
  entity_id: entityIds(MAX_ACTION_IDS).optional(),
  datos: z.record(z.string(), z.unknown(), { message: 'datos debe ser un objeto' }).optional(),
});

// --- Salida ------------------------------------------------------------------

function areaText(areas: Map<string, string> | null, id: string): string {
  if (!areas) return NO_DATA;
  return areas.get(id) ?? 'sin área';
}

/** `entity_id — nombre — estado [unidad]`, con `— área` si se conoce. */
function stateLine(s: HaState, areas?: Map<string, string> | null): string {
  const base = `${s.entity_id} — ${friendlyName(s)} — ${stateText(s)}`;
  return areas === undefined ? base : `${base} — ${areaText(areas, s.entity_id)}`;
}

/** Estados devueltos por un servicio: un array o `{ changed_states: [...] }`. */
function changedStates(data: unknown): HaState[] {
  if (isRecord(data) && Array.isArray(data.changed_states)) return toStates(data.changed_states);
  return toStates(data);
}

// --- Comprobación de una entidad (M22) ---------------------------------------

/** Un número escrito tal cual: es lo que compara una condición. */
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** Un valor de Home Assistant como texto, o `null` si no se puede leer. */
function attrText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v) || isRecord(v)) return JSON.stringify(v);
  return null;
}

/** Recorta el detalle sin partir por la mitad lo que se enseña. */
function cutDetail(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

export function createHomeAssistantTools(
  opts: HomeAssistantOptions,
): ConnectorTool<string | ToolOutput>[] {
  const client = createHaClient(opts);
  const ws = createHaWs({ WebSocket: opts.WebSocket, url: opts.url, token: opts.token });

  function need(): HaClient {
    if (!client) throw notConfigured();
    return client;
  }

  async function callServices(
    c: HaClient,
    calls: Array<{ domain: string; service: string; body: Record<string, unknown> }>,
    signal?: AbortSignal,
  ): Promise<string> {
    const changed: HaState[] = [];
    for (const call of calls) {
      const data = await c.postJson(
        `/api/services/${call.domain}/${call.service}`,
        call.body,
        signal,
      );
      changed.push(...changedStates(data));
    }
    if (changed.length === 0) {
      return 'Hecho. Home Assistant no informó de cambios (puede tardar unos segundos; compruébalo con ha_estado).';
    }
    const shown = changed.slice(0, MAX_CHANGED).map((s) => `· ${stateLine(s)}`);
    const more = changed.length - shown.length;
    return [
      `Hecho. Estados que cambiaron (${changed.length}):`,
      ...shown,
      ...(more > 0 ? [`… y ${more} más.`] : []),
    ].join('\n');
  }

  /** Agrupa ids por dominio y los pasa por `pick` (servicio de ese dominio, o `null`). */
  function groupByDomain(
    ids: string[],
    pick: (domain: string) => string | null,
    verb: string,
  ): Array<{ domain: string; service: string; ids: string[] }> {
    const groups = new Map<string, { domain: string; service: string; ids: string[] }>();
    for (const id of ids) {
      const domain = domainOf(id);
      const service = pick(domain);
      if (!service) {
        throw new ToolUserError(
          `No puedo ${verb} «${id}» (dominio ${domain}) con esta tool: usa ha_accion con el servicio adecuado.`,
        );
      }
      const g = groups.get(domain) ?? { domain, service, ids: [] };
      g.ids.push(id);
      groups.set(domain, g);
    }
    return [...groups.values()];
  }

  const haResumen: ConnectorTool = {
    name: 'ha_resumen',
    description:
      'Primera tool que se usa con Home Assistant: nombre de la casa y versión, entidades por dominio y áreas ' +
      '(habitaciones) con su número de entidades. Después, busca con ha_buscar.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, signal) {
      const c = need();
      const [config, states, areas] = await Promise.all([
        c.getConfig(signal),
        c.getStates(signal),
        c.getAreas(signal),
      ]);
      const byDomain = new Map<string, number>();
      for (const s of states) {
        const d = domainOf(s.entity_id);
        byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
      }
      const domains = [...byDomain.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      const lines = [
        `Casa: ${config.name ?? NO_DATA} · Home Assistant ${config.version ?? NO_DATA}`,
        `Entidades: ${states.length} en ${domains.length} dominios`,
        ...domains.slice(0, MAX_DOMAINS).map(([d, n]) => `· ${d}: ${n}`),
      ];
      if (domains.length > MAX_DOMAINS) {
        lines.push(`… y ${domains.length - MAX_DOMAINS} dominios más.`);
      }
      if (areas === null) {
        lines.push(`Áreas: ${NO_DATA}`);
      } else {
        const perArea = new Map<string, number>();
        for (const s of states) {
          const a = areas.get(s.entity_id);
          if (a) perArea.set(a, (perArea.get(a) ?? 0) + 1);
        }
        const list = [...perArea.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (list.length === 0) {
          lines.push('Áreas: ninguna configurada');
        } else {
          lines.push(`Áreas (${list.length}):`);
          lines.push(...list.slice(0, MAX_AREAS).map(([a, n]) => `· ${a}: ${n} entidades`));
          if (list.length > MAX_AREAS) lines.push(`… y ${list.length - MAX_AREAS} áreas más.`);
        }
      }
      return lines.join('\n');
    },
  };

  const haBuscar: ConnectorTool = {
    name: 'ha_buscar',
    description:
      'Busca entidades por texto (nombre, id o área; sin acentos ni mayúsculas), dominio (light, switch, sensor…) ' +
      'o área. Devuelve una línea por entidad con id, nombre, estado y área. Hay que dar al menos un filtro.',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Texto a buscar en nombre, id y área.' },
        dominio: { type: 'string', description: 'Dominio de la entidad (p. ej. light, climate).' },
        area: { type: 'string', description: 'Nombre del área o habitación (p. ej. salón).' },
        limite: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Máximo de resultados (por defecto ${DEFAULT_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(BuscarSchema, args);
      if (!a.texto && !a.dominio && !a.area) {
        throw new ToolUserError(
          'Indica al menos un filtro: texto, dominio o area (usa ha_resumen para ver qué hay).',
        );
      }
      const [states, areas] = await Promise.all([c.getStates(signal), c.getAreas(signal)]);
      const words = a.texto ? normalizeName(a.texto).split(' ').filter(Boolean) : [];
      const wantedArea = a.area ? normalizeName(a.area) : '';
      if (wantedArea && areas === null) {
        throw new ToolUserError(
          'No pude obtener las áreas de Home Assistant, así que no puedo filtrar por area: busca por texto o dominio.',
        );
      }
      const found = states
        .filter((s) => {
          if (a.dominio && domainOf(s.entity_id) !== a.dominio) return false;
          const area = areas?.get(s.entity_id) ?? '';
          if (wantedArea && !normalizeName(area).includes(wantedArea)) return false;
          if (words.length > 0) {
            const hay = normalizeName(`${friendlyName(s)} ${s.entity_id} ${area}`);
            if (!words.every((w) => hay.includes(w))) return false;
          }
          return true;
        })
        .sort((x, y) => x.entity_id.localeCompare(y.entity_id));
      if (found.length === 0) {
        return 'No encontré ninguna entidad con ese filtro. Prueba con menos palabras o usa ha_resumen.';
      }
      const limit = a.limite ?? DEFAULT_LIMIT;
      const shown = found.slice(0, limit);
      const lines = [
        `Entidades encontradas (${found.length}):`,
        ...shown.map((s) => stateLine(s, areas)),
      ];
      if (found.length > shown.length) {
        lines.push(
          `… faltan ${found.length - shown.length} más: afina el filtro o sube limite (máx. ${MAX_LIMIT}).`,
        );
      }
      return lines.join('\n');
    },
  };

  const haEstado: ConnectorTool = {
    name: 'ha_estado',
    description:
      'Estado detallado de una entidad (o de hasta 20): valor y unidad, desde cuándo y sus atributos útiles ' +
      '(brillo, temperatura, reproducción, batería…). Si no sabes el id, usa ha_buscar.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_STATE_IDS },
          ],
          description: 'Un entity_id (light.salon) o una lista de hasta 20.',
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(EstadoSchema, args);
      const ids = idList(a.entity_id);
      const config = await c.getConfig(signal);
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return await c.getJson(`/api/states/${encodeURIComponent(id)}`, signal);
          } catch (err) {
            if (err instanceof HaNotFoundError && ids.length > 1) {
              return `${id}: no existe (usa ha_buscar).`;
            }
            throw err;
          }
        }),
      );
      const blocks = results.map((r) => {
        if (typeof r === 'string') return r;
        const s = toStates([r])[0];
        if (!s) return `Respuesta no válida de Home Assistant.`;
        return describeState(s, config.timeZone, config.temperatureUnit);
      });
      return blocks.join('\n\n');
    },
  };

  const now = opts.now ?? Date.now;

  const haHistorial: ConnectorTool = {
    name: 'ha_historial',
    description:
      'Historial de una entidad (o de hasta 10) en las últimas N horas (máx. 168, 7 días): estado al empezar, ' +
      'cambios con su hora, tiempo en cada estado y, en sensores numéricos, mínimo y máximo (por día si pasa de ' +
      '24 h). Para «¿cuándo se apagó…?», «¿cuánto rato estuvo encendida…?» o «¿qué temperatura hizo anoche?». ' +
      'Para un rato concreto, desde y hasta en hora de la casa en vez de horas. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_HISTORY_IDS },
          ],
          description: 'Un entity_id (light.salon) o una lista de hasta 10.',
        },
        horas: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_HISTORY_HOURS,
          description: `Las últimas N horas hasta ahora (por defecto ${DEFAULT_HISTORY_HOURS}; máx. ${MAX_HISTORY_HOURS}). No se combina con desde.`,
        },
        desde: {
          type: 'string',
          description:
            'Inicio del periodo en hora de la casa: AAAA-MM-DDTHH:MM, o AAAA-MM-DD (desde las 00:00). ' +
            'P. ej. 2026-11-19T21:00.',
        },
        hasta: {
          type: 'string',
          description:
            'Final del periodo en hora de la casa: AAAA-MM-DDTHH:MM, o AAAA-MM-DD (ese día entero incluido). ' +
            'Por defecto, ahora. Solo con desde; como mucho 7 días después de desde.',
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(HistorialSchema, args);
      const ids = idList(a.entity_id);
      assertPeriodArgs(a);
      const config = await c.getConfig(signal);
      const tz = config.timeZone;
      const { start, end, toNow, label } = resolvePeriod(a, tz, now());
      // Los ids ya pasaron ENTITY_RE: no llevan nada que escapar en la query.
      const path =
        `/api/history/period/${isoParam(start)}?filter_entity_id=${ids.join(',')}` +
        `&end_time=${isoParam(end)}&minimal_response`;
      const history = parseHistory(await c.getJson(path, signal));
      const maxChanges = Math.min(
        MAX_CHANGES_PER_ENTITY,
        Math.max(MIN_CHANGES_PER_ENTITY, Math.floor(HISTORY_CHANGES_BUDGET / ids.length)),
      );
      const blocks = ids.map((id) => {
        const h = history.get(id);
        if (!h) {
          return `${id}\nSin datos en ${label}: o no existe (usa ha_buscar) o Home Assistant no guarda su historial (recorder).`;
        }
        return describeHistory(h, {
          start,
          end,
          label,
          toNow,
          tz,
          maxChanges,
        });
      });
      return blocks.join('\n\n');
    },
  };

  const haComprobar: ConnectorTool<string | ToolOutput> = {
    name: 'ha_comprobar',
    description:
      'Estado de UNA entidad (o de uno de sus atributos), de solo lectura y además en forma estructurada: ' +
      'es la tool que comprueban los vigilantes, sin el modelo. No admite listas; para varias entidades ' +
      'usa ha_estado.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'La entidad, con la forma dominio.nombre (p. ej. light.salon).',
        },
        atributo: {
          type: 'string',
          description:
            'Atributo a comprobar en vez del estado (p. ej. current_temperature, battery_level).',
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        estado: { type: 'string' },
        valor: { type: ['number', 'null'] },
        detalle: { type: 'string' },
      },
      required: ['estado', 'valor', 'detalle'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(ComprobarSchema, args);
      let raw: unknown;
      try {
        raw = await c.getJson(`/api/states/${encodeURIComponent(a.entity_id)}`, signal);
      } catch (err) {
        if (err instanceof HaNotFoundError) {
          throw new ToolUserError(
            `La entidad ${a.entity_id} no existe, así que no hay nada que comprobar: usa ha_buscar para dar con la que quieres vigilar.`,
          );
        }
        throw err;
      }
      const s = toStates([raw])[0];
      if (!s) throw new ToolUserError(`Respuesta de Home Assistant no válida para ${a.entity_id}.`);
      // Sin `atributo`, el estado tal cual; con él, su valor como texto (o
      // `sin_dato`, que nunca es 0: un vigilante distingue «no lo sé» de «cero»).
      const attrValue =
        a.atributo !== undefined && Object.hasOwn(s.attributes, a.atributo)
          ? s.attributes[a.atributo]
          : undefined;
      const attr = a.atributo === undefined ? null : attrText(attrValue);
      const estado = a.atributo === undefined ? s.state : (attr ?? SIN_DATO);
      const valor =
        typeof attrValue === 'number' && Number.isFinite(attrValue)
          ? attrValue
          : NUMBER_RE.test(estado)
            ? Number(estado)
            : null;
      const detail = a.atributo === undefined ? '' : ` — ${a.atributo}: ${attr ?? NO_DATA}`;
      const text = [
        stateLine(s),
        `Para vigilantes: estado «${estado}», valor ${valor === null ? NO_DATA : String(valor)}`,
      ].join('\n');
      return {
        text,
        structured: {
          estado,
          valor,
          detalle: cutDetail(`${friendlyName(s)} — ${stateText(s)}${detail}`),
        },
      };
    },
  };

  const haEncender: ConnectorTool = {
    name: 'ha_encender',
    description:
      'Enciende una entidad (o hasta 10): luces, enchufes, ventiladores, climatización, automatizaciones, escenas y ' +
      'scripts; abre persianas (cover). Con brillo (0-100) solo en luces. Las cerraduras no: usa ha_accion.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ACTION_IDS },
          ],
          description: 'Un entity_id (light.salon) o una lista de hasta 10.',
        },
        brillo: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Brillo en % (solo luces).',
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(EncenderSchema, args);
      const ids = idList(a.entity_id);
      if (a.brillo !== undefined && ids.some((id) => domainOf(id) !== 'light')) {
        throw new ToolUserError('Argumento inválido: brillo solo se admite con entidades light.');
      }
      const groups = groupByDomain(ids, onService, 'encender');
      return callServices(
        c,
        groups.map((g) => ({
          domain: g.domain,
          service: g.service,
          body: {
            entity_id: g.ids,
            ...(a.brillo !== undefined ? { brightness_pct: a.brillo } : {}),
          },
        })),
        signal,
      );
    },
  };

  const haApagar: ConnectorTool = {
    name: 'ha_apagar',
    description:
      'Apaga una entidad (o hasta 10): luces, enchufes, ventiladores, climatización, automatizaciones; cierra ' +
      'persianas (cover). Escenas, scripts y cerraduras no: usa ha_accion para lo que no sea apagar.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ACTION_IDS },
          ],
          description: 'Un entity_id (light.salon) o una lista de hasta 10.',
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(ApagarSchema, args);
      const groups = groupByDomain(idList(a.entity_id), offService, 'apagar');
      return callServices(
        c,
        groups.map((g) => ({ domain: g.domain, service: g.service, body: { entity_id: g.ids } })),
        signal,
      );
    },
  };

  const haAccion: ConnectorTool = {
    name: 'ha_accion',
    description:
      'Llama a cualquier servicio de Home Assistant (dominio.servicio con datos opcionales). Es para lo que no ' +
      'cubren ha_encender y ha_apagar: cerraduras, alarma, escenas con parámetros, notificaciones. ' +
      'Siempre pide aprobación a la persona.',
    inputSchema: {
      type: 'object',
      properties: {
        dominio: { type: 'string', description: 'Dominio del servicio (p. ej. lock).' },
        servicio: { type: 'string', description: 'Servicio (p. ej. unlock).' },
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ACTION_IDS },
          ],
          description: 'Entidad o lista de hasta 10 a las que aplicar el servicio.',
        },
        datos: {
          type: 'object',
          description: 'Datos del servicio (máx. 2 KB). No incluyas entity_id aquí.',
        },
      },
      required: ['dominio', 'servicio'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(AccionSchema, args);
      if (a.datos) {
        if ('entity_id' in a.datos) {
          throw new ToolUserError(
            'Argumento inválido: datos no puede llevar entity_id (va aparte).',
          );
        }
        if (Buffer.byteLength(JSON.stringify(a.datos), 'utf8') > MAX_DATA_BYTES) {
          throw new ToolUserError('Argumento inválido: datos admite como máximo 2 KB en JSON.');
        }
      }
      const body: Record<string, unknown> = { ...(a.datos ?? {}) };
      if (a.entity_id !== undefined) body.entity_id = idList(a.entity_id);
      return callServices(c, [{ domain: a.dominio, service: a.servicio, body }], signal);
    },
  };

  const haAcceso = accessCheckTool(
    'ha_acceso',
    'Comprobación de acceso para el diagnóstico, de solo lectura y sin argumentos: llama a la API de Home Assistant y dice si el token sigue valiendo (estado «ok», «auth» o «unreachable»). No hace falta usarla salvo que la persona pregunte si la conexión funciona.',
    async (signal) => {
      await need().getJson('/api/', signal);
    },
  );

  // M27 fase 1: automatizaciones, trazas, registro y avisos, todo de solo lectura.
  const ctx: HaToolContext = {
    need,
    needWs(what) {
      need();
      if (!ws) throw new ToolUserError(`Esta versión no puede leer ${what} (falta WebSocket).`);
      return ws;
    },
    now,
    sleep: opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };

  return [
    haResumen,
    haBuscar,
    haEstado,
    haHistorial,
    haComprobar,
    haAcceso,
    haEncender,
    haApagar,
    haAccion,
    ...createAutomationTools(ctx),
    createLogbookTool(ctx),
    createRepairsTool(ctx),
    ...createConfigWriteTools(ctx),
  ];
}

// --- Detalle de un estado ----------------------------------------------------

const SHOWN_ATTRS = new Set([
  'friendly_name',
  'device_class',
  'brightness',
  'color_temp_kelvin',
  'temperature',
  'current_temperature',
  'hvac_action',
  'hvac_mode',
  'media_title',
  'media_artist',
  'volume_level',
  'battery_level',
  'current_position',
  'unit_of_measurement',
  'supported_features',
]);

function describeState(s: HaState, tz: string | null, tempUnit: string | null): string {
  const at = s.attributes;
  const str = (k: string): string | null =>
    typeof at[k] === 'string' && at[k] !== '' ? (at[k] as string) : null;
  const has = (k: string): boolean => at[k] !== undefined && at[k] !== null;
  const lines = [
    `${s.entity_id} — ${friendlyName(s)}`,
    `Estado: ${stateText(s)} (desde ${localTime(s.last_changed, tz)})`,
  ];
  const deviceClass = str('device_class');
  if (deviceClass) lines.push(`Clase: ${deviceClass}`);
  if (has('brightness')) lines.push(`Brillo: ${pct(at.brightness, 255)}`);
  if (has('color_temp_kelvin')) lines.push(`Temperatura de color: ${num(at.color_temp_kelvin)} K`);
  const degrees = (v: unknown): string =>
    num(v) === NO_DATA ? NO_DATA : `${num(v)} ${tempUnit ?? ''}`.trim();
  if (has('current_temperature'))
    lines.push(`Temperatura actual: ${degrees(at.current_temperature)}`);
  if (has('temperature')) lines.push(`Temperatura objetivo: ${degrees(at.temperature)}`);
  const action = str('hvac_action');
  if (action) lines.push(`Acción: ${action}`);
  const mode = str('hvac_mode');
  if (mode) lines.push(`Modo: ${mode}`);
  const title = str('media_title');
  if (title)
    lines.push(`Reproduciendo: ${title}${str('media_artist') ? ` — ${str('media_artist')}` : ''}`);
  if (has('volume_level')) lines.push(`Volumen: ${pct(at.volume_level, 1)}`);
  if (has('battery_level')) lines.push(`Batería: ${num(at.battery_level)} %`);
  if (has('current_position')) lines.push(`Posición: ${num(at.current_position)} %`);
  const others = Object.keys(at)
    .filter((k) => !SHOWN_ATTRS.has(k))
    .sort();
  if (others.length > 0) {
    const names = others.slice(0, MAX_OTHER_ATTRS).join(', ');
    lines.push(
      `Otros atributos: ${names}${others.length > MAX_OTHER_ATTRS ? `, … (${others.length - MAX_OTHER_ATTRS} más)` : ''}`,
    );
  }
  return lines.join('\n');
}

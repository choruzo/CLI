/**
 * Registro de Home Assistant (`ha_registro`, M27 fase 1, solo lectura): lee
 * `/api/logbook` y dice qué pasó y por qué (quién, qué automatización, qué
 * servicio). El registro es muy ruidoso (miles de cambios de un sensor de
 * movimiento en dos días): sin entidad se enseña solo lo que tiene causa y el
 * resto se resume. Nombres y mensajes son contenido no confiable (`safeField`).
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { isRecord, type HaState } from './client.js';
import {
  ENTITY_RE,
  assertPeriodArgs,
  entityIds,
  idList,
  isoParam,
  parseArgs,
  periodFields,
  resolvePeriod,
  type HaToolContext,
} from './args.js';
import { EXTERNAL_NOTE, NO_DATA, localTime, safeField } from './format.js';

const MAX_IDS = 10;
const MAX_ENTRIES = 40;
const MAX_NOISY = 5;

const LogbookSchema = z.object({
  entity_id: entityIds(MAX_IDS).optional(),
  ...periodFields,
});

interface Entry {
  at: number;
  when: string;
  raw: Record<string, unknown>;
}

interface Cause {
  text: string;
  /** El texto ya es el `message` de la entrada: no se repite como «qué». */
  usedMessage: boolean;
  /** Dice quién o qué lo hizo; «tras otro sensor» solo da contexto. */
  explains: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Un id que viene de HA: tal cual si tiene la forma de entity_id; si no, como campo. */
function idText(v: unknown): string {
  const s = str(v);
  if (s === null) return '';
  return ENTITY_RE.test(s) ? s : safeField(s, 60);
}

/** `user_id` → nombre, a partir de las entidades `person.*`. */
function peopleOf(states: HaState[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of states) {
    if (!s.entity_id.startsWith('person.')) continue;
    const uid = s.attributes.user_id;
    if (typeof uid !== 'string' || uid === '') continue;
    const name = s.attributes.friendly_name;
    const text = safeField(typeof name === 'string' && name !== '' ? name : s.entity_id, 60);
    map.set(uid, text || s.entity_id);
  }
  return map;
}

/** Por qué pasó, con la primera regla que aplique; `null` si el registro no lo dice. */
function causeOf(e: Record<string, unknown>, people: Map<string, string>): Cause | null {
  const user = str(e.context_user_id);
  if (user !== null) {
    return {
      text: `por ${people.get(user) ?? 'un usuario de HA (sin persona)'}`,
      usedMessage: false,
      explains: true,
    };
  }
  if (e.context_event_type === 'automation_triggered' || e.context_domain === 'automation') {
    const who =
      safeField(e.context_name, 80) ||
      safeField(e.context_entity_id_name, 80) ||
      idText(e.context_entity_id);
    return {
      text: who ? `por la automatización ${who}` : 'por una automatización',
      usedMessage: false,
      explains: true,
    };
  }
  const message = safeField(e.message, 160);
  if ((e.domain === 'automation' || e.domain === 'script') && message) {
    return { text: message, usedMessage: true, explains: true };
  }
  if (e.context_event_type === 'call_service') {
    const dom = safeField(e.context_domain, 40) || NO_DATA;
    const svc = safeField(e.context_service, 60) || NO_DATA;
    return { text: `por el servicio ${dom}.${svc}`, usedMessage: false, explains: true };
  }
  const ctxEntity = idText(e.context_entity_id);
  if (ctxEntity) {
    const name = safeField(e.context_entity_id_name, 60);
    const state = safeField(e.context_state, 40) || NO_DATA;
    return {
      text: `tras ${name ? `${name} (${ctxEntity})` : ctxEntity} → ${state}`,
      usedMessage: false,
      explains: false,
    };
  }
  return null;
}

function nameText(e: Record<string, unknown>): string {
  const id = idText(e.entity_id);
  const name = safeField(e.name, 80);
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id || NO_DATA;
}

function line(e: Entry, cause: Cause | null, tz: string | null): string {
  const state = safeField(e.raw.state, 60);
  const message = cause?.usedMessage ? '' : safeField(e.raw.message, 160);
  return [localTime(e.when, tz), nameText(e.raw), state || message, cause?.text]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' · ');
}

export function createLogbookTool(ctx: HaToolContext): ConnectorTool {
  return {
    name: 'ha_registro',
    description:
      'Registro de Home Assistant: qué pasó en casa y por qué (quién lo hizo, qué automatización o servicio), ' +
      'en las últimas N horas (máx. 168) o entre desde y hasta en hora de la casa. Sin entity_id solo enseña lo ' +
      'que tiene causa (persona, automatización, script, servicio) y resume el ruido; con entity_id (hasta 10), ' +
      'todo lo suyo. Para «¿quién encendió/abrió…?», «¿qué ha pasado en casa esta tarde?», «¿qué hizo la ' +
      'automatización X?». Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IDS },
          ],
          description: 'Un entity_id (light.salon) o una lista de hasta 10. Opcional.',
        },
        horas: {
          type: 'integer',
          minimum: 1,
          maximum: 168,
          description:
            'Las últimas N horas hasta ahora (por defecto 24; máx. 168). No se combina con desde.',
        },
        desde: {
          type: 'string',
          description:
            'Inicio del periodo en hora de la casa: AAAA-MM-DDTHH:MM, o AAAA-MM-DD (desde las 00:00).',
        },
        hasta: {
          type: 'string',
          description:
            'Final del periodo en hora de la casa: AAAA-MM-DDTHH:MM, o AAAA-MM-DD (ese día entero incluido). Por defecto, ahora. Solo con desde.',
        },
      },
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = ctx.need();
      const a = parseArgs(LogbookSchema, args);
      const ids = a.entity_id === undefined ? [] : idList(a.entity_id);
      assertPeriodArgs(a);
      const tz = (await c.getConfig(signal)).timeZone;
      const { start, end, label } = resolvePeriod(a, tz, ctx.now());
      // Los ids ya pasaron ENTITY_RE: no llevan nada que escapar en la query.
      const path =
        `/api/logbook/${isoParam(start)}?end_time=${isoParam(end)}` +
        (ids.length > 0 ? `&entity=${ids.join(',')}` : '');
      const [raw, states] = await Promise.all([c.getJson(path, signal), c.getStates(signal)]);
      if (!Array.isArray(raw)) {
        throw new ToolUserError('Respuesta de Home Assistant no válida para el registro.');
      }
      const people = peopleOf(states);
      const entries: Entry[] = raw
        .filter(isRecord)
        .flatMap((r) => {
          const when = str(r.when);
          const at = when === null ? Number.NaN : Date.parse(when);
          return when !== null && !Number.isNaN(at) ? [{ at, when, raw: r }] : [];
        })
        .sort((x, y) => x.at - y.at);

      if (entries.length === 0) {
        return `Sin entradas en el registro en ${label}${ids.length > 0 ? ' (o la entidad no existe; usa ha_buscar)' : ''}.`;
      }

      const rows = entries.map((e) => ({ e, cause: causeOf(e.raw, people) }));
      // Sin entidad, el ruido (cambios sin causa que lo explique) solo se cuenta.
      const kept = ids.length > 0 ? rows : rows.filter((r) => r.cause?.explains === true);
      const noise = ids.length > 0 ? [] : rows.filter((r) => r.cause?.explains !== true);

      const shown = kept.slice(-MAX_ENTRIES);
      const older = kept.length - shown.length;
      const out: string[] = [
        `Registro de Home Assistant en ${label}: ${kept.length} ${ids.length > 0 ? 'entradas' : 'entradas con causa'}.`,
      ];
      if (older > 0) out.push(`… y ${older} anteriores: pide un periodo más corto.`);
      out.push(...shown.map((r) => line(r.e, r.cause, tz)));
      if (noise.length > 0) {
        const perEntity = new Map<string, { text: string; n: number }>();
        for (const r of noise) {
          const key = idText(r.e.raw.entity_id) || nameText(r.e.raw);
          const cur = perEntity.get(key) ?? { text: nameText(r.e.raw), n: 0 };
          cur.n += 1;
          perEntity.set(key, cur);
        }
        const top = [...perEntity.values()]
          .sort((x, y) => y.n - x.n || x.text.localeCompare(y.text))
          .slice(0, MAX_NOISY)
          .map((t) => `${t.text} ×${t.n}`);
        out.push(
          `Además, ${noise.length} cambios de estado sin causa registrada; los que más: ${top.join(', ')}.`,
        );
      }
      out.push(EXTERNAL_NOTE);
      return out.join('\n');
    },
  };
}

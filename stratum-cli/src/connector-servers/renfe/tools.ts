/**
 * Tools del conector Renfe (Cercanías y Rodalies). Todas de solo lectura; cada
 * salida es texto breve en español ya masticado para un agente, con la
 * atribución de la licencia como última línea. El índice y el tiempo real se
 * inyectan para testear sin red.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import {
  RealtimeUse,
  estimateStops,
  platformOfLabel,
  type Estimate,
  type RealtimeSource,
  type ScheduledStop,
  type TripUpdate,
  type VehiclePosition,
} from './realtime.js';
import {
  serviceDays,
  type DepartureRow,
  type LineRow,
  type NucleoRow,
  type RenfeIndex,
  type ServiceDay,
  type StopInfo,
  type TripRow,
} from './queries.js';
import { dateEs, hhmm, hhmmOfEpoch, madridParts, parseClock } from './time.js';

export interface RenfeContext {
  /**
   * Abre el índice, ejecuta `fn` y lo cierra. Lanza `ToolUserError` si todavía no
   * hay índice («preparando los horarios…»).
   */
  withIndex<T>(fn: (ix: RenfeIndex) => Promise<T> | T): Promise<T>;
  /** Tiempo real; `null` = sin tiempo real (tests, modo sin red). */
  realtime: RealtimeSource | null;
  now?: () => Date;
}

interface Clock {
  date: Date;
  ymd: string;
  secs: number;
  epoch: number;
  days: ServiceDay[];
}

const MAX_BODY = 40;
const DEFAULT_TRANSFER_SEC = 180;

// --- Argumentos --------------------------------------------------------------

function text(name: string, max = 100) {
  const msg = `${name} debe ser un texto de 1 a ${max} caracteres`;
  return z.string({ message: msg }).trim().min(1, msg).max(max, msg);
}

const CLOCK_MSG = 'desde debe ser una hora "HH:MM" de hoy (hora de Madrid)';
const desde = z
  .string({ message: CLOCK_MSG })
  .trim()
  .regex(/^\d{1,2}:\d{2}$/, CLOCK_MSG)
  .optional();

function intRange(name: string, lo: number, hi: number) {
  const msg = `${name} debe ser un entero entre ${lo} y ${hi}`;
  return z.number({ message: msg }).int(msg).min(lo, msg).max(hi, msg).optional();
}

const NucleosSchema = z.object({ comunidad: text('comunidad').optional() });
const LineasSchema = z.object({ nucleo: text('nucleo') });
const EstacionesSchema = z.object({
  nucleo: text('nucleo').optional(),
  linea: text('linea').optional(),
  nombre: text('nombre').optional(),
});
const SalidasSchema = z.object({
  estacion: text('estacion'),
  linea: text('linea').optional(),
  destino: text('destino').optional(),
  desde,
  max: intRange('max', 1, 20),
});
const TrayectoSchema = z.object({
  origen: text('origen'),
  destino: text('destino'),
  desde,
  max: intRange('max', 1, 5),
});
const TrenSchema = z.object({ tren: text('tren', 60) });
const AvisosSchema = z.object({
  nucleo: text('nucleo').optional(),
  linea: text('linea').optional(),
  estacion: text('estacion').optional(),
});

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ToolUserError(`Argumento inválido: ${issue?.message ?? 'argumentos no válidos'}.`);
}

// --- Formato -----------------------------------------------------------------

export const NO_RT = 'sin datos de tiempo real';

export function attribution(feedDate: string, rtEpochSec: number | null): string {
  const parts = [`horarios del ${dateEs(feedDate)}`];
  if (rtEpochSec !== null) parts.push(`tiempo real de las ${hhmmOfEpoch(rtEpochSec)}`);
  return `Origen de los datos: Renfe Operadora (${parts.join('; ')})`;
}

/** `+4 min` / `-2 min` / `puntual`; con `, estimado` si el retraso se ha arrastrado. */
export function delayText(sec: number, kind: 'informed' | 'propagated' | null): string {
  const m = Math.round(sec / 60);
  const base = m === 0 ? 'puntual' : m > 0 ? `+${m} min` : `${m} min`;
  return kind === 'propagated' ? `${base}, estimado` : base;
}

function minutesUntil(estSecs: number, nowSecs: number): string | null {
  const m = Math.round((estSecs - nowSecs) / 60);
  if (m < 0) return null;
  return m === 0 ? 'ahora' : `en ${m} min`;
}

function lineLabel(ix: RenfeIndex, lineId: string): string {
  return ix.line(lineId)?.shortName ?? lineId;
}

function nucleoName(ix: RenfeIndex, nucleoId: string): string {
  return ix.nucleos().find((n) => n.id === nucleoId)?.name ?? nucleoId;
}

/** `C1, C2, C3` de las líneas que paran en una estación (acotado). */
function linesSummary(ix: RenfeIndex, stopId: string, max = 8): string {
  const lines = ix.linesAt(stopId);
  const nuc = new Set(lines.map((l) => ix.line(l)?.nucleo));
  const names = lines.map((l) => (nuc.size > 1 ? l : lineLabel(ix, l)));
  return names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', ');
}

function candidateLines(ix: RenfeIndex, stops: StopInfo[], max = 10): string {
  const shown = stops.slice(0, max).map((s, i) => {
    const nuc = ix
      .nucleosAt(s.stopId)
      .map((n) => nucleoName(ix, n))
      .join('/');
    return `${i + 1}. ${s.name} — ${nuc} · ${linesSummary(ix, s.stopId)} · id est:${s.stopId}`;
  });
  if (stops.length > max) shown.push(`… y ${stops.length - max} más.`);
  return shown.join('\n');
}

type Pick<T> = { ok: true; value: T } | { ok: false; text: string };

function pickStation(
  ix: RenfeIndex,
  raw: string,
  arg: string,
  tool: string,
  nucleo?: string,
): Pick<StopInfo> {
  const r = ix.resolveStation(raw, nucleo);
  if (r.kind === 'one') return { ok: true, value: r.value };
  if (r.kind === 'none') {
    throw new ToolUserError(
      `No conozco la estación «${raw}». Usa cercanias_estaciones con nombre: "${raw}" para ver candidatos${nucleo ? '' : ' (o con nucleo para acotar)'}.`,
    );
  }
  return {
    ok: false,
    text:
      `Hay varias estaciones que encajan con «${raw}»:\n${candidateLines(ix, r.values)}\n` +
      `Repite ${tool} con ${arg}: "est:<id>".`,
  };
}

function pickNucleo(ix: RenfeIndex, raw: string): Pick<NucleoRow> {
  const r = ix.resolveNucleo(raw);
  if (r.kind === 'one') return { ok: true, value: r.value };
  if (r.kind === 'none') {
    throw new ToolUserError(
      `No conozco el núcleo «${raw}». Usa cercanias_nucleos para ver los disponibles.`,
    );
  }
  return {
    ok: false,
    text:
      `«${raw}» abarca varios núcleos:\n${r.values.map((n, i) => `${i + 1}. ${n.name} (${n.id}) · ${n.nLines} ${n.nLines === 1 ? 'línea' : 'líneas'}`).join('\n')}\n` +
      'Repite con nucleo: "<id>".',
  };
}

function pickLine(ix: RenfeIndex, raw: string, nucleos?: string[]): Pick<LineRow> {
  const r = ix.resolveLine(raw, nucleos);
  if (r.kind === 'one') return { ok: true, value: r.value };
  if (r.kind === 'none') {
    const hint = nucleos?.length === 1 ? ` con nucleo: "${nucleos[0]}"` : '';
    throw new ToolUserError(
      `No conozco la línea «${raw}». Usa cercanias_lineas${hint} para ver sus ids (p. ej. "madrid/C1").`,
    );
  }
  return {
    ok: false,
    text: `Hay varias líneas «${raw}»:\n${r.values.map((l, i) => `${i + 1}. ${l.id} · ${l.longName}`).join('\n')}\nRepite con linea: "<id>".`,
  };
}

// --- Tiempo real por trayecto ------------------------------------------------

interface RtData {
  updates: Map<string, TripUpdate> | null;
  vehicles: Map<string, VehiclePosition> | null;
}

/** Estimaciones de un viaje, memorizadas por `tid` + día. */
class TripEstimates {
  private readonly cache = new Map<string, { stops: ScheduledStop[]; est: Estimate[] }>();

  constructor(
    private readonly ix: RenfeIndex,
    private readonly rt: RtData,
  ) {}

  get(tid: number, tripId: string, day: ServiceDay): { stops: ScheduledStop[]; est: Estimate[] } {
    const key = `${tid}@${day.ymd}`;
    let e = this.cache.get(key);
    if (!e) {
      const stops = this.ix.tripStops(tid);
      e = { stops, est: estimateStops(stops, this.rt.updates?.get(tripId), day.epoch) };
      this.cache.set(key, e);
    }
    return e;
  }

  at(tid: number, tripId: string, day: ServiceDay, seq: number): Estimate | undefined {
    const { stops, est } = this.get(tid, tripId, day);
    const i = stops.findIndex((s) => s.seq === seq);
    return i >= 0 ? est[i] : undefined;
  }
}

async function loadRt(rt: RealtimeUse, signal?: AbortSignal): Promise<RtData> {
  const [updates, vehicles] = await Promise.all([rt.tripUpdates(signal), rt.vehicles(signal)]);
  return { updates, vehicles };
}

// --- Las tools ---------------------------------------------------------------

export function createRenfeTools(ctx: RenfeContext): ConnectorTool[] {
  const nowFn = ctx.now ?? (() => new Date());

  function clock(): Clock {
    const date = nowFn();
    const p = madridParts(date);
    const days = serviceDays(p.ymd);
    return { date, ymd: p.ymd, secs: p.secs, epoch: Math.floor(date.getTime() / 1000), days };
  }

  /** Abre el índice, ejecuta la tool y añade la atribución (la última línea). */
  async function run(
    fn: (
      ix: RenfeIndex,
      rt: RealtimeUse,
      c: Clock,
    ) => Promise<string[] | string> | string[] | string,
  ): Promise<string> {
    return ctx.withIndex(async (ix) => {
      const rt = new RealtimeUse(ctx.realtime);
      const body = await fn(ix, rt, clock());
      const lines = Array.isArray(body) ? body : [body];
      return [...lines, attribution(ix.meta.feedDate, rt.latest)].join('\n');
    });
  }

  // cercanias_nucleos -----------------------------------------------------------
  const nucleos: ConnectorTool = {
    name: 'cercanias_nucleos',
    description:
      'Lista los núcleos de Cercanías y Rodalies agrupados por comunidad autónoma, con su id y su número de líneas. ' +
      'Empieza por aquí si no sabes en qué núcleo está lo que te piden. `comunidad` filtra (opcional).',
    inputSchema: {
      type: 'object',
      properties: {
        comunidad: {
          type: 'string',
          description: 'Comunidad autónoma para filtrar (p. ej. "Andalucía").',
        },
      },
      additionalProperties: false,
    },
    handler: (args) =>
      run((ix) => {
        const a = parseArgs(NucleosSchema, args);
        let all = ix.nucleos();
        if (a.comunidad) {
          const q = a.comunidad.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
          all = all.filter((n) =>
            n.comunidad.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').includes(q),
          );
          if (all.length === 0) {
            throw new ToolUserError(
              `No hay núcleos de «${a.comunidad}». Llama a cercanias_nucleos sin argumentos para ver todos.`,
            );
          }
        }
        const byCom = new Map<string, NucleoRow[]>();
        for (const n of all) byCom.set(n.comunidad, [...(byCom.get(n.comunidad) ?? []), n]);
        return [...byCom].map(
          ([com, list]) =>
            `${com}: ${list.map((n) => `${n.name} (${n.id}) · ${n.nLines} ${n.nLines === 1 ? 'línea' : 'líneas'}`).join(' | ')}`,
        );
      }),
  };

  // cercanias_lineas ------------------------------------------------------------
  const lineas: ConnectorTool = {
    name: 'cercanias_lineas',
    description:
      'Líneas de un núcleo (p. ej. "madrid"): id, extremos del recorrido y número de estaciones. Devuelve ids como "madrid/C3" que aceptan las demás tools.',
    inputSchema: {
      type: 'object',
      properties: {
        nucleo: { type: 'string', description: 'Id o nombre del núcleo ("madrid", "Rodalies").' },
      },
      required: ['nucleo'],
      additionalProperties: false,
    },
    handler: (args) =>
      run((ix) => {
        const a = parseArgs(LineasSchema, args);
        const n = pickNucleo(ix, a.nucleo);
        if (!n.ok) return n.text;
        const lines = ix.linesOf(n.value.id);
        const body = lines.slice(0, MAX_BODY).map((l) => {
          const stops = ix.lineStops(l.id);
          const ends =
            stops.length >= 2 ? `${stops[0]!.name} – ${stops[stops.length - 1]!.name}` : l.longName;
          return `${l.id} · ${ends} · ${l.nStops} estaciones`;
        });
        if (lines.length > MAX_BODY) body.push(`… y ${lines.length - MAX_BODY} líneas más.`);
        return [`Líneas de ${n.value.name} (${n.value.comunidad}):`, ...body];
      }),
  };

  // cercanias_estaciones --------------------------------------------------------
  const estaciones: ConnectorTool = {
    name: 'cercanias_estaciones',
    description:
      'Estaciones: con `linea` (id "madrid/C3" o "C3" + nucleo) lista las de esa línea en orden y sus transbordos; ' +
      'con `nombre` busca estaciones por nombre y devuelve candidatos con su id "est:<id>"; con solo `nucleo`, las de ese núcleo. ' +
      'Úsala para resolver un nombre ambiguo antes de pedir salidas o trayectos.',
    inputSchema: {
      type: 'object',
      properties: {
        nucleo: { type: 'string', description: 'Núcleo para acotar (opcional).' },
        linea: {
          type: 'string',
          description: 'Línea: id "madrid/C3" o nombre corto "C3" con nucleo.',
        },
        nombre: {
          type: 'string',
          description: 'Parte del nombre de la estación ("atocha", "pza catalunya").',
        },
      },
      additionalProperties: false,
    },
    handler: (args) =>
      run((ix) => {
        const a = parseArgs(EstacionesSchema, args);
        if (!a.linea && !a.nombre && !a.nucleo) {
          throw new ToolUserError(
            'Indica linea (lista sus estaciones), nombre (busca una estación) o nucleo. Si no sabes el núcleo, usa cercanias_nucleos.',
          );
        }
        let nucleoId: string | undefined;
        if (a.nucleo) {
          const n = pickNucleo(ix, a.nucleo);
          if (!n.ok) return n.text;
          nucleoId = n.value.id;
        }
        if (a.linea) {
          const l = pickLine(ix, a.linea, nucleoId ? [nucleoId] : undefined);
          if (!l.ok) return l.text;
          const stops = ix.lineStops(l.value.id);
          const body = stops.slice(0, MAX_BODY).map((s, i) => {
            const others = ix.linesAt(s.stopId).filter((x) => x !== l.value.id);
            const tr = others.length
              ? ` (transbordo: ${others.map((x) => (ix.line(x)?.nucleo === l.value.nucleo ? lineLabel(ix, x) : x)).join(', ')})`
              : '';
            return `${i + 1}. ${s.name}${tr} · id est:${s.stopId}`;
          });
          if (stops.length > MAX_BODY) {
            body.push(`… y ${stops.length - MAX_BODY} más (usa nombre para buscar una concreta).`);
          }
          return [`Estaciones de ${l.value.id} (${l.value.longName}):`, ...body];
        }
        if (a.nombre) {
          const hits = ix.searchStations(a.nombre, nucleoId);
          if (hits.length === 0) {
            return `No encontré ninguna estación que encaje con «${a.nombre}». Prueba con otra parte del nombre o sin nucleo.`;
          }
          const shown = hits.slice(0, MAX_BODY);
          const body = shown.map((s) => {
            const nuc = ix
              .nucleosAt(s.stopId)
              .map((n) => nucleoName(ix, n))
              .join('/');
            return `${s.name} — ${nuc} · ${linesSummary(ix, s.stopId)} · id est:${s.stopId}`;
          });
          if (hits.length > shown.length) {
            body.push(`… y ${hits.length - shown.length} más: afina el nombre o añade nucleo.`);
          }
          return [`Estaciones para «${a.nombre}» (${hits.length}):`, ...body];
        }
        // Solo núcleo: sus estaciones por orden alfabético.
        const all = ix.servedStops(nucleoId).sort((x, y) => x.name.localeCompare(y.name, 'es'));
        const body = all
          .slice(0, MAX_BODY)
          .map((s) => `${s.name} · ${linesSummary(ix, s.stopId)} · id est:${s.stopId}`);
        if (all.length > MAX_BODY) {
          body.push(`… y ${all.length - MAX_BODY} más: usa nombre o linea para acotar.`);
        }
        return [`Estaciones de ${nucleoName(ix, nucleoId!)} (${all.length}):`, ...body];
      }),
  };

  // cercanias_salidas -----------------------------------------------------------
  const salidas: ConnectorTool = {
    name: 'cercanias_salidas',
    description:
      'Próximas salidas de trenes desde una estación, ordenadas por hora estimada, con retraso, cancelación y vía si Renfe los informa. ' +
      '`destino` deja solo los trenes que después paran en esa estación ("¿cuándo sale el próximo a Alcalá desde Atocha?"); ' +
      '`linea` filtra por línea; `desde` ("HH:MM", hoy) cambia el inicio. Para ir de A a B con transbordos usa cercanias_trayecto.',
    inputSchema: {
      type: 'object',
      properties: {
        estacion: { type: 'string', description: 'Estación de salida: nombre o id "est:<id>".' },
        linea: { type: 'string', description: 'Línea ("C3" o "madrid/C3"), opcional.' },
        destino: {
          type: 'string',
          description: 'Estación por la que debe pasar después, opcional.',
        },
        desde: { type: 'string', description: 'Hora "HH:MM" de hoy; por defecto, ahora.' },
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Máximo de salidas (por defecto 8).',
        },
      },
      required: ['estacion'],
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(SalidasSchema, args);
        const max = a.max ?? 8;
        const st = pickStation(ix, a.estacion, 'estacion', 'cercanias_salidas');
        if (!st.ok) return st.text;
        const station = st.value;
        const nucleosOfStation = ix.nucleosAt(station.stopId);

        let lineFilter: string | null = null;
        if (a.linea) {
          const l = pickLine(ix, a.linea, nucleosOfStation);
          if (!l.ok) return l.text;
          lineFilter = l.value.id;
        }
        let destIds: string[] | null = null;
        let destName = '';
        if (a.destino) {
          const d = pickStation(ix, a.destino, 'destino', 'cercanias_salidas');
          if (!d.ok) return d.text;
          destIds = [d.value.stopId];
          destName = d.value.name;
        }
        let from = c.secs;
        if (a.desde) {
          const p = parseClock(a.desde);
          if (p === null || p >= 86400) throw new ToolUserError(`${CLOCK_MSG}.`);
          from = p;
        }
        if (c.days.every((d) => ix.activeServices(d.ymd).length === 0)) {
          throw new ToolUserError(
            `Los horarios que tengo (del ${dateEs(ix.meta.feedDate)}) no cubren hoy. Inténtalo más tarde, cuando se actualicen.`,
          );
        }

        const WINDOW = 4 * 3600;
        let rows = ix.departures([station.stopId], c.days, from - 1800, from + WINDOW);
        if (lineFilter) rows = rows.filter((r) => r.lineId === lineFilter);
        const data = rows.length > 0 ? await loadRt(rt, signal) : { updates: null, vehicles: null };
        const est = new TripEstimates(ix, data);

        interface Item {
          row: DepartureRow;
          e: Estimate | undefined;
          sortKey: number;
        }
        const items: Item[] = [];
        for (const row of rows) {
          const e = data.updates?.has(row.tripId)
            ? est.at(row.tid, row.tripId, row.day, row.seq)
            : undefined;
          const estDep = e?.status === 'ok' ? row.dep + (e.depDelay ?? 0) : row.dep;
          if (estDep < from) continue;
          items.push({ row, e, sortKey: estDep });
        }
        items.sort((x, y) => x.sortKey - y.sortKey);

        const shown: Item[] = [];
        let more = false;
        for (const it of items) {
          if (destIds && !ix.laterStop(it.row.tid, it.row.seq, destIds)) continue;
          if (shown.length === max) {
            more = true;
            break;
          }
          shown.push(it);
        }

        const where = `${station.name} (${nucleosOfStation.map((n) => nucleoName(ix, n)).join('/')})`;
        const head =
          `Salidas desde ${where}${lineFilter ? ` · línea ${lineLabel(ix, lineFilter)}` : ''}` +
          `${destName ? ` · hacia ${destName}` : ''} · desde las ${hhmm(from)}:`;
        if (shown.length === 0) {
          return [
            `No hay salidas desde ${where}${destName ? ` hacia ${destName}` : ''}${lineFilter ? ` en la línea ${lineLabel(ix, lineFilter)}` : ''} entre las ${hhmm(from)} y las ${hhmm(from + WINDOW)}.`,
            'Prueba con otra hora (desde) o sin filtros.',
          ];
        }
        const body = shown.map(({ row, e }) => {
          const to = row.lastStop ? ix.stopName(row.lastStop) : 'destino sin dato';
          const head2 = `${lineLabel(ix, row.lineId)} a ${to}`;
          if (e?.status === 'cancelled') return `${head2} · ${hhmm(row.dep)} · cancelado`;
          if (e?.status === 'skipped')
            return `${head2} · ${hhmm(row.dep)} · no para en esta estación`;
          const veh = data.vehicles?.get(row.tripId);
          const via = veh && veh.stopId === row.stopId ? platformOfLabel(veh.label) : null;
          const viaText = via ? ` · vía ${via}` : '';
          if (!e || e.status !== 'ok' || e.depDelay === null) {
            const mins = minutesUntil(row.dep, c.secs);
            return `${head2} · sale ${hhmm(row.dep)}${mins ? ` (${mins})` : ''} · ${NO_RT}${viaText}`;
          }
          const estDep = row.dep + e.depDelay;
          const mins = minutesUntil(estDep, c.secs);
          const sched = Math.round(e.depDelay / 60) !== 0 ? ` (horario ${hhmm(row.dep)})` : '';
          return `${head2} · sale ${hhmm(estDep)}${mins ? ` (${mins})` : ''} · ${delayText(e.depDelay, e.kind)}${sched}${viaText}`;
        });
        if (more) {
          const last = shown[shown.length - 1]!.sortKey;
          body.push(`Hay más salidas: pide desde: "${hhmm(last + 60)}".`);
        }
        return [head, ...body];
      }),
  };

  // cercanias_trayecto ----------------------------------------------------------
  const trayecto: ConnectorTool = {
    name: 'cercanias_trayecto',
    description:
      'Cómo ir de una estación a otra en Cercanías: trenes directos y, si no hay en las próximas 2 horas, opciones con un transbordo. ' +
      'Da hora de salida y llegada, duración, línea y retraso. `desde` ("HH:MM", hoy) cambia el inicio.',
    inputSchema: {
      type: 'object',
      properties: {
        origen: { type: 'string', description: 'Estación de origen: nombre o id "est:<id>".' },
        destino: { type: 'string', description: 'Estación de destino: nombre o id "est:<id>".' },
        desde: { type: 'string', description: 'Hora "HH:MM" de hoy; por defecto, ahora.' },
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Máximo de opciones (por defecto 3).',
        },
      },
      required: ['origen', 'destino'],
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(TrayectoSchema, args);
        const max = a.max ?? 3;
        const o = pickStation(ix, a.origen, 'origen', 'cercanias_trayecto');
        if (!o.ok) return o.text;
        const d = pickStation(ix, a.destino, 'destino', 'cercanias_trayecto');
        if (!d.ok) return d.text;
        if (o.value.stopId === d.value.stopId) {
          throw new ToolUserError(
            'El origen y el destino son la misma estación: indica dos distintas.',
          );
        }
        let from = c.secs;
        if (a.desde) {
          const p = parseClock(a.desde);
          if (p === null || p >= 86400) throw new ToolUserError(`${CLOCK_MSG}.`);
          from = p;
        }
        if (c.days.every((x) => ix.activeServices(x.ymd).length === 0)) {
          throw new ToolUserError(
            `Los horarios que tengo (del ${dateEs(ix.meta.feedDate)}) no cubren hoy. Inténtalo más tarde, cuando se actualicen.`,
          );
        }
        const O = [o.value.stopId];
        const D = [d.value.stopId];
        const head = `Trayectos de ${o.value.name} a ${d.value.name} desde las ${hhmm(from)}:`;
        const data = await loadRt(rt, signal);
        const est = new TripEstimates(ix, data);

        /** Salida/llegada estimadas (segundos de «hoy») y estado de un tramo. */
        const leg = (
          tid: number,
          tripId: string,
          day: ServiceDay,
          oseq: number,
          schedDep: number,
          dseq: number,
          schedArr: number,
        ) => {
          const eo = est.at(tid, tripId, day, oseq);
          const ed = est.at(tid, tripId, day, dseq);
          const dep = schedDep + (eo?.status === 'ok' ? (eo.depDelay ?? 0) : 0);
          const arr = schedArr + (ed?.status === 'ok' ? (ed.arrDelay ?? 0) : 0);
          const unusable = [eo, ed].some(
            (e) => e?.status === 'cancelled' || e?.status === 'skipped',
          );
          return { eo, dep, arr, cancelled: unusable };
        };
        const rtText = (e: Estimate | undefined): string =>
          e?.status === 'ok' && e.depDelay !== null ? delayText(e.depDelay, e.kind) : NO_RT;

        // 1) Directos en las próximas 2 h.
        const directRows = ix.direct(O, D, c.days, from - 900, from + 2 * 3600);
        const directs = directRows
          .map((r) => ({ r, l: leg(r.tid, r.tripId, r.day, r.oseq, r.odep, r.dseq, r.darr) }))
          .filter((x) => x.l.dep >= from);
        const live = directs.filter((x) => !x.l.cancelled).sort((x, y) => x.l.dep - y.l.dep);
        const cancelled = directs.length - live.length;
        if (live.length > 0) {
          const body = live.slice(0, max).map(({ r, l }) => {
            const dur = Math.round((l.arr - l.dep) / 60);
            return `${hhmm(l.dep)} → ${hhmm(l.arr)} (${dur} min) · ${lineLabel(ix, r.lineId)} · ${rtText(l.eo)}`;
          });
          const lines = [head, ...body];
          if (live.length > max)
            lines.push(`Hay más directos: pide desde: "${hhmm(live[max - 1]!.l.dep + 60)}".`);
          if (cancelled > 0) lines.push(`(Omitidos por cancelación o sin parada: ${cancelled}.)`);
          return lines;
        }

        // 2) Un transbordo.
        const legs1 = ix.legsFrom(O, c.days, from - 900, from + 2 * 3600);
        const legs2 = ix.legsTo(D, c.days, from - 900, from + 5 * 3600);
        const transfers = ix.transfers();
        const sameMin = (stop: string): number => {
          const t = transfers.get(stop)?.find((x) => x.to === stop && x.min !== null);
          return t?.min ?? DEFAULT_TRANSFER_SEC;
        };
        const byStop = new Map<string, typeof legs2>();
        for (const l2 of legs2) byStop.set(l2.xstop, [...(byStop.get(l2.xstop) ?? []), l2]);
        for (const list of byStop.values()) list.sort((x, y) => x.xdep - y.xdep);

        interface Combo {
          l1: (typeof legs1)[number];
          l2: (typeof legs2)[number];
        }
        const best = new Map<number, Combo>(); // por viaje del primer tramo
        for (const l1 of legs1) {
          if (l1.xstop === D[0] || l1.odep < from - 900) continue;
          const options = [
            { stop: l1.xstop, min: sameMin(l1.xstop) },
            ...(transfers.get(l1.xstop) ?? [])
              .filter((t) => t.to !== l1.xstop)
              .map((t) => ({ stop: t.to, min: t.min ?? 300 })),
          ];
          for (const opt of options) {
            const cand = byStop
              .get(opt.stop)
              ?.find((l2) => l2.tid !== l1.tid && l2.xdep >= l1.xarr + opt.min);
            if (!cand) continue;
            const cur = best.get(l1.tid);
            if (
              !cur ||
              cand.darr < cur.l2.darr ||
              (cand.darr === cur.l2.darr && l1.xarr < cur.l1.xarr)
            ) {
              best.set(l1.tid, { l1, l2: cand });
            }
          }
        }
        // Un mismo segundo tren: se queda quien sale más tarde; y fuera lo dominado.
        const per2 = new Map<number, Combo>();
        for (const cmb of best.values()) {
          const cur = per2.get(cmb.l2.tid);
          if (!cur || cmb.l1.odep > cur.l1.odep) per2.set(cmb.l2.tid, cmb);
        }
        const all = [...per2.values()];
        const combos = all
          .filter(
            (x) => !all.some((y) => y !== x && y.l1.odep >= x.l1.odep && y.l2.darr <= x.l2.darr),
          )
          .sort((x, y) => x.l1.odep - y.l1.odep);

        const rendered = combos
          .map((cmb) => {
            const a1 = leg(
              cmb.l1.tid,
              cmb.l1.tripId,
              cmb.l1.day,
              cmb.l1.oseq,
              cmb.l1.odep,
              cmb.l1.xseq,
              cmb.l1.xarr,
            );
            const a2 = leg(
              cmb.l2.tid,
              cmb.l2.tripId,
              cmb.l2.day,
              cmb.l2.xseq,
              cmb.l2.xdep,
              cmb.l2.dseq,
              cmb.l2.darr,
            );
            return { cmb, a1, a2 };
          })
          .filter((x) => !x.a1.cancelled && !x.a2.cancelled && x.a1.dep >= from);
        if (rendered.length === 0) {
          return [
            `No encontré trayectos de ${o.value.name} a ${d.value.name} desde las ${hhmm(from)}, ni directos ni con un transbordo en las próximas horas.`,
            'Prueba con otra hora (desde) o comprueba las estaciones con cercanias_estaciones.',
          ];
        }
        const body = rendered.slice(0, max).map(({ cmb, a1, a2 }) => {
          const dur = Math.round((a2.arr - a1.dep) / 60);
          const x = ix.stopName(cmb.l1.xstop);
          const x2 =
            cmb.l2.xstop !== cmb.l1.xstop ? ` (a pie hasta ${ix.stopName(cmb.l2.xstop)})` : '';
          return (
            `${hhmm(a1.dep)} ${lineLabel(ix, cmb.l1.lineId)} → ${x} ${hhmm(a1.arr)}${x2} · ` +
            `cambio a ${lineLabel(ix, cmb.l2.lineId)} ${hhmm(a2.dep)} → ${d.value.name} ${hhmm(a2.arr)} (${dur} min) · ${rtText(a1.eo)}`
          );
        });
        return [
          `No hay trenes directos de ${o.value.name} a ${d.value.name} en las próximas 2 h; con un transbordo desde las ${hhmm(from)}:`,
          ...body,
        ];
      }),
  };

  // cercanias_tren --------------------------------------------------------------
  const tren: ConnectorTool = {
    name: 'cercanias_tren',
    description:
      'Estado de un tren concreto: línea, destino, dónde está, retraso, vía y sus próximas 5 paradas con hora estimada. ' +
      '`tren` es el número corto que ve la gente ("23537", o "C1-23537") o el trip_id completo.',
    inputSchema: {
      type: 'object',
      properties: { tren: { type: 'string', description: 'Número del tren ("23537") o trip_id.' } },
      required: ['tren'],
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(TrenSchema, args);
        const raw = a.tren.trim();
        // Candidatos (viaje, día de servicio) que circulan hoy.
        let trips: TripRow[] = [];
        const exact = ix.trip(raw);
        if (exact) trips = [exact];
        else {
          const num = /(\d{3,})/.exec(raw)?.[1];
          trips = num ? ix.tripsByNumber(num) : [];
        }
        if (trips.length === 0) {
          throw new ToolUserError(
            `No conozco el tren «${raw}». Usa cercanias_salidas en una estación para ver los números de los trenes, o pásame el trip_id.`,
          );
        }
        const pairs = trips.flatMap((t) =>
          c.days
            .filter((d) => ix.activeServices(d.ymd).includes(t.serviceId))
            .map((d) => ({ t, d })),
        );
        if (pairs.length === 0) {
          throw new ToolUserError(`El tren «${raw}» no circula hoy según los horarios que tengo.`);
        }
        const running = pairs.filter(({ t, d }) => {
          const stops = ix.tripStops(t.tid);
          if (stops.length === 0) return false;
          const nowRaw = c.secs + d.offset;
          return nowRaw >= stops[0]!.dep - 3600 && nowRaw <= stops[stops.length - 1]!.arr + 3600;
        });
        const todays = pairs.filter((p) => p.d.offset === 0);
        const chosen = running.length > 0 ? running : todays.length > 0 ? todays : pairs;
        if (chosen.length > 1) {
          return [
            `Hay varios trenes «${raw}» hoy:`,
            ...chosen.slice(0, 10).map(({ t }, i) => {
              const stops = ix.tripStops(t.tid);
              return `${i + 1}. ${lineLabel(ix, t.lineId)} · ${ix.stopName(stops[0]!.stopId)} → ${ix.stopName(stops[stops.length - 1]!.stopId)} · sale ${hhmm(stops[0]!.dep)} · trip_id ${t.tripId}`;
            }),
            'Repite con tren: "<trip_id>".',
          ];
        }
        const { t, d } = chosen[0]!;
        const data = await loadRt(rt, signal);
        const est = new TripEstimates(ix, data);
        const { stops, est: ests } = est.get(t.tid, t.tripId, d);
        const veh = data.vehicles?.get(t.tripId);
        const upd = data.updates?.get(t.tripId);
        const nowRaw = c.secs + d.offset;
        const nameAt = (i: number): string => ix.stopName(stops[i]!.stopId);
        const first = stops[0]!;
        const last = stops[stops.length - 1]!;
        const lineId = t.lineId;
        const nuc = nucleoName(ix, ix.line(lineId)?.nucleo ?? '');
        const lines = [
          `Tren ${t.shortName ?? t.tripId} · ${lineLabel(ix, lineId)} a ${ix.stopName(last.stopId)} (${nuc}) · de ${ix.stopName(first.stopId)} ${hhmm(first.dep)} a ${hhmm(last.arr)}`,
        ];

        // Estado
        const vi = veh?.stopId ? stops.findIndex((s) => s.stopId === veh.stopId) : -1;
        let estado: string;
        if (upd?.relationship === 'CANCELED') estado = 'cancelado';
        else if (veh && vi >= 0 && veh.status === 'STOPPED_AT') estado = `en ${nameAt(vi)}`;
        else if (veh && vi >= 0 && veh.status === 'INCOMING_AT')
          estado = `llegando a ${nameAt(vi)}`;
        else if (veh && vi > 0) estado = `entre ${nameAt(vi - 1)} y ${nameAt(vi)}`;
        else if (veh && vi === 0) estado = `saliendo de ${nameAt(0)}`;
        else if (nowRaw < first.dep)
          estado = `aún no ha salido (sale de ${nameAt(0)} a las ${hhmm(first.dep)})`;
        else if (nowRaw > last.arr + 600) estado = 'ya ha terminado su recorrido';
        else estado = `sin posición en tiempo real`;
        const pos =
          veh?.latitude !== undefined && veh.longitude !== undefined
            ? ` (posición ${veh.latitude.toFixed(4)}, ${veh.longitude.toFixed(4)})`
            : '';
        lines.push(`Estado: ${estado}${pos}`);

        // Próximas paradas (hora estimada ≥ ahora) y retraso de la próxima.
        const upcoming: number[] = [];
        for (let i = 0; i < stops.length && upcoming.length < 5; i++) {
          const e = ests[i]!;
          const arr = stops[i]!.arr + (e.status === 'ok' ? (e.arrDelay ?? 0) : 0);
          if (arr >= nowRaw - 60 || (vi >= 0 && i >= vi)) upcoming.push(i);
        }
        const nextIdx = upcoming.find((i) => ests[i]!.status !== 'skipped');
        const ne = nextIdx !== undefined ? ests[nextIdx] : undefined;
        if (upd?.relationship !== 'CANCELED') {
          lines.push(
            ne?.status === 'ok' && ne.arrDelay !== null
              ? `Retraso: ${delayText(ne.arrDelay, ne.kind)}`
              : `Retraso: ${NO_RT}`,
          );
        }
        const via = platformOfLabel(veh?.label);
        if (via) lines.push(`Vía: ${via}${vi >= 0 ? ` (en ${nameAt(vi)})` : ''}`);
        if (upcoming.length > 0 && upd?.relationship !== 'CANCELED') {
          lines.push('Próximas paradas:');
          for (const i of upcoming) {
            const e = ests[i]!;
            const s = stops[i]!;
            if (e.status === 'skipped') lines.push(`· ${nameAt(i)} · no para en esta estación`);
            else if (e.status === 'ok' && e.arrDelay !== null) {
              lines.push(
                `· ${nameAt(i)} · ${hhmm(s.arr + e.arrDelay)} (${delayText(e.arrDelay, e.kind)}; horario ${hhmm(s.arr)})`,
              );
            } else lines.push(`· ${nameAt(i)} · ${hhmm(s.arr)} (${NO_RT})`);
          }
        }
        return lines;
      }),
  };

  // cercanias_avisos ------------------------------------------------------------
  const avisos: ConnectorTool = {
    name: 'cercanias_avisos',
    description:
      'Avisos e incidencias activos de Renfe (paros, obras, retrasos, cortes) filtrados por núcleo, línea y/o estación. ' +
      'Úsala ante «¿hay incidencias en la R2?». Sin ningún filtro devuelve solo cuántos hay por núcleo.',
    inputSchema: {
      type: 'object',
      properties: {
        nucleo: { type: 'string', description: 'Núcleo ("madrid", "rodalies"…), opcional.' },
        linea: { type: 'string', description: 'Línea ("R2", "madrid/C3"), opcional.' },
        estacion: { type: 'string', description: 'Estación (nombre o "est:<id>"), opcional.' },
      },
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(AvisosSchema, args);
        let nucleoRow: NucleoRow | undefined;
        if (a.nucleo) {
          const n = pickNucleo(ix, a.nucleo);
          if (!n.ok) return n.text;
          nucleoRow = n.value;
        }
        let lineRow: LineRow | undefined;
        if (a.linea) {
          const l = pickLine(ix, a.linea, nucleoRow ? [nucleoRow.id] : undefined);
          if (!l.ok) return l.text;
          lineRow = l.value;
        }
        let station: StopInfo | undefined;
        if (a.estacion) {
          const s = pickStation(ix, a.estacion, 'estacion', 'cercanias_avisos', nucleoRow?.id);
          if (!s.ok) return s.text;
          station = s.value;
        }
        const alerts = await rt.alerts(signal);
        const scope = [nucleoRow?.name, lineRow?.id, station?.name].filter(Boolean).join(' · ');
        if (!alerts) {
          return `Sin datos de tiempo real: ahora mismo no puedo consultar los avisos de Renfe${scope ? ` (${scope})` : ''}.`;
        }
        const active = alerts.filter(
          (al) =>
            al.periods.length === 0 ||
            al.periods.some(
              (p) =>
                (p.start === undefined || p.start <= c.epoch) &&
                (p.end === undefined || p.end === 0 || p.end >= c.epoch),
            ),
        );

        // A qué líneas y estaciones se refiere un aviso.
        const lineOf = new Map<string, string | undefined>();
        const routeLine = (routeId: string): string | undefined => {
          if (!lineOf.has(routeId)) lineOf.set(routeId, ix.lineOfRoute(routeId));
          return lineOf.get(routeId);
        };
        const refs = (al: (typeof active)[number]) => {
          const lines = new Set<string>();
          const stops = new Set<string>();
          for (const e of al.entities) {
            if (e.routeId) {
              const l = routeLine(e.routeId);
              if (l) lines.add(l);
            }
            if (e.tripId) {
              const l = ix.trip(e.tripId)?.lineId;
              if (l) lines.add(l);
            }
            if (e.stopId) stops.add(e.stopId);
          }
          return { lines, stops };
        };

        const filtered = active.filter((al) => {
          const { lines, stops } = refs(al);
          if (nucleoRow) {
            const inNucleo =
              [...lines].some((l) => ix.line(l)?.nucleo === nucleoRow.id) ||
              [...stops].some((s) => ix.nucleosAt(s).includes(nucleoRow.id));
            if (!inNucleo) return false;
          }
          if (lineRow) {
            const lineStops = new Set(ix.lineStops(lineRow.id).map((s) => s.stopId));
            if (!lines.has(lineRow.id) && ![...stops].some((s) => lineStops.has(s))) return false;
          }
          if (station) {
            const here = new Set(ix.linesAt(station.stopId));
            if (!stops.has(station.stopId) && ![...lines].some((l) => here.has(l))) return false;
          }
          return true;
        });

        if (!nucleoRow && !lineRow && !station) {
          const per = new Map<string, number>();
          for (const al of filtered) {
            const { lines, stops } = refs(al);
            const ns = new Set<string>();
            for (const l of lines) ns.add(ix.line(l)?.nucleo ?? '');
            for (const s of stops) for (const n of ix.nucleosAt(s)) ns.add(n);
            ns.delete('');
            for (const n of ns) per.set(n, (per.get(n) ?? 0) + 1);
          }
          if (filtered.length === 0) return 'Sin avisos activos ahora mismo.';
          const sum = [...per]
            .sort((x, y) => y[1] - x[1])
            .map(([n, k]) => `${nucleoName(ix, n)} ${k}`);
          return [
            `Hay ${filtered.length} avisos activos${sum.length ? ` (${sum.join(', ')})` : ''}.`,
            'Pide los de un núcleo, línea o estación con nucleo, linea o estacion.',
          ];
        }
        if (filtered.length === 0) return `Sin avisos activos para ${scope}.`;

        const MAX_ALERTS = 8;
        const sorted = [...filtered].sort(
          (x, y) =>
            Math.max(0, ...y.periods.map((p) => p.start ?? 0)) -
            Math.max(0, ...x.periods.map((p) => p.start ?? 0)),
        );
        const body = sorted.slice(0, MAX_ALERTS).map((al) => {
          const { lines, stops } = refs(al);
          const names = [...lines].map((l) => {
            const row = ix.line(l);
            return row ? row.shortName : l;
          });
          const nuc = [
            ...new Set([...lines].map((l) => ix.line(l)?.nucleo).filter((x): x is string => !!x)),
          ].map((n) => nucleoName(ix, n));
          let where = '';
          if (names.length > 0) {
            const shown = names.slice(0, 6).join(', ');
            where =
              `${nuc.join('/')} ${shown}${names.length > 6 ? ` y ${names.length - 6} más` : ''}`.trim();
          } else if (stops.size > 0) {
            const sn = [...stops].slice(0, 3).map((s) => ix.stopName(s));
            where = `${sn.join(', ')}${stops.size > 3 ? ` y ${stops.size - 3} más` : ''}`;
          }
          const start = Math.max(0, ...al.periods.map((p) => p.start ?? 0));
          const when =
            start > 0
              ? ` (desde ${madridParts(new Date(start * 1000)).ymd === c.ymd ? hhmmOfEpoch(start) : dateEs(madridParts(new Date(start * 1000)).ymd)})`
              : '';
          const head = al.header?.trim();
          const desc = al.description?.trim();
          let txt =
            head && desc && head !== desc
              ? `${head}: ${desc}`
              : (desc ?? head ?? 'Aviso sin texto');
          txt = txt.replace(/\s+/g, ' ');
          if (txt.length > 300) txt = `${txt.slice(0, 297)}…`;
          return `· ${where ? `[${where}] ` : ''}${txt}${when}`;
        });
        if (sorted.length > MAX_ALERTS) {
          body.push(`… y ${sorted.length - MAX_ALERTS} avisos más: afina con linea o estacion.`);
        }
        return [`Avisos activos para ${scope} (${sorted.length}):`, ...body];
      }),
  };

  return [nucleos, lineas, estaciones, salidas, trayecto, tren, avisos];
}

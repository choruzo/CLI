/**
 * Tools de larga y media distancia del conector Renfe (AVE, AVLO, Alvia,
 * Intercity, Euromed, MD, Regional…): `trenes_salidas`, `trenes_trayecto` y
 * `trenes_tren`. Todas de solo lectura; cada salida es texto breve en español ya
 * masticado para un agente, con la atribución de la licencia como última línea.
 *
 * Particularidades del GTFS de larga distancia (medidas sobre el feed real):
 * un mismo tren viene como varios viajes (variantes por tramo comercial, con el
 * mismo número y las mismas horas) que aquí se funden por número + hora de paso;
 * el `trip_id` no dice el día de circulación (lo dicen `calendar` y
 * `calendar_dates`); el tiempo real repite entidades por viaje, trae `SKIPPED`
 * contradictorios (se ignoran) y marca como `CANCELED` los viajes cancelados.
 * Las tools aceptan `fecha`, pero el tiempo real solo se aplica a hoy.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { normalizeName } from './normalize.js';
import type { LdDepartureRow, LdDirectRow, LdIndex, LdStop, LdTrip } from './queries-ld.js';
import type { ServiceDay, StopInfo } from './queries.js';
import {
  RealtimeUse,
  estimateStops,
  type Estimate,
  type RealtimeSource,
  type TripUpdate,
  type VehiclePosition,
} from './realtime.js';
import { NO_RT, delayText, intRange, minutesUntil, parseArgs, text } from './tools.js';
import {
  addDays,
  dateEs,
  hhmm,
  hhmmOfEpoch,
  madridEpochMs,
  madridParts,
  parseClock,
} from './time.js';

export interface TrenesContext {
  /**
   * Abre el índice de larga distancia, ejecuta `fn` y lo cierra. Lanza
   * `ToolUserError` si todavía no hay índice («preparando los horarios…»).
   */
  withIndex<T>(fn: (ix: LdIndex) => Promise<T> | T): Promise<T>;
  /** Tiempo real de larga distancia; `null` = sin tiempo real (tests, modo sin red). */
  realtime: RealtimeSource | null;
  now?: () => Date;
}

interface Clock {
  ymd: string;
  secs: number;
  epoch: number;
}

/** Paradas del recorrido que enseña `trenes_tren` como máximo. */
const MAX_STOPS = 25;
/** Un tren que debería haber terminado hace menos de esto (s) aún cuenta como en marcha. */
const FINISH_GRACE = 600;

// --- Argumentos --------------------------------------------------------------

const FECHA_MSG = 'fecha debe ser "YYYY-MM-DD", "hoy" o "mañana"';
const fecha = z
  .string({ message: FECHA_MSG })
  .trim()
  .min(1, FECHA_MSG)
  .max(30, FECHA_MSG)
  .optional();

const CLOCK_MSG = 'desde debe ser una hora "HH:MM"';
const desde = z
  .string({ message: CLOCK_MSG })
  .trim()
  .regex(/^\d{1,2}:\d{2}$/, CLOCK_MSG)
  .optional();

const SalidasSchema = z.object({
  estacion: text('estacion'),
  destino: text('destino').optional(),
  producto: text('producto', 40).optional(),
  fecha,
  desde,
  max: intRange('max', 1, 20),
});
const TrayectoSchema = z.object({
  origen: text('origen'),
  destino: text('destino'),
  fecha,
  desde,
  max: intRange('max', 1, 8),
});
const TrenSchema = z.object({ tren: text('tren', 60), fecha });

// --- Formato -----------------------------------------------------------------

export function attributionLd(feedDate: string, rtEpochSec: number | null): string {
  const parts = [`horarios de larga distancia del ${dateEs(feedDate)}`];
  if (rtEpochSec !== null) parts.push(`tiempo real de las ${hhmmOfEpoch(rtEpochSec)}`);
  return `Origen de los datos: Renfe Operadora (${parts.join('; ')})`;
}

/** Nombre de cara a la persona de un producto del feed (`ALVIA` → `Alvia`). */
const PRODUCT_LABELS: Record<string, string> = {
  AVE: 'AVE',
  AVLO: 'AVLO',
  ALVIA: 'Alvia',
  EUROMED: 'Euromed',
  MD: 'MD',
  AVANT: 'Avant',
  'AVANT EXP': 'Avant Exprés',
  'AVE INT': 'AVE Internacional',
  REGIONAL: 'Regional',
  'REG.EXP.': 'Regional Exprés',
  PROXIMDAD: 'Proximidad',
  TRENCELTA: 'Tren Celta',
};

export function productLabel(raw: string): string {
  return PRODUCT_LABELS[raw.toUpperCase()] ?? raw;
}

/** `45 min`, `2 h`, `2 h 42 min`. */
function durText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** Hora de llegada; pasadas las 24:00 del día de servicio se avisa («del día siguiente»). */
function arrText(secs: number): string {
  return secs >= 86400 ? `${hhmm(secs)} del día siguiente` : hhmm(secs);
}

function isoOf(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** `AVE 3123`: producto y número tal como los dice la gente. */
function trainName(t: { product: string; number: string | null }): string {
  return `${productLabel(t.product)}${t.number ? ` ${t.number}` : ''}`;
}

// --- Fechas ------------------------------------------------------------------

/** `fecha` → `YYYYMMDD`: `hoy`, `mañana`, `pasado mañana` o `YYYY-MM-DD`; por defecto, hoy. */
function parseFecha(raw: string | undefined, todayYmd: string): string {
  if (raw === undefined) return todayYmd;
  const q = normalizeName(raw);
  if (q === 'hoy') return todayYmd;
  if (q === 'manana') return addDays(todayYmd, 1);
  if (q === 'pasado manana') return addDays(todayYmd, 2);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (m) {
    const ymd = `${m[1]}${m[2]}${m[3]}`;
    // `addDays` normaliza una fecha imposible (2026-02-30 → 2026-03-02): no coincide.
    if (addDays(ymd, 0) === ymd) return ymd;
  }
  throw new ToolUserError(`${FECHA_MSG}.`);
}

/** El día pedido ha de caer dentro de lo que cubren los horarios. */
function checkRange(ix: LdIndex, ymd: string): void {
  const { firstDate, lastDate } = ix.meta;
  if (!firstDate || !lastDate) return;
  if (ymd < firstDate || ymd > lastDate) {
    throw new ToolUserError(
      `No tengo horarios de larga distancia para el ${dateEs(ymd)}: los que tengo cubren del ${dateEs(firstDate)} al ${dateEs(lastDate)}.`,
    );
  }
}

/** Día pedido y el anterior (por los trenes que pasan de las 24:00 y siguen en marcha). */
function daysFor(ymd: string): ServiceDay[] {
  const mk = (d: string, offset: number): ServiceDay => ({
    ymd: d,
    offset,
    epoch: Math.round(madridEpochMs(d, 0) / 1000),
  });
  return [mk(ymd, 0), mk(addDays(ymd, -1), 86400)];
}

function parseDesde(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const p = parseClock(raw);
  if (p === null || p >= 86400) throw new ToolUserError(`${CLOCK_MSG}.`);
  return p;
}

// --- Resolución de nombres ---------------------------------------------------

type Pick<T> = { ok: true; value: T } | { ok: false; text: string };

function pickStation(ix: LdIndex, raw: string, arg: string, tool: string): Pick<StopInfo> {
  const r = ix.resolveStation(raw);
  if (r.kind === 'one') return { ok: true, value: r.value };
  if (r.kind === 'none') {
    throw new ToolUserError(
      `No encuentro ninguna estación de larga distancia que encaje con «${raw}». Prueba solo con la ciudad («Zaragoza») o sin acentos; si es una estación de Cercanías, usa las tools cercanias_*.`,
    );
  }
  const shown = r.values.slice(0, 10).map((s, i) => `${i + 1}. ${s.name} · id ld:${s.stopId}`);
  if (r.values.length > 10) shown.push(`… y ${r.values.length - 10} más: afina el nombre.`);
  return {
    ok: false,
    text: `Hay varias estaciones que encajan con «${raw}»:\n${shown.join('\n')}\nRepite ${tool} con ${arg}: "ld:<id>".`,
  };
}

/** Productos del feed que encajan con lo pedido (`AVE`, `alvia`…), sin distinguir mayúsculas ni acentos. */
function resolveProducts(ix: LdIndex, raw: string): string[] {
  const q = normalizeName(raw);
  const all = ix.products();
  const hits = all.filter((p) => normalizeName(p) === q || normalizeName(productLabel(p)) === q);
  if (hits.length === 0) {
    throw new ToolUserError(
      `No conozco el producto «${raw}». Los que hay: ${all.map(productLabel).join(', ')}.`,
    );
  }
  return hits;
}

// --- Tiempo real -------------------------------------------------------------

interface RtData {
  updates: Map<string, TripUpdate> | null;
  vehicles: Map<string, VehiclePosition> | null;
}

const NO_RT_DATA: RtData = { updates: null, vehicles: null };

async function loadRt(rt: RealtimeUse, signal?: AbortSignal): Promise<RtData> {
  const [updates, vehicles] = await Promise.all([
    rt.mergedTripUpdates(signal),
    rt.vehicles(signal),
  ]);
  return { updates, vehicles };
}

/** Estimaciones de un viaje, memorizadas por `tid` + día. */
class LdEstimates {
  private readonly cache = new Map<string, { stops: LdStop[]; est: Estimate[] }>();

  constructor(
    private readonly ix: LdIndex,
    private readonly rt: RtData,
  ) {}

  get(tid: number, tripId: string, day: ServiceDay): { stops: LdStop[]; est: Estimate[] } {
    const key = `${tid}@${day.ymd}`;
    let e = this.cache.get(key);
    if (!e) {
      const stops = this.ix.tripStops(tid);
      e = {
        stops,
        est: estimateStops(stops, this.rt.updates?.get(tripId), day.epoch, { ignoreSkipped: true }),
      };
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

/**
 * De las variantes de un mismo tren, la que se enseña: la que tiene tiempo real
 * (una viva antes que una cancelada), luego la de más paradas (el recorrido
 * completo) y, a igualdad, la primera.
 */
function pickVariant<R extends { tid: number; tripId: string; nStops: number }>(
  rows: R[],
  rt: RtData,
): R {
  const score = (r: R): number => {
    const u = rt.updates?.get(r.tripId);
    return u ? (u.relationship === 'CANCELED' ? 1 : 2) : 0;
  };
  return rows.reduce((best, r) => {
    const a = score(r);
    const b = score(best);
    if (a !== b) return a > b ? r : best;
    if (r.nStops !== best.nStops) return r.nStops > best.nStops ? r : best;
    return r.tid < best.tid ? r : best;
  });
}

/** Agrupa filas por clave conservando el orden de aparición. */
function groupBy<R>(rows: R[], key: (r: R) => string): R[][] {
  const map = new Map<string, R[]>();
  for (const r of rows) {
    const k = key(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return [...map.values()];
}

/** Distancia (km) entre dos puntos, por la fórmula del haversine. */
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// --- Las tools ---------------------------------------------------------------

export function createTrenesTools(ctx: TrenesContext): ConnectorTool[] {
  const nowFn = ctx.now ?? (() => new Date());

  function clock(): Clock {
    const date = nowFn();
    const p = madridParts(date);
    return { ymd: p.ymd, secs: p.secs, epoch: Math.floor(date.getTime() / 1000) };
  }

  /** Abre el índice, ejecuta la tool y añade la atribución (la última línea). */
  async function run(
    fn: (ix: LdIndex, rt: RealtimeUse, c: Clock) => Promise<string[] | string> | string[] | string,
  ): Promise<string> {
    return ctx.withIndex(async (ix) => {
      const rt = new RealtimeUse(ctx.realtime);
      const body = await fn(ix, rt, clock());
      const lines = Array.isArray(body) ? body : [body];
      return [...lines, attributionLd(ix.meta.feedDate, rt.latest)].join('\n');
    });
  }

  /** Hay horario ese día (si no, la tool lo dice en vez de contestar «no hay trenes»). */
  function assertServiceOn(ix: LdIndex, ymd: string, days: ServiceDay[]): void {
    if (days.every((d) => ix.activeServices(d.ymd).length === 0)) {
      throw new ToolUserError(
        `No hay trenes de larga distancia en los horarios para el ${dateEs(ymd)} (los horarios cubren del ${dateEs(ix.meta.firstDate)} al ${dateEs(ix.meta.lastDate)}).`,
      );
    }
  }

  const fechaProp = {
    type: 'string',
    description:
      'Día: "YYYY-MM-DD", "hoy" o "mañana"; por defecto, hoy. El tiempo real (retrasos, cancelaciones) solo existe para hoy.',
  };
  const desdeProp = {
    type: 'string',
    description: 'Hora "HH:MM" de inicio; por defecto, ahora (hoy) o las 00:00 (otro día).',
  };

  // trenes_salidas --------------------------------------------------------------
  const salidas: ConnectorTool = {
    name: 'trenes_salidas',
    description:
      'Próximas salidas de trenes de larga y media distancia (AVE, AVLO, Alvia, Intercity, Euromed, MD, Regional…) desde una estación, ' +
      'con retraso o cancelación si es hoy. `destino` deja solo los trenes que después paran en esa estación; `producto` filtra ("AVE", "Alvia"…); ' +
      '`fecha` y `desde` cambian el día y la hora. Si el nombre es ambiguo ("Madrid") devuelve las estaciones con su id "ld:<id>". ' +
      'Para Cercanías o Rodalies usa cercanias_salidas.',
    inputSchema: {
      type: 'object',
      properties: {
        estacion: {
          type: 'string',
          description: 'Estación de salida: nombre ("Sevilla") o id "ld:<id>".',
        },
        destino: {
          type: 'string',
          description: 'Estación por la que debe pasar después, opcional.',
        },
        producto: { type: 'string', description: 'Producto: "AVE", "Alvia", "MD"…, opcional.' },
        fecha: fechaProp,
        desde: desdeProp,
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
        const st = pickStation(ix, a.estacion, 'estacion', 'trenes_salidas');
        if (!st.ok) return st.text;
        const station = st.value;
        let dest: StopInfo | undefined;
        if (a.destino) {
          const d = pickStation(ix, a.destino, 'destino', 'trenes_salidas');
          if (!d.ok) return d.text;
          dest = d.value;
        }
        const products = a.producto ? resolveProducts(ix, a.producto) : undefined;
        const ymd = parseFecha(a.fecha, c.ymd);
        checkRange(ix, ymd);
        const isToday = ymd === c.ymd;
        const from = parseDesde(a.desde, isToday ? c.secs : 0);
        const days = daysFor(ymd);
        assertServiceOn(ix, ymd, days);

        // Hoy se mira unas horas atrás: un tren con retraso sigue «por salir».
        const rows = ix.departures(
          [station.stopId],
          days,
          isToday ? from - 3 * 3600 : from,
          86399,
          {
            destIds: dest ? [dest.stopId] : undefined,
            products,
          },
        );
        const data = isToday && rows.length > 0 ? await loadRt(rt, signal) : NO_RT_DATA;
        const est = new LdEstimates(ix, data);

        interface Item {
          row: LdDepartureRow;
          e: Estimate | undefined;
          sortKey: number;
        }
        const items: Item[] = [];
        // Un mismo tren, varias variantes: una sola salida.
        for (const group of groupBy(rows, (r) => `${r.number ?? r.tripId}|${r.day.ymd}|${r.dep}`)) {
          const row = pickVariant(group, data);
          const e = data.updates?.has(row.tripId)
            ? est.at(row.tid, row.tripId, row.day, row.seq)
            : undefined;
          const estDep = e?.status === 'ok' ? row.dep + (e.depDelay ?? 0) : row.dep;
          if (estDep < from) continue;
          items.push({ row, e, sortKey: estDep });
        }
        items.sort((x, y) => x.sortKey - y.sortKey);
        const shown = items.slice(0, max);

        const when = isToday ? `hoy (${dateEs(ymd)})` : dateEs(ymd);
        const dayPhrase = isToday ? 'hoy' : `el ${dateEs(ymd)}`;
        const filters =
          `${dest ? ` hacia ${dest.name}` : ''}` +
          `${products ? ` · ${productLabel(products[0]!)}` : ''}`;
        if (shown.length === 0) {
          return [
            `No hay salidas de larga distancia desde ${station.name}${filters} ${dayPhrase} desde las ${hhmm(from)}.`,
            isToday
              ? 'Prueba con fecha: "mañana", con otra hora (desde) o sin filtros.'
              : 'Prueba con otra hora (desde), otro día o sin filtros.',
          ];
        }
        const body = shown.map(({ row, e }) => {
          const to = row.lastStop ? ix.stopName(row.lastStop) : 'destino sin dato';
          const head2 = `${trainName(row)} a ${to}`;
          if (!isToday) return `${head2} · sale ${hhmm(row.dep)}`;
          if (e?.status === 'cancelled') return `${head2} · ${hhmm(row.dep)} · cancelado`;
          if (e?.status !== 'ok' || e.depDelay === null) {
            const mins = minutesUntil(row.dep, c.secs);
            return `${head2} · sale ${hhmm(row.dep)}${mins ? ` (${mins})` : ''} · ${NO_RT}`;
          }
          const estDep = row.dep + e.depDelay;
          const mins = minutesUntil(estDep, c.secs);
          const sched = Math.round(e.depDelay / 60) !== 0 ? ` (horario ${hhmm(row.dep)})` : '';
          return `${head2} · sale ${hhmm(estDep)}${mins ? ` (${mins})` : ''} · ${delayText(e.depDelay, e.kind)}${sched}`;
        });
        if (items.length > max) {
          const last = shown[shown.length - 1]!.sortKey;
          body.push(
            `Hay más salidas: repite con desde: "${hhmm(last + 60)}"${isToday ? '' : `, fecha: "${isoOf(ymd)}"`}.`,
          );
        }
        return [
          `Salidas de larga y media distancia desde ${station.name}${filters} · ${when} desde las ${hhmm(from)}:`,
          ...body,
        ];
      }),
  };

  // trenes_trayecto -------------------------------------------------------------
  const trayecto: ConnectorTool = {
    name: 'trenes_trayecto',
    description:
      'Trenes de larga y media distancia directos de una estación a otra (sin transbordos), con hora de salida y llegada, duración, tren y retraso si es hoy. ' +
      '`fecha` y `desde` cambian el día y la hora. Si no hay directos, dilo y mira con trenes_salidas qué sale del origen. ' +
      'Para Cercanías (con transbordos) usa cercanias_trayecto.',
    inputSchema: {
      type: 'object',
      properties: {
        origen: { type: 'string', description: 'Estación de origen: nombre o id "ld:<id>".' },
        destino: { type: 'string', description: 'Estación de destino: nombre o id "ld:<id>".' },
        fecha: fechaProp,
        desde: desdeProp,
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'Máximo de trenes (por defecto 5).',
        },
      },
      required: ['origen', 'destino'],
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(TrayectoSchema, args);
        const max = a.max ?? 5;
        const o = pickStation(ix, a.origen, 'origen', 'trenes_trayecto');
        if (!o.ok) return o.text;
        const d = pickStation(ix, a.destino, 'destino', 'trenes_trayecto');
        if (!d.ok) return d.text;
        if (o.value.stopId === d.value.stopId) {
          throw new ToolUserError(
            'El origen y el destino son la misma estación: indica dos distintas.',
          );
        }
        const ymd = parseFecha(a.fecha, c.ymd);
        checkRange(ix, ymd);
        const isToday = ymd === c.ymd;
        const from = parseDesde(a.desde, isToday ? c.secs : 0);
        const days = daysFor(ymd);
        assertServiceOn(ix, ymd, days);

        const rows = ix.direct(
          [o.value.stopId],
          [d.value.stopId],
          days,
          isToday ? from - 3 * 3600 : from,
          86399,
        );
        const data = isToday && rows.length > 0 ? await loadRt(rt, signal) : NO_RT_DATA;
        const est = new LdEstimates(ix, data);

        interface Option {
          row: LdDirectRow;
          dep: number;
          arr: number;
          cancelled: boolean;
          eo: Estimate | undefined;
        }
        const options: Option[] = [];
        for (const group of groupBy(
          rows,
          (r) => `${r.number ?? r.tripId}|${r.day.ymd}|${r.odep}`,
        )) {
          const row = pickVariant(group, data);
          const eo = est.at(row.tid, row.tripId, row.day, row.oseq);
          const ed = est.at(row.tid, row.tripId, row.day, row.dseq);
          const dep = row.odep + (eo?.status === 'ok' ? (eo.depDelay ?? 0) : 0);
          const arr = row.darr + (ed?.status === 'ok' ? (ed.arrDelay ?? 0) : 0);
          if (dep < from) continue;
          options.push({
            row,
            dep,
            arr,
            cancelled: eo?.status === 'cancelled' || ed?.status === 'cancelled',
            eo,
          });
        }
        options.sort((x, y) => x.dep - y.dep);
        const live = options.filter((x) => !x.cancelled);
        const cancelled = options.filter((x) => x.cancelled);

        const when = isToday ? `hoy (${dateEs(ymd)})` : dateEs(ymd);
        const dayPhrase = isToday ? 'hoy' : `el ${dateEs(ymd)}`;
        const head = `Trenes directos de ${o.value.name} a ${d.value.name} · ${when} desde las ${hhmm(from)}:`;
        const cancelledNote = (): string[] =>
          cancelled.length === 0
            ? []
            : [
                `Cancelados: ${cancelled
                  .slice(0, 5)
                  .map((x) => `${hhmm(x.row.odep)} ${trainName(x.row)}`)
                  .join('; ')}${cancelled.length > 5 ? '…' : ''}.`,
              ];
        if (live.length === 0) {
          return [
            options.length === 0
              ? `No hay trenes directos de ${o.value.name} a ${d.value.name} ${dayPhrase} desde las ${hhmm(from)}.`
              : `Todos los trenes directos de ${o.value.name} a ${d.value.name} ${dayPhrase} desde las ${hhmm(from)} están cancelados.`,
            ...cancelledNote(),
            'Aquí no hay transbordos: mira con trenes_salidas en el origen a dónde van los trenes, o prueba otra hora (desde) u otro día (fecha).',
          ];
        }
        const body = live.slice(0, max).map(({ row, dep, arr, eo }) => {
          const base = `${hhmm(dep)} → ${arrText(arr)} (${durText((arr - dep) / 60)}) · ${trainName(row)}`;
          if (!isToday) return base;
          return `${base} · ${eo?.status === 'ok' && eo.depDelay !== null ? delayText(eo.depDelay, eo.kind) : NO_RT}`;
        });
        const lines = [head, ...body];
        if (live.length > max) {
          lines.push(
            `Hay más trenes: repite con desde: "${hhmm(live[max - 1]!.dep + 60)}"${isToday ? '' : `, fecha: "${isoOf(ymd)}"`}.`,
          );
        }
        return [...lines, ...cancelledNote()];
      }),
  };

  // trenes_tren -----------------------------------------------------------------
  const tren: ConnectorTool = {
    name: 'trenes_tren',
    description:
      'Estado de un tren de larga o media distancia concreto: producto, origen y destino, si está cancelado, retraso, dónde está y su recorrido completo con horas. ' +
      '`tren` es el número que ve la gente ("3123" o "03123") o el trip_id; `fecha` ("hoy" por defecto) elige el día.',
    inputSchema: {
      type: 'object',
      properties: {
        tren: { type: 'string', description: 'Número del tren ("3123") o trip_id.' },
        fecha: fechaProp,
      },
      required: ['tren'],
      additionalProperties: false,
    },
    handler: (args, signal) =>
      run(async (ix, rt, c) => {
        const a = parseArgs(TrenSchema, args);
        const raw = a.tren.trim();
        const ymd = parseFecha(a.fecha, c.ymd);
        checkRange(ix, ymd);
        const isToday = ymd === c.ymd;

        let trips: LdTrip[] = [];
        const exact = ix.trip(raw);
        if (exact) trips = [exact];
        else {
          const num = /(\d{1,6})/.exec(raw)?.[1]?.replace(/^0+(?=\d)/, '');
          trips = num ? ix.tripsByNumber(num) : [];
        }
        if (trips.length === 0) {
          throw new ToolUserError(
            `No conozco el tren «${raw}». Usa trenes_salidas en una estación para ver los números de los trenes, o pásame el trip_id.`,
          );
        }
        // Viajes que circulan ese día (o, siendo hoy, el anterior si pasan de las 24:00).
        const days = daysFor(ymd);
        const pairs = trips.flatMap((t) =>
          days.filter((d) => ix.activeServices(d.ymd).includes(t.serviceId)).map((d) => ({ t, d })),
        );
        if (pairs.length === 0) {
          throw new ToolUserError(
            `El tren «${raw}» no circula el ${dateEs(ymd)} según los horarios que tengo.`,
          );
        }
        // Un mismo tren (número + día): sus variantes se funden en una.
        const trains = groupBy(pairs, ({ t, d }) => `${d.ymd}|${t.number ?? t.tripId}`);
        const stopsOf = new Map<number, LdStop[]>();
        const stopsFor = (t: LdTrip): LdStop[] => {
          let s = stopsOf.get(t.tid);
          if (!s) stopsOf.set(t.tid, (s = ix.tripStops(t.tid)));
          return s;
        };
        const running = isToday
          ? trains.filter((g) => {
              const { t, d } = g[0]!;
              const stops = stopsFor(t);
              if (stops.length === 0) return false;
              const nowRaw = c.secs + d.offset;
              return (
                nowRaw >= stops[0]!.dep - 3600 && nowRaw <= stops[stops.length - 1]!.arr + 3600
              );
            })
          : [];
        const onDate = trains.filter((g) => g[0]!.d.offset === 0);
        const chosen = running.length > 0 ? running : onDate.length > 0 ? onDate : trains;
        if (chosen.length > 1) {
          return [
            `Hay varios trenes «${raw}» el ${dateEs(ymd)}:`,
            ...chosen.slice(0, 10).map((g, i) => {
              const { t } = g[0]!;
              const stops = stopsFor(t);
              return `${i + 1}. ${trainName(t)} · ${ix.stopName(stops[0]!.stopId)} → ${ix.stopName(stops[stops.length - 1]!.stopId)} · sale ${hhmm(stops[0]!.dep)} · trip_id ${t.tripId}`;
            }),
            'Repite con tren: "<trip_id>".',
          ];
        }

        const data = isToday ? await loadRt(rt, signal) : NO_RT_DATA;
        const group = chosen[0]!;
        const day = group[0]!.d;
        const t = pickVariant(
          group.map((g) => g.t),
          data,
        );
        const est = new LdEstimates(ix, data);
        const { stops, est: ests } = est.get(t.tid, t.tripId, day);
        if (stops.length === 0) {
          throw new ToolUserError(`El tren «${raw}» no tiene paradas en los horarios que tengo.`);
        }
        const upd = data.updates?.get(t.tripId);
        const veh = data.vehicles?.get(t.tripId);
        const nameAt = (i: number): string => ix.stopName(stops[i]!.stopId);
        const first = stops[0]!;
        const last = stops[stops.length - 1]!;
        const nowRaw = c.secs + day.offset;
        const cancelled = upd?.relationship === 'CANCELED';

        const lines = [
          `${trainName(t)} · ${nameAt(0)} → ${nameAt(stops.length - 1)} · sale ${hhmm(first.dep)}, llega ${arrText(last.arr)} · ${dateEs(day.ymd)}`,
        ];

        let vi = -1;
        if (isToday) {
          // Estado
          vi = veh?.stopId ? stops.findIndex((s) => s.stopId === veh.stopId) : -1;
          let estado: string;
          if (cancelled) estado = 'cancelado';
          else if (veh) {
            const near = nearest(ix, stops, veh);
            const kmText = (n: number): string => (n >= 2 ? ` (a unos ${Math.round(n)} km)` : '');
            if (veh.status === 'STOPPED_AT' && vi >= 0) estado = `parado en ${nameAt(vi)}`;
            else if (vi >= 0) {
              // Hacia dónde va y, si es otra parada, junto a cuál está.
              estado =
                near && near.name !== nameAt(vi)
                  ? `en camino a ${nameAt(vi)}, cerca de ${near.name}`
                  : `en camino a ${nameAt(vi)}${near ? kmText(near.km) : ''}`;
            } else if (near) estado = `en marcha, cerca de ${near.name}${kmText(near.km)}`;
            else estado = 'en marcha, sin posición precisa';
          } else if (nowRaw < first.dep) {
            estado = `aún no ha salido (sale de ${nameAt(0)} a las ${hhmm(first.dep)})`;
          } else if (nowRaw > last.arr + FINISH_GRACE) estado = 'ya ha terminado su recorrido';
          else estado = 'en marcha según el horario, sin posición en tiempo real';
          lines.push(`Estado: ${estado}`);

          if (!cancelled) {
            // Retraso de la próxima parada.
            const nextIdx = stops.findIndex((s, i) =>
              vi >= 0 ? i >= vi : s.arr + delayOf(ests[i]) >= nowRaw - 60,
            );
            const ne = nextIdx >= 0 ? ests[nextIdx] : undefined;
            lines.push(
              ne?.status === 'ok' && ne.arrDelay !== null
                ? `Retraso: ${delayText(ne.arrDelay, ne.kind)}`
                : `Retraso: ${NO_RT}`,
            );
          }
        } else {
          lines.push('Tiempo real: solo existe para hoy; las horas son las del horario.');
        }

        // Recorrido con horas (estimadas si hay tiempo real), sin las paradas técnicas.
        const stopIdx = stops.flatMap((s, i) => (s.noPickup && s.noDropOff ? [] : [i]));
        const shownIdx =
          stopIdx.length > MAX_STOPS
            ? [...stopIdx.slice(0, 12), -1, ...stopIdx.slice(-12)]
            : stopIdx;
        lines.push(`Recorrido (${stopIdx.length} paradas):`);
        for (const i of shownIdx) {
          if (i < 0) {
            lines.push(`· … ${stopIdx.length - 24} paradas más …`);
            continue;
          }
          const s = stops[i]!;
          const sched = i === 0 ? s.dep : s.arr;
          const e = ests[i]!;
          const delay = i === 0 ? e.depDelay : e.arrDelay;
          if (isToday && !cancelled && vi >= 0 && i < vi) {
            lines.push(`· ${nameAt(i)} · ${hhmm(sched)} (ya pasó)`);
          } else if (isToday && !cancelled && e.status === 'ok' && delay !== null) {
            const late = Math.round(delay / 60) !== 0;
            lines.push(
              `· ${nameAt(i)} · ${hhmm(sched + delay)} (${delayText(delay, e.kind)}${late ? `; horario ${hhmm(sched)}` : ''})`,
            );
          } else {
            lines.push(`· ${nameAt(i)} · ${hhmm(sched)}`);
          }
        }
        return lines;
      }),
  };

  return [salidas, trayecto, tren];
}

/** Retraso (s) de una estimación, 0 si no la hay (solo para localizar la próxima parada). */
function delayOf(e: Estimate | undefined): number {
  return e?.status === 'ok' ? (e.arrDelay ?? 0) : 0;
}

/** Parada del recorrido más cercana a la posición del vehículo. */
function nearest(
  ix: LdIndex,
  stops: LdStop[],
  veh: VehiclePosition,
): { name: string; km: number } | null {
  if (veh.latitude === undefined || veh.longitude === undefined) return null;
  let best: { name: string; km: number } | null = null;
  for (const s of stops) {
    const info = ix.stop(s.stopId);
    if (!info || info.lat === null || info.lon === null) continue;
    const d = km(veh.latitude, veh.longitude, info.lat, info.lon);
    if (!best || d < best.km) best = { name: info.name, km: d };
  }
  return best;
}

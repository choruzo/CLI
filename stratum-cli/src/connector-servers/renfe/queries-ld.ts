/**
 * Consultas sobre el índice de larga y media distancia (`index-ld.db`):
 * resolución de nombres de estación y lectura de horarios. Sin formato ni
 * tiempo real: eso es de `tools-ld.ts`. Un mismo tren aparece en el GTFS como
 * varios viajes («variantes» por tramo comercial: mismo número, mismas horas,
 * distintas paradas con subida o bajada); aquí se devuelven todas y quien llama
 * las agrupa por número + hora de paso.
 */
import { LD_INDEX_SCHEMA_VERSION } from './index-ld-build.js';
import {
  queryActiveServices,
  searchByNorm,
  type Resolution,
  type ServiceDay,
  type StopInfo,
} from './queries.js';
import type { ScheduledStop } from './realtime.js';
import { loadSqlite, type DatabaseSync } from './sqlite.js';

export interface LdIndexMeta {
  builtAt: string;
  /** Fecha de los datos, `YYYYMMDD`. */
  feedDate: string;
  sourceUrl: string;
  /** Primer y último día que cubren los horarios (`YYYYMMDD`). */
  firstDate: string;
  lastDate: string;
}

export interface LdStop extends ScheduledStop {
  /** No se puede subir / bajar en esta parada. */
  noPickup: boolean;
  noDropOff: boolean;
}

export interface LdTrip {
  tid: number;
  tripId: string;
  product: string;
  /** Número de tren sin ceros a la izquierda (`190`). */
  number: string | null;
  serviceId: string;
  firstStop: string | null;
  lastStop: string | null;
  firstDep: number | null;
  nStops: number;
}

interface TripDb {
  tid: number;
  trip_id: string;
  product: string;
  number: string | null;
  service_id: string;
  first_stop: string | null;
  last_stop: string | null;
  first_dep: number | null;
  n_stops: number;
}

const TRIP_COLS =
  'tid, trip_id, product, number, service_id, first_stop, last_stop, first_dep, n_stops';

function toTrip(r: TripDb): LdTrip {
  return {
    tid: r.tid,
    tripId: r.trip_id,
    product: r.product,
    number: r.number,
    serviceId: r.service_id,
    firstStop: r.first_stop,
    lastStop: r.last_stop,
    firstDep: r.first_dep,
    nStops: r.n_stops,
  };
}

export interface LdDepartureRow {
  tid: number;
  tripId: string;
  product: string;
  number: string | null;
  nStops: number;
  lastStop: string | null;
  stopId: string;
  seq: number;
  /** Segundos del día consultado (ya sin el desplazamiento del día de servicio). */
  arr: number;
  dep: number;
  day: ServiceDay;
}

export interface LdDirectRow {
  tid: number;
  tripId: string;
  product: string;
  number: string | null;
  nStops: number;
  oseq: number;
  ostop: string;
  odep: number;
  dseq: number;
  dstop: string;
  darr: number;
  day: ServiceDay;
}

function qs(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export class LdIndex {
  private stopMap: Map<string, StopInfo> | null = null;
  private served: Set<string> | null = null;
  private serviceCache = new Map<string, string[]>();

  private constructor(
    readonly db: DatabaseSync,
    readonly meta: LdIndexMeta,
  ) {}

  /** Abre el índice en solo lectura; `null` si no existe, no es legible o es de otro esquema. */
  static async open(path: string): Promise<LdIndex | null> {
    const { DatabaseSync } = await loadSqlite();
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
        key: string;
        value: string;
      }>;
      const m = new Map(rows.map((r) => [r.key, r.value]));
      if (m.get('schema_version') !== LD_INDEX_SCHEMA_VERSION) {
        db.close();
        return null;
      }
      return new LdIndex(db, {
        builtAt: m.get('built_at') ?? '',
        feedDate: m.get('feed_date') ?? '',
        sourceUrl: m.get('source_url') ?? '',
        firstDate: m.get('first_date') ?? '',
        lastDate: m.get('last_date') ?? '',
      });
    } catch {
      try {
        db?.close();
      } catch {
        // nada que cerrar
      }
      return null;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ya cerrada
    }
  }

  // --- Estaciones -------------------------------------------------------------

  private stops(): Map<string, StopInfo> {
    if (!this.stopMap) {
      const rows = this.db
        .prepare('SELECT stop_id, name, norm, lat, lon FROM stops')
        .all() as Array<{
        stop_id: string;
        name: string;
        norm: string;
        lat: number | null;
        lon: number | null;
      }>;
      this.stopMap = new Map(
        rows.map((r) => [
          r.stop_id,
          { stopId: r.stop_id, name: r.name, norm: r.norm, lat: r.lat, lon: r.lon },
        ]),
      );
    }
    return this.stopMap;
  }

  stop(stopId: string): StopInfo | undefined {
    return this.stops().get(stopId);
  }

  stopName(stopId: string): string {
    return this.stop(stopId)?.name ?? stopId;
  }

  /** Estaciones con servicio (con alguna hora de paso). */
  servedStops(): StopInfo[] {
    if (!this.served) {
      this.served = new Set(
        (
          this.db.prepare('SELECT DISTINCT stop_id FROM stop_times').all() as Array<{
            stop_id: string;
          }>
        ).map((r) => r.stop_id),
      );
    }
    const stops = this.stops();
    return [...this.served].flatMap((id) => {
      const s = stops.get(id);
      return s ? [s] : [];
    });
  }

  searchStations(text: string): StopInfo[] {
    return searchByNorm(this.servedStops(), text);
  }

  /** Estación por nombre o por id estable (`ld:60000`). */
  resolveStation(text: string): Resolution<StopInfo> {
    const t = text.trim();
    const idm = /^ld:(.+)$/i.exec(t);
    if (idm) {
      const s = this.stop(idm[1]!.trim());
      return s ? { kind: 'one', value: s } : { kind: 'none' };
    }
    const hits = this.searchStations(t);
    if (hits.length === 0) return { kind: 'none' };
    if (hits.length === 1) return { kind: 'one', value: hits[0]! };
    return { kind: 'many', values: hits };
  }

  /** Productos del feed (AVE, ALVIA…) tal como vienen, sin repetir y ordenados. */
  products(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT product FROM trips ORDER BY product').all() as Array<{
        product: string;
      }>
    ).map((r) => r.product);
  }

  // --- Servicio ---------------------------------------------------------------

  /** `service_id` activos un día: `calendar` más las excepciones de `calendar_dates`. */
  activeServices(ymd: string): string[] {
    const cached = this.serviceCache.get(ymd);
    if (cached) return cached;
    const list = queryActiveServices(this.db, ymd);
    this.serviceCache.set(ymd, list);
    return list;
  }

  // --- Viajes -----------------------------------------------------------------

  tripStops(tid: number): LdStop[] {
    return (
      this.db
        .prepare(
          'SELECT seq, stop_id, arr, dep, pickup, drop_off FROM stop_times WHERE tid = ? ORDER BY seq',
        )
        .all(tid) as Array<{
        seq: number;
        stop_id: string;
        arr: number;
        dep: number;
        pickup: number;
        drop_off: number;
      }>
    ).map((r) => ({
      seq: r.seq,
      stopId: r.stop_id,
      arr: r.arr,
      dep: r.dep,
      noPickup: r.pickup === 1,
      noDropOff: r.drop_off === 1,
    }));
  }

  trip(tripId: string): LdTrip | undefined {
    const r = this.db.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE trip_id = ?`).get(tripId) as
      | TripDb
      | undefined;
    return r ? toTrip(r) : undefined;
  }

  /** Viajes (de cualquier día y variante) con ese número de tren sin ceros. */
  tripsByNumber(number: string): LdTrip[] {
    return (
      this.db
        .prepare(`SELECT ${TRIP_COLS} FROM trips WHERE number = ?`)
        .all(number) as unknown as TripDb[]
    ).map(toTrip);
  }

  /**
   * Salidas desde unas estaciones en una ventana (segundos del día consultado) de
   * todos los días de servicio dados. Solo paradas en las que se puede subir y que
   * no son el final del viaje; con `destIds`, solo viajes que después paran en
   * alguno de ellos (y donde se puede bajar); con `products`, solo esos productos.
   */
  departures(
    stopIds: string[],
    days: ServiceDay[],
    lo: number,
    hi: number,
    opts: { destIds?: string[]; products?: string[] } = {},
  ): LdDepartureRow[] {
    const out: LdDepartureRow[] = [];
    const dest = opts.destIds && opts.destIds.length > 0 ? opts.destIds : null;
    const prods = opts.products && opts.products.length > 0 ? opts.products : null;
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0 || stopIds.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.product, t.number, t.n_stops, t.last_stop, st.stop_id, st.seq, st.arr, st.dep
           FROM stop_times st JOIN trips t ON t.tid = st.tid
           WHERE st.stop_id IN (${qs(stopIds.length)}) AND st.dep BETWEEN ? AND ?
             AND t.service_id IN (${qs(services.length)})
             AND st.pickup <> 1
             AND (t.last_stop IS NULL OR t.last_stop <> st.stop_id)
             ${prods ? `AND t.product IN (${qs(prods.length)})` : ''}
             ${
               dest
                 ? `AND EXISTS (SELECT 1 FROM stop_times d WHERE d.tid = st.tid AND d.seq > st.seq AND d.drop_off <> 1 AND d.stop_id IN (${qs(dest.length)}))`
                 : ''
             }
           ORDER BY st.dep`,
        )
        .all(
          ...stopIds,
          lo + day.offset,
          hi + day.offset,
          ...services,
          ...(prods ?? []),
          ...(dest ?? []),
        ) as unknown as Array<{
        tid: number;
        trip_id: string;
        product: string;
        number: string | null;
        n_stops: number;
        last_stop: string | null;
        stop_id: string;
        seq: number;
        arr: number;
        dep: number;
      }>;
      for (const r of rows) {
        out.push({
          tid: r.tid,
          tripId: r.trip_id,
          product: r.product,
          number: r.number,
          nStops: r.n_stops,
          lastStop: r.last_stop,
          stopId: r.stop_id,
          seq: r.seq,
          arr: r.arr - day.offset,
          dep: r.dep - day.offset,
          day,
        });
      }
    }
    return out.sort((a, b) => a.dep - b.dep);
  }

  /** Viajes directos O → D (un mismo viaje pasa por O, donde se sube, y después por D, donde se baja). */
  direct(
    originIds: string[],
    destIds: string[],
    days: ServiceDay[],
    lo: number,
    hi: number,
  ): LdDirectRow[] {
    const out: LdDirectRow[] = [];
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.product, t.number, t.n_stops, o.seq AS oseq, o.stop_id AS ostop, o.dep AS odep,
                  d.seq AS dseq, d.stop_id AS dstop, d.arr AS darr
           FROM stop_times o JOIN trips t ON t.tid = o.tid
           JOIN stop_times d ON d.tid = o.tid AND d.seq > o.seq
           WHERE o.stop_id IN (${qs(originIds.length)}) AND d.stop_id IN (${qs(destIds.length)})
             AND o.pickup <> 1 AND d.drop_off <> 1
             AND o.dep BETWEEN ? AND ? AND t.service_id IN (${qs(services.length)})
           ORDER BY o.dep`,
        )
        .all(
          ...originIds,
          ...destIds,
          lo + day.offset,
          hi + day.offset,
          ...services,
        ) as unknown as Array<{
        tid: number;
        trip_id: string;
        product: string;
        number: string | null;
        n_stops: number;
        oseq: number;
        ostop: string;
        odep: number;
        dseq: number;
        dstop: string;
        darr: number;
      }>;
      for (const r of rows) {
        out.push({
          tid: r.tid,
          tripId: r.trip_id,
          product: r.product,
          number: r.number,
          nStops: r.n_stops,
          oseq: r.oseq,
          ostop: r.ostop,
          odep: r.odep - day.offset,
          dseq: r.dseq,
          dstop: r.dstop,
          darr: r.darr - day.offset,
          day,
        });
      }
    }
    return out.sort((a, b) => a.odep - b.odep);
  }
}

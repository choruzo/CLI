/**
 * Consultas sobre el índice SQLite: resolución de nombres de persona (núcleo,
 * línea, estación) y lectura de horarios. Nada de formato ni de tiempo real:
 * eso es de `tools.ts`.
 */
import { INDEX_SCHEMA_VERSION } from './index-build.js';
import { normalizeName } from './normalize.js';
import { loadSqlite, type DatabaseSync } from './sqlite.js';
import { NUCLEOS } from './nucleos.js';
import { addDays, madridEpochMs, weekdayIndex } from './time.js';
import type { ScheduledStop } from './realtime.js';

export interface IndexMeta {
  builtAt: string;
  /** Fecha de los datos, `YYYYMMDD`. */
  feedDate: string;
  sourceUrl: string;
}

export interface NucleoRow {
  id: string;
  name: string;
  comunidad: string;
  nLines: number;
}

export interface LineRow {
  id: string;
  nucleo: string;
  shortName: string;
  longName: string;
  nStops: number;
}

export interface StopInfo {
  stopId: string;
  name: string;
  norm: string;
  lat: number | null;
  lon: number | null;
}

/** Un día de servicio visto desde «hoy»: sus horas se desplazan `offset` segundos. */
export interface ServiceDay {
  ymd: string;
  /** Segundos que hay que restar a una hora de este día de servicio para pasarla a «hoy». */
  offset: number;
  /** Medianoche de ese día de servicio (segundos epoch). */
  epoch: number;
}

export type Resolution<T> =
  | { kind: 'one'; value: T }
  | { kind: 'many'; values: T[] }
  | { kind: 'none' };

export function serviceDays(todayYmd: string): ServiceDay[] {
  return [
    { ymd: todayYmd, offset: 0, epoch: Math.round(madridEpochMs(todayYmd, 0) / 1000) },
    {
      ymd: addDays(todayYmd, -1),
      offset: 86400,
      epoch: Math.round(madridEpochMs(addDays(todayYmd, -1), 0) / 1000),
    },
    {
      ymd: addDays(todayYmd, 1),
      offset: -86400,
      epoch: Math.round(madridEpochMs(addDays(todayYmd, 1), 0) / 1000),
    },
  ];
}

function qs(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** `service_id` activos un día: `calendar` más las excepciones de `calendar_dates` (las dos tablas existen en ambos índices). */
export function queryActiveServices(db: DatabaseSync, ymd: string): string[] {
  const dayCol = `d${weekdayIndex(ymd)}`;
  const set = new Set(
    (
      db
        .prepare(
          `SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ${dayCol} = 1`,
        )
        .all(ymd, ymd) as Array<{ service_id: string }>
    ).map((r) => r.service_id),
  );
  const ex = db
    .prepare('SELECT service_id, exception_type FROM calendar_dates WHERE date = ?')
    .all(ymd) as Array<{ service_id: string; exception_type: number }>;
  for (const e of ex) {
    if (e.exception_type === 1) set.add(e.service_id);
    else if (e.exception_type === 2) set.delete(e.service_id);
  }
  return [...set];
}

/** Candidatos por nombre en un conjunto de estaciones: exacta → prefijo → contiene → todas las palabras. */
export function searchByNorm(pool: StopInfo[], text: string): StopInfo[] {
  const q = normalizeName(text);
  if (!q) return [];
  const tokens = q.split(' ');
  const levels: Array<(n: string) => boolean> = [
    (n) => n === q,
    (n) => n.startsWith(q),
    (n) => n.includes(q),
    (n) => tokens.every((t) => n.includes(t)),
  ];
  for (const match of levels) {
    const hits = pool.filter((s) => match(s.norm));
    if (hits.length > 0) return hits.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }
  return [];
}

export class RenfeIndex {
  private stopMap: Map<string, StopInfo> | null = null;
  private stopLineMap: Map<string, string[]> | null = null;
  private serviceCache = new Map<string, string[]>();
  private lineMap: Map<string, LineRow> | null = null;

  private constructor(
    readonly db: DatabaseSync,
    readonly meta: IndexMeta,
  ) {}

  /** Abre el índice en solo lectura; `null` si no existe, no es legible o es de otro esquema. */
  static async open(path: string): Promise<RenfeIndex | null> {
    const { DatabaseSync } = await loadSqlite();
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
        key: string;
        value: string;
      }>;
      const m = new Map(rows.map((r) => [r.key, r.value]));
      if (m.get('schema_version') !== INDEX_SCHEMA_VERSION) {
        db.close();
        return null;
      }
      return new RenfeIndex(db, {
        builtAt: m.get('built_at') ?? '',
        feedDate: m.get('feed_date') ?? '',
        sourceUrl: m.get('source_url') ?? '',
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

  // --- Núcleos ----------------------------------------------------------------

  nucleos(): NucleoRow[] {
    return (
      this.db
        .prepare(
          `SELECT n.id, n.name, n.comunidad, (SELECT COUNT(*) FROM lines l WHERE l.nucleo = n.id) AS n_lines
           FROM nucleos n`,
        )
        .all() as Array<{ id: string; name: string; comunidad: string; n_lines: number }>
    )
      .map((r) => ({ id: r.id, name: r.name, comunidad: r.comunidad, nLines: r.n_lines }))
      .sort(
        (a, b) => NUCLEOS.findIndex((n) => n.id === a.id) - NUCLEOS.findIndex((n) => n.id === b.id),
      );
  }

  /** Núcleo por slug, por nombre o por alias («barcelona»); una comunidad con varios núcleos devuelve todos. */
  resolveNucleo(text: string): Resolution<NucleoRow> {
    const all = this.nucleos();
    const q = normalizeName(text);
    if (!q) return { kind: 'none' };
    const bySlug = all.find((n) => n.id === text.trim().toLowerCase());
    if (bySlug) return { kind: 'one', value: bySlug };
    const aliases = (id: string): string[] => NUCLEOS.find((n) => n.id === id)?.aliases ?? [];
    const exact = all.filter(
      (n) => normalizeName(n.name) === q || aliases(n.id).some((a) => normalizeName(a) === q),
    );
    if (exact.length === 1) return { kind: 'one', value: exact[0]! };
    const byComunidad = all.filter((n) => normalizeName(n.comunidad) === q);
    const loose = all.filter(
      (n) =>
        normalizeName(n.name).includes(q) ||
        normalizeName(n.comunidad).includes(q) ||
        aliases(n.id).some((a) => normalizeName(a).includes(q)),
    );
    const pick = exact.length > 0 ? exact : byComunidad.length > 0 ? byComunidad : loose;
    if (pick.length === 0) return { kind: 'none' };
    if (pick.length === 1) return { kind: 'one', value: pick[0]! };
    return { kind: 'many', values: pick };
  }

  // --- Líneas -----------------------------------------------------------------

  private lines(): Map<string, LineRow> {
    if (!this.lineMap) {
      const rows = this.db
        .prepare('SELECT id, nucleo, short_name, long_name, n_stops FROM lines ORDER BY id')
        .all() as Array<{
        id: string;
        nucleo: string;
        short_name: string;
        long_name: string;
        n_stops: number;
      }>;
      this.lineMap = new Map(
        rows.map((r) => [
          r.id,
          {
            id: r.id,
            nucleo: r.nucleo,
            shortName: r.short_name,
            longName: r.long_name,
            nStops: r.n_stops,
          },
        ]),
      );
    }
    return this.lineMap;
  }

  line(id: string): LineRow | undefined {
    return this.lines().get(id);
  }

  linesOf(nucleo: string): LineRow[] {
    const order = (s: string): [number, string] => {
      const m = /^([A-Za-z]+)(\d+)(.*)$/.exec(s);
      return m ? [Number(m[2]), `${m[1]}${m[3]}`] : [0, s];
    };
    return [...this.lines().values()]
      .filter((l) => l.nucleo === nucleo)
      .sort((a, b) => {
        const [na, sa] = order(a.shortName);
        const [nb, sb] = order(b.shortName);
        return sa.localeCompare(sb) || na - nb || a.shortName.localeCompare(b.shortName);
      });
  }

  /** Línea por id (`madrid/C1`) o por nombre corto (`C1`) acotado a unos núcleos. */
  resolveLine(text: string, nucleos?: string[]): Resolution<LineRow> {
    const t = text.trim();
    const byId = [...this.lines().values()].find((l) => l.id.toLowerCase() === t.toLowerCase());
    if (byId) return { kind: 'one', value: byId };
    const key = t.replace(/^.*\//, '').toLowerCase();
    let found = [...this.lines().values()].filter((l) => l.shortName.toLowerCase() === key);
    if (nucleos && nucleos.length > 0) found = found.filter((l) => nucleos.includes(l.nucleo));
    if (found.length === 0) return { kind: 'none' };
    if (found.length === 1) return { kind: 'one', value: found[0]! };
    return { kind: 'many', values: found };
  }

  /** Estaciones de una línea, en orden de su recorrido más largo. */
  lineStops(lineId: string): StopInfo[] {
    const stops = this.stops();
    return (
      this.db
        .prepare('SELECT stop_id FROM line_stops WHERE line_id = ? ORDER BY pos')
        .all(lineId) as Array<{ stop_id: string }>
    ).flatMap((r) => {
      const s = stops.get(r.stop_id);
      return s ? [s] : [];
    });
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

  /** Líneas (ids) que paran en una estación. */
  linesAt(stopId: string): string[] {
    if (!this.stopLineMap) {
      const map = new Map<string, string[]>();
      const rows = this.db
        .prepare('SELECT stop_id, line_id FROM stop_lines ORDER BY line_id')
        .all() as Array<{
        stop_id: string;
        line_id: string;
      }>;
      for (const r of rows) {
        const list = map.get(r.stop_id);
        if (list) list.push(r.line_id);
        else map.set(r.stop_id, [r.line_id]);
      }
      this.stopLineMap = map;
    }
    return this.stopLineMap.get(stopId) ?? [];
  }

  /** Núcleos en los que para una estación (casi siempre uno). */
  nucleosAt(stopId: string): string[] {
    return [...new Set(this.linesAt(stopId).map((l) => this.line(l)?.nucleo ?? ''))].filter(
      Boolean,
    );
  }

  /** Estaciones con servicio, opcionalmente de un núcleo. */
  servedStops(nucleo?: string): StopInfo[] {
    const stops = this.stops();
    this.linesAt('');
    const out: StopInfo[] = [];
    for (const [stopId, lines] of this.stopLineMap!) {
      if (nucleo && !lines.some((l) => this.line(l)?.nucleo === nucleo)) continue;
      const s = stops.get(stopId);
      if (s) out.push(s);
    }
    return out;
  }

  /** Candidatos por nombre: coincidencia exacta → prefijo → contiene → todas las palabras. */
  searchStations(text: string, nucleo?: string): StopInfo[] {
    return searchByNorm(this.servedStops(nucleo), text);
  }

  /** Estación por nombre o por id estable (`est:18000`). */
  resolveStation(text: string, nucleo?: string): Resolution<StopInfo> {
    const t = text.trim();
    const idm = /^est:(.+)$/i.exec(t);
    if (idm) {
      const s = this.stop(idm[1]!.trim());
      return s ? { kind: 'one', value: s } : { kind: 'none' };
    }
    const hits = this.searchStations(t, nucleo);
    if (hits.length === 0) return { kind: 'none' };
    if (hits.length === 1) return { kind: 'one', value: hits[0]! };
    return { kind: 'many', values: hits };
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

  tripStops(tid: number): ScheduledStop[] {
    return (
      this.db
        .prepare('SELECT seq, stop_id, arr, dep FROM stop_times WHERE tid = ? ORDER BY seq')
        .all(tid) as Array<{ seq: number; stop_id: string; arr: number; dep: number }>
    ).map((r) => ({ seq: r.seq, stopId: r.stop_id, arr: r.arr, dep: r.dep }));
  }

  trip(tripId: string): TripRow | undefined {
    const r = this.db
      .prepare(
        'SELECT tid, trip_id, line_id, service_id, short_name, first_stop, last_stop FROM trips WHERE trip_id = ?',
      )
      .get(tripId) as TripDb | undefined;
    return r ? toTrip(r) : undefined;
  }

  tripsByNumber(number: string): TripRow[] {
    return (
      this.db
        .prepare(
          'SELECT tid, trip_id, line_id, service_id, short_name, first_stop, last_stop FROM trips WHERE short_name = ?',
        )
        .all(number) as unknown as TripDb[]
    ).map(toTrip);
  }

  tripByTid(tid: number): TripRow | undefined {
    const r = this.db
      .prepare(
        'SELECT tid, trip_id, line_id, service_id, short_name, first_stop, last_stop FROM trips WHERE tid = ?',
      )
      .get(tid) as TripDb | undefined;
    return r ? toTrip(r) : undefined;
  }

  /** Líneas a las que pertenece un `route_id` (para los avisos). */
  lineOfRoute(routeId: string): string | undefined {
    const r = this.db
      .prepare('SELECT line_id FROM line_routes WHERE route_id = ? LIMIT 1')
      .get(routeId.trim()) as { line_id: string } | undefined;
    return r?.line_id;
  }

  /** Salidas desde unas estaciones en una ventana (segundos de «hoy»), de todos los días de servicio dados. */
  departures(stopIds: string[], days: ServiceDay[], lo: number, hi: number): DepartureRow[] {
    const out: DepartureRow[] = [];
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0 || stopIds.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.line_id, t.last_stop, st.stop_id, st.seq, st.arr, st.dep
           FROM stop_times st JOIN trips t ON t.tid = st.tid
           WHERE st.stop_id IN (${qs(stopIds.length)}) AND st.dep BETWEEN ? AND ?
             AND t.service_id IN (${qs(services.length)})
             AND (t.last_stop IS NULL OR t.last_stop <> st.stop_id)
           ORDER BY st.dep`,
        )
        .all(...stopIds, lo + day.offset, hi + day.offset, ...services) as unknown as Array<{
        tid: number;
        trip_id: string;
        line_id: string;
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
          lineId: r.line_id,
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

  /** ¿Para el viaje `tid` en alguna de estas estaciones después de `seq`? Devuelve esa parada. */
  laterStop(
    tid: number,
    seq: number,
    stopIds: string[],
  ): { seq: number; stopId: string; arr: number } | null {
    if (stopIds.length === 0) return null;
    const r = this.db
      .prepare(
        `SELECT seq, stop_id, arr FROM stop_times WHERE tid = ? AND seq > ? AND stop_id IN (${qs(stopIds.length)}) ORDER BY seq LIMIT 1`,
      )
      .get(tid, seq, ...stopIds) as { seq: number; stop_id: string; arr: number } | undefined;
    return r ? { seq: r.seq, stopId: r.stop_id, arr: r.arr } : null;
  }

  /** Viajes directos O → D (un mismo viaje pasa por O y después por D). */
  direct(
    originIds: string[],
    destIds: string[],
    days: ServiceDay[],
    lo: number,
    hi: number,
  ): DirectRow[] {
    const out: DirectRow[] = [];
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.line_id, o.seq AS oseq, o.stop_id AS ostop, o.dep AS odep,
                  d.seq AS dseq, d.stop_id AS dstop, d.arr AS darr
           FROM stop_times o JOIN trips t ON t.tid = o.tid
           JOIN stop_times d ON d.tid = o.tid AND d.seq > o.seq
           WHERE o.stop_id IN (${qs(originIds.length)}) AND d.stop_id IN (${qs(destIds.length)})
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
        line_id: string;
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
          lineId: r.line_id,
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

  /** Primer tramo de un transbordo: viajes desde O y cada parada posterior. */
  legsFrom(originIds: string[], days: ServiceDay[], lo: number, hi: number): LegFromRow[] {
    const out: LegFromRow[] = [];
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.line_id, o.seq AS oseq, o.stop_id AS ostop, o.dep AS odep,
                  x.seq AS xseq, x.stop_id AS xstop, x.arr AS xarr
           FROM stop_times o JOIN trips t ON t.tid = o.tid
           JOIN stop_times x ON x.tid = o.tid AND x.seq > o.seq
           WHERE o.stop_id IN (${qs(originIds.length)}) AND o.dep BETWEEN ? AND ?
             AND t.service_id IN (${qs(services.length)})`,
        )
        .all(...originIds, lo + day.offset, hi + day.offset, ...services) as unknown as Array<{
        tid: number;
        trip_id: string;
        line_id: string;
        oseq: number;
        ostop: string;
        odep: number;
        xseq: number;
        xstop: string;
        xarr: number;
      }>;
      for (const r of rows) {
        out.push({
          tid: r.tid,
          tripId: r.trip_id,
          lineId: r.line_id,
          oseq: r.oseq,
          ostop: r.ostop,
          odep: r.odep - day.offset,
          xseq: r.xseq,
          xstop: r.xstop,
          xarr: r.xarr - day.offset,
          day,
        });
      }
    }
    return out;
  }

  /** Segundo tramo: viajes que llegan a D y cada parada anterior de la que se puede salir. */
  legsTo(destIds: string[], days: ServiceDay[], lo: number, hi: number): LegToRow[] {
    const out: LegToRow[] = [];
    for (const day of days) {
      const services = this.activeServices(day.ymd);
      if (services.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT t.tid, t.trip_id, t.line_id, x.seq AS xseq, x.stop_id AS xstop, x.dep AS xdep,
                  d.seq AS dseq, d.stop_id AS dstop, d.arr AS darr
           FROM stop_times d JOIN trips t ON t.tid = d.tid
           JOIN stop_times x ON x.tid = d.tid AND x.seq < d.seq
           WHERE d.stop_id IN (${qs(destIds.length)}) AND d.arr BETWEEN ? AND ?
             AND t.service_id IN (${qs(services.length)})`,
        )
        .all(...destIds, lo + day.offset, hi + day.offset, ...services) as unknown as Array<{
        tid: number;
        trip_id: string;
        line_id: string;
        xseq: number;
        xstop: string;
        xdep: number;
        dseq: number;
        dstop: string;
        darr: number;
      }>;
      for (const r of rows) {
        out.push({
          tid: r.tid,
          tripId: r.trip_id,
          lineId: r.line_id,
          xseq: r.xseq,
          xstop: r.xstop,
          xdep: r.xdep - day.offset,
          dseq: r.dseq,
          dstop: r.dstop,
          darr: r.darr - day.offset,
          day,
        });
      }
    }
    return out;
  }

  /** Transbordos a pie de `transfers.txt`: estación → [(destino, segundos mínimos)]. */
  transfers(): Map<string, Array<{ to: string; min: number | null }>> {
    const map = new Map<string, Array<{ to: string; min: number | null }>>();
    const rows = this.db
      .prepare(
        'SELECT from_stop, to_stop, MIN(min_time) AS min_time FROM transfers GROUP BY from_stop, to_stop',
      )
      .all() as Array<{ from_stop: string; to_stop: string; min_time: number | null }>;
    for (const r of rows) {
      const list = map.get(r.from_stop);
      const e = { to: r.to_stop, min: r.min_time };
      if (list) list.push(e);
      else map.set(r.from_stop, [e]);
    }
    return map;
  }
}

export interface TripRow {
  tid: number;
  tripId: string;
  lineId: string;
  serviceId: string;
  shortName: string | null;
  firstStop: string | null;
  lastStop: string | null;
}

interface TripDb {
  tid: number;
  trip_id: string;
  line_id: string;
  service_id: string;
  short_name: string | null;
  first_stop: string | null;
  last_stop: string | null;
}

function toTrip(r: TripDb): TripRow {
  return {
    tid: r.tid,
    tripId: r.trip_id,
    lineId: r.line_id,
    serviceId: r.service_id,
    shortName: r.short_name,
    firstStop: r.first_stop,
    lastStop: r.last_stop,
  };
}

export interface DepartureRow {
  tid: number;
  tripId: string;
  lineId: string;
  lastStop: string | null;
  stopId: string;
  seq: number;
  /** Segundos de «hoy» (ya sin el desplazamiento del día de servicio). */
  arr: number;
  dep: number;
  day: ServiceDay;
}

export interface DirectRow {
  tid: number;
  tripId: string;
  lineId: string;
  oseq: number;
  ostop: string;
  odep: number;
  dseq: number;
  dstop: string;
  darr: number;
  day: ServiceDay;
}

export interface LegFromRow {
  tid: number;
  tripId: string;
  lineId: string;
  oseq: number;
  ostop: string;
  odep: number;
  xseq: number;
  xstop: string;
  xarr: number;
  day: ServiceDay;
}

export interface LegToRow {
  tid: number;
  tripId: string;
  lineId: string;
  xseq: number;
  xstop: string;
  xdep: number;
  dseq: number;
  dstop: string;
  darr: number;
  day: ServiceDay;
}

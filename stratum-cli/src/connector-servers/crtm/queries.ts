/**
 * Consultas sobre el índice de un modo (`index-<modo>.db`): estaciones, líneas,
 * servicio de un día y pasadas por una estación. Sin formato ni reloj: eso es de
 * `schedule.ts` y `tools.ts`. Las horas salen en segundos del día de servicio;
 * `ServiceDay.offset` las pasa a «hoy» (ver `serviceDays`).
 */
import { normalizeName } from '../renfe/normalize.js';
import { loadSqlite, type DatabaseSync } from '../renfe/sqlite.js';
import { addDays, weekdayIndex } from '../renfe/time.js';
import { INDEX_SCHEMA_VERSION } from './index-build.js';
import type { ModeId } from './feeds.js';

export interface IndexMeta {
  mode: ModeId;
  builtAt: string;
  /** `modified` de ArcGIS (ms epoch como texto). */
  feedModified: string;
  /** Primer y último día que cubren los horarios (`YYYYMMDD`). */
  firstDate: string;
  lastDate: string;
}

export interface StationInfo {
  mode: ModeId;
  id: string;
  name: string;
  norm: string;
  lat: number | null;
  lon: number | null;
}

export interface RouteInfo {
  id: string;
  shortName: string;
  longName: string;
}

/** Un día de servicio visto desde «hoy»: sus horas se desplazan `offset` segundos. */
export interface ServiceDay {
  ymd: string;
  /** Segundos que hay que restar a una hora de este día de servicio para pasarla a «hoy». */
  offset: number;
}

export function serviceDays(todayYmd: string): ServiceDay[] {
  return [
    { ymd: todayYmd, offset: 0 },
    { ymd: addDays(todayYmd, -1), offset: 86400 },
    { ymd: addDays(todayYmd, 1), offset: -86400 },
  ];
}

/** Salida de hora exacta: `dep` ya en segundos de «hoy» (puede ser negativa o pasar de 86400). */
export interface ExactPass {
  routeId: string;
  direction: number;
  headsign: string;
  dep: number;
  /** Llegada al destino pedido, si se pidió. */
  arr: number | null;
}

/** Ventana de frecuencia en una estación: ya desplazada por el desfase de la parada. */
export interface FreqWindow {
  routeId: string;
  direction: number;
  headsign: string;
  /** Segundos del día de servicio en que empieza y acaba (en esta parada). */
  start: number;
  end: number;
  headway: number;
  /** Duración del viaje hasta el destino pedido, si se pidió. */
  ride: number | null;
}

export interface LineStop {
  stationId: string;
  name: string;
}

export interface LineDirection {
  direction: number;
  headsign: string;
  stops: LineStop[];
}

/** Nivel de coincidencia de un nombre: 0 exacta, 1 prefijo, 2 contiene, 3 todas las palabras; -1 no. */
export function matchLevel(norm: string, q: string, tokens: string[]): number {
  if (norm === q) return 0;
  if (norm.startsWith(q)) return 1;
  if (norm.includes(q)) return 2;
  if (tokens.every((t) => norm.includes(t))) return 3;
  return -1;
}

export interface Hit {
  station: StationInfo;
  level: number;
}

/**
 * Orden en el que se enseñan las coincidencias de un mismo nombre: primero los
 * raíles y la EMT (Madrid capital) y después las redes de autobús comarcales.
 */
const MODE_ORDER: Record<ModeId, number> = { metro: 0, ml: 1, emt: 2, urbano: 3, interurbano: 4 };

/** Estaciones que casan con el texto, de mejor a peor coincidencia (luego modo y nombre). */
export function searchStations(pool: StationInfo[], text: string): Hit[] {
  const q = normalizeName(text);
  if (!q) return [];
  const tokens = q.split(' ');
  const hits: Hit[] = [];
  for (const station of pool) {
    const level = matchLevel(station.norm, q, tokens);
    if (level >= 0) hits.push({ station, level });
  }
  return hits.sort(
    (a, b) =>
      a.level - b.level ||
      MODE_ORDER[a.station.mode] - MODE_ORDER[b.station.mode] ||
      a.station.name.localeCompare(b.station.name, 'es') ||
      a.station.id.localeCompare(b.station.id),
  );
}

function qs(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export class ModeIndex {
  private stationMap: Map<string, StationInfo> | null = null;
  private routeList: RouteInfo[] | null = null;
  private serviceCache = new Map<string, string[]>();

  private constructor(
    readonly db: DatabaseSync,
    readonly meta: IndexMeta,
  ) {}

  /** Abre el índice en solo lectura; `null` si no existe, no es legible o es de otro esquema. */
  static async open(path: string): Promise<ModeIndex | null> {
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
      return new ModeIndex(db, {
        mode: (m.get('mode') ?? 'metro') as ModeId,
        builtAt: m.get('built_at') ?? '',
        feedModified: m.get('feed_modified') ?? '',
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

  get mode(): ModeId {
    return this.meta.mode;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ya cerrada
    }
  }

  // --- Estaciones -------------------------------------------------------------

  private stationsById(): Map<string, StationInfo> {
    if (!this.stationMap) {
      const rows = this.db
        .prepare('SELECT station_id, name, norm, lat, lon FROM stations')
        .all() as Array<{
        station_id: string;
        name: string;
        norm: string;
        lat: number | null;
        lon: number | null;
      }>;
      this.stationMap = new Map(
        rows.map((r) => [
          r.station_id,
          {
            mode: this.meta.mode,
            id: r.station_id,
            name: r.name,
            norm: r.norm,
            lat: r.lat,
            lon: r.lon,
          },
        ]),
      );
    }
    return this.stationMap;
  }

  stations(): StationInfo[] {
    return [...this.stationsById().values()];
  }

  station(id: string): StationInfo | undefined {
    return this.stationsById().get(id);
  }

  /** Líneas que paran en una estación, por nombre corto. */
  routesAt(stationId: string): RouteInfo[] {
    const ids = new Set(
      (
        this.db
          .prepare('SELECT route_id FROM station_routes WHERE station_id = ?')
          .all(stationId) as Array<{ route_id: string }>
      ).map((r) => r.route_id),
    );
    return this.routes().filter((r) => ids.has(r.id));
  }

  // --- Líneas -----------------------------------------------------------------

  /** Todas las líneas con servicio, ordenadas por nombre corto (números primero, en orden numérico). */
  routes(): RouteInfo[] {
    if (!this.routeList) {
      const rows = this.db
        .prepare(
          `SELECT r.route_id, r.short_name, r.long_name FROM routes r
           WHERE EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.route_id)`,
        )
        .all() as Array<{ route_id: string; short_name: string; long_name: string }>;
      this.routeList = rows
        .map((r) => ({ id: r.route_id, shortName: r.short_name, longName: r.long_name }))
        .sort((a, b) =>
          a.shortName.localeCompare(b.shortName, 'es', { numeric: true, sensitivity: 'base' }),
        );
    }
    return this.routeList;
  }

  /**
   * Líneas por nombre corto (`1`, `L1` en Metro, `ML1`, `27`, `N401`) o por su
   * id de GTFS (`9__1__040_`, que es lo que llevan los ids `modo:línea` de las
   * tools): en los autobuses un número se repite entre municipios y redes, así
   * que el id es la única forma de pedir una línea concreta.
   */
  findRoutes(text: string): RouteInfo[] {
    const t = text.trim().toUpperCase();
    const bare = this.mode === 'metro' ? /^L(\d+|R)$/.exec(t)?.[1] : undefined;
    return this.routes().filter((r) => {
      const s = r.shortName.toUpperCase();
      return s === t || r.id.toUpperCase() === t || (bare !== undefined && s === bare);
    });
  }

  /**
   * Paradas en orden de cada sentido, con el patrón **que más viajes hace** de
   * cada sentido (el representativo), no el más largo: los feeds de autobús
   * traen viajes «9999» que concatenan el día entero de una línea en un solo
   * viaje de más de mil paradas, y ese no es el recorrido que se quiere enseñar.
   */
  lineDirections(routeId: string): LineDirection[] {
    const rows = this.db
      .prepare(
        `SELECT t.direction, t.pid, COUNT(*) AS n FROM trips t
         WHERE t.route_id = ? GROUP BY t.direction, t.pid ORDER BY n DESC, t.pid`,
      )
      .all(routeId) as Array<{ direction: number; pid: number }>;
    const best = new Map<number, number>();
    for (const r of rows) if (!best.has(r.direction)) best.set(r.direction, r.pid);
    const headsignOf = this.db.prepare(
      `SELECT headsign FROM trips WHERE pid = ? GROUP BY headsign ORDER BY COUNT(*) DESC, headsign LIMIT 1`,
    );
    const out: LineDirection[] = [];
    for (const [direction, pid] of [...best].sort((x, y) => x[0] - y[0])) {
      const head = headsignOf.get(pid) as { headsign: string } | undefined;
      const stops = (
        this.db
          .prepare(
            `SELECT s.station_id, st.name FROM pattern_stops ps
             JOIN stops s ON s.stop_id = ps.stop_id JOIN stations st ON st.station_id = s.station_id
             WHERE ps.pid = ? ORDER BY ps.seq`,
          )
          .all(pid) as Array<{ station_id: string; name: string }>
      ).map((r) => ({ stationId: r.station_id, name: r.name }));
      out.push({ direction, headsign: head?.headsign ?? '', stops });
    }
    return out;
  }

  // --- Servicio ---------------------------------------------------------------

  /** ¿Cubre el horario este día? (`calendar` lo incluye en su rango o `calendar_dates` lo añade) */
  covers(ymd: string): boolean {
    const a = this.db
      .prepare('SELECT 1 AS x FROM calendar WHERE start_date <= ? AND end_date >= ? LIMIT 1')
      .get(ymd, ymd);
    if (a) return true;
    return !!this.db
      .prepare('SELECT 1 AS x FROM calendar_dates WHERE date = ? AND exception_type = 1 LIMIT 1')
      .get(ymd);
  }

  /** `service_id` activos un día: `calendar` más las excepciones de `calendar_dates`. */
  activeServices(ymd: string): string[] {
    const cached = this.serviceCache.get(ymd);
    if (cached) return cached;
    const dayCol = `d${weekdayIndex(ymd)}`;
    const set = new Set(
      (
        this.db
          .prepare(
            `SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ${dayCol} = 1`,
          )
          .all(ymd, ymd) as Array<{ service_id: string }>
      ).map((r) => r.service_id),
    );
    const ex = this.db
      .prepare('SELECT service_id, exception_type FROM calendar_dates WHERE date = ?')
      .all(ymd) as Array<{ service_id: string; exception_type: number }>;
    for (const e of ex) {
      if (e.exception_type === 1) set.add(e.service_id);
      else if (e.exception_type === 2) set.delete(e.service_id);
    }
    const list = [...set];
    this.serviceCache.set(ymd, list);
    return list;
  }

  // --- Pasadas ----------------------------------------------------------------

  /**
   * Salidas de hora exacta desde unas estaciones, de un día de servicio, a partir
   * de `from` (segundos de «hoy») y dentro de las 24 h siguientes. Solo paradas
   * que no son el final del viaje; con `destIds`, solo viajes que después paran
   * en alguna de esas estaciones (y devuelve la llegada).
   */
  exactPasses(
    stationIds: string[],
    day: ServiceDay,
    from: number,
    opts: { destIds?: string[]; routeIds?: string[]; limit?: number } = {},
  ): ExactPass[] {
    const services = this.activeServices(day.ymd);
    if (services.length === 0 || stationIds.length === 0) return [];
    const dest = opts.destIds && opts.destIds.length > 0 ? opts.destIds : null;
    const routes = opts.routeIds && opts.routeIds.length > 0 ? opts.routeIds : null;
    const lo = from + day.offset;
    const rows = this.db
      .prepare(
        `SELECT t.route_id, t.direction, t.headsign, t.first_dep + ps.dep AS dep
                ${dest ? ', MIN(t.first_dep + pd.arr) AS arr' : ''}
         FROM pattern_stops ps
         JOIN stops s ON s.stop_id = ps.stop_id
         JOIN patterns p ON p.pid = ps.pid
         JOIN trips t ON t.pid = ps.pid
         ${
           dest
             ? `JOIN pattern_stops pd ON pd.pid = ps.pid AND pd.seq > ps.seq
                JOIN stops ds ON ds.stop_id = pd.stop_id AND ds.station_id IN (${qs(dest.length)})`
             : ''
         }
         WHERE s.station_id IN (${qs(stationIds.length)}) AND t.freq = 0
           AND t.service_id IN (${qs(services.length)})
           AND ps.seq < p.n_stops - 1
           AND t.first_dep + ps.dep BETWEEN ? AND ?
           ${routes ? `AND t.route_id IN (${qs(routes.length)})` : ''}
         ${dest ? 'GROUP BY t.tid, ps.seq' : ''}
         ORDER BY dep LIMIT ?`,
      )
      .all(
        ...(dest ?? []),
        ...stationIds,
        ...services,
        lo,
        lo + 86400,
        ...(routes ?? []),
        opts.limit ?? 200,
      ) as unknown as Array<{
      route_id: string;
      direction: number;
      headsign: string;
      dep: number;
      arr?: number;
    }>;
    return rows.map((r) => ({
      routeId: r.route_id,
      direction: r.direction,
      headsign: r.headsign,
      dep: r.dep - day.offset,
      arr: r.arr === undefined ? null : r.arr - day.offset,
    }));
  }

  /**
   * Ventanas de frecuencia de los viajes por frecuencia que paran en unas
   * estaciones, de un día de servicio, desplazadas por el desfase de la parada
   * (en segundos del día de servicio; el desplazamiento a «hoy» lo hace quien llama).
   */
  freqWindows(
    stationIds: string[],
    ymd: string,
    opts: { destIds?: string[]; routeIds?: string[] } = {},
  ): FreqWindow[] {
    const services = this.activeServices(ymd);
    if (services.length === 0 || stationIds.length === 0) return [];
    const dest = opts.destIds && opts.destIds.length > 0 ? opts.destIds : null;
    const routes = opts.routeIds && opts.routeIds.length > 0 ? opts.routeIds : null;
    const rows = this.db
      .prepare(
        `SELECT t.route_id, t.direction, t.headsign, ps.dep AS off, w.start_t, w.end_t, w.headway
                ${dest ? ', MIN(pd.arr) - ps.dep AS ride' : ''}
         FROM windows w
         JOIN trips t ON t.tid = w.tid
         JOIN patterns p ON p.pid = t.pid
         JOIN pattern_stops ps ON ps.pid = t.pid
         JOIN stops s ON s.stop_id = ps.stop_id
         ${
           dest
             ? `JOIN pattern_stops pd ON pd.pid = ps.pid AND pd.seq > ps.seq
                JOIN stops ds ON ds.stop_id = pd.stop_id AND ds.station_id IN (${qs(dest.length)})`
             : ''
         }
         WHERE s.station_id IN (${qs(stationIds.length)})
           AND t.service_id IN (${qs(services.length)})
           AND ps.seq < p.n_stops - 1
           ${routes ? `AND t.route_id IN (${qs(routes.length)})` : ''}
         GROUP BY t.route_id, t.direction, t.headsign, ps.dep, w.start_t, w.end_t, w.headway`,
      )
      .all(...(dest ?? []), ...stationIds, ...services, ...(routes ?? [])) as unknown as Array<{
      route_id: string;
      direction: number;
      headsign: string;
      off: number;
      start_t: number;
      end_t: number;
      headway: number;
      ride?: number;
    }>;
    return rows.map((r) => ({
      routeId: r.route_id,
      direction: r.direction,
      headsign: r.headsign,
      start: r.start_t + r.off,
      end: r.end_t + r.off,
      headway: r.headway,
      ride: r.ride === undefined ? null : r.ride,
    }));
  }
}

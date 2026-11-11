/**
 * Construye el índice SQLite (`node:sqlite`) a partir del zip GTFS estático de
 * Renfe. Todo se lee en streaming (el zip real descomprime a ~277 MB y 1,79 M
 * filas de `stop_times`), se inserta en una transacción con sentencias
 * preparadas y el resultado se escribe en un temporal que, al terminar, se
 * renombra sobre `index.db`: un fallo borra el temporal y deja el índice
 * anterior intacto.
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { csvRows } from './csv.js';
import { NUCLEOS, nucleoOfRoute } from './nucleos.js';
import { normalizeName, tidyLabel } from './normalize.js';
import { loadSqlite } from './sqlite.js';
import { parseClock } from './time.js';
import { ZipArchive } from './zip.js';

/** Sube si cambia el esquema: un índice de otra versión se ignora y se reconstruye. */
export const INDEX_SCHEMA_VERSION = '1';

export const INDEX_FILE = 'index.db';

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE nucleos (id TEXT PRIMARY KEY, prefix TEXT NOT NULL, name TEXT NOT NULL, comunidad TEXT NOT NULL);
CREATE TABLE lines (id TEXT PRIMARY KEY, nucleo TEXT NOT NULL, short_name TEXT NOT NULL, long_name TEXT NOT NULL, color TEXT, n_stops INTEGER NOT NULL DEFAULT 0);
CREATE TABLE line_routes (line_id TEXT NOT NULL, route_id TEXT NOT NULL);
CREATE TABLE stops (stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, norm TEXT NOT NULL, lat REAL, lon REAL);
CREATE TABLE line_stops (line_id TEXT NOT NULL, pos INTEGER NOT NULL, stop_id TEXT NOT NULL, PRIMARY KEY (line_id, pos));
CREATE TABLE stop_lines (stop_id TEXT NOT NULL, line_id TEXT NOT NULL, PRIMARY KEY (stop_id, line_id));
CREATE TABLE trips (tid INTEGER PRIMARY KEY, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, line_id TEXT NOT NULL, service_id TEXT NOT NULL, headsign TEXT, short_name TEXT, first_stop TEXT, last_stop TEXT, first_dep INTEGER, n_stops INTEGER NOT NULL DEFAULT 0);
CREATE TABLE stop_times (tid INTEGER NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, arr INTEGER NOT NULL, dep INTEGER NOT NULL);
CREATE TABLE calendar (service_id TEXT PRIMARY KEY, d0 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER, d4 INTEGER, d5 INTEGER, d6 INTEGER, start_date TEXT NOT NULL, end_date TEXT NOT NULL);
CREATE TABLE calendar_dates (service_id TEXT NOT NULL, date TEXT NOT NULL, exception_type INTEGER NOT NULL);
CREATE TABLE transfers (from_stop TEXT NOT NULL, to_stop TEXT NOT NULL, min_time INTEGER);
`;

const INDEXES = `
CREATE INDEX idx_st_stop ON stop_times (stop_id, dep);
CREATE INDEX idx_st_trip ON stop_times (tid, seq);
CREATE UNIQUE INDEX idx_trips_id ON trips (trip_id);
CREATE INDEX idx_trips_short ON trips (short_name);
CREATE INDEX idx_trips_line ON trips (line_id);
CREATE INDEX idx_stops_norm ON stops (norm);
CREATE INDEX idx_lr_route ON line_routes (route_id);
CREATE INDEX idx_sl_line ON stop_lines (line_id);
CREATE INDEX idx_tr_from ON transfers (from_stop);
CREATE INDEX idx_cal_dates ON calendar_dates (date);
`;

export interface BuildOptions {
  zipPath: string;
  /** Directorio de la caché: allí quedan `index.db` y el temporal. */
  dir: string;
  sourceUrl: string;
  /** Fecha de los datos (`YYYYMMDD`); por defecto, la del fichero más reciente del zip. */
  feedDate?: string;
  now?: () => Date;
  warn?: (msg: string) => void;
}

export interface BuildResult {
  path: string;
  stopTimes: number;
  trips: number;
  ms: number;
}

/** Número corto del tren que ve la gente: `3014X35833C5` (servicio `3014X`) → `35833`. */
export function tripShortNumber(tripId: string, serviceId: string): string | null {
  const rest = tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : tripId;
  const m = /^(\d+)/.exec(rest);
  return m ? m[1]! : null;
}

interface LineInfo {
  id: string;
  nucleo: string;
  short: string;
  long: string;
  color: string | null;
}

export async function buildIndex(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`[renfe] ${m}\n`));
  mkdirSync(opts.dir, { recursive: true });
  // Restos de reconstrucciones interrumpidas de procesos que ya no existen.
  for (const f of readdirSync(opts.dir)) {
    if (/^index\.\d+\.tmp\.db(-journal)?$/.test(f) && !f.startsWith(`index.${process.pid}.`)) {
      rmSync(join(opts.dir, f), { force: true });
    }
  }
  const tmp = join(opts.dir, `index.${process.pid}.tmp.db`);
  const finalPath = join(opts.dir, INDEX_FILE);
  rmSync(tmp, { force: true });

  const zip = await ZipArchive.open(opts.zipPath);
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(tmp);
  let ok = false;
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec(SCHEMA);
    db.exec('BEGIN');

    const rows = async (name: string) => {
      const s = await zip.stream(name);
      return s ? csvRows(s) : null;
    };

    // --- routes → líneas (un route_id es un sentido; se agrupan por núcleo + nombre corto)
    const lines = new Map<string, LineInfo>();
    const routeLine = new Map<string, string>();
    const unknownPrefixes = new Set<string>();
    const routesIt = await rows('routes.txt');
    if (!routesIt) throw new Error('El zip no trae routes.txt');
    const insLineRoute = db.prepare('INSERT INTO line_routes (line_id, route_id) VALUES (?, ?)');
    for await (const r of routesIt) {
      const routeId = r.route_id ?? '';
      if (!routeId) continue;
      const nuc = nucleoOfRoute(routeId);
      if (!nuc) {
        const prefix = routeId.slice(0, 2);
        if (!unknownPrefixes.has(prefix)) {
          unknownPrefixes.add(prefix);
          warn(`núcleo desconocido (prefijo «${prefix}» de ${routeId}): sus rutas se ignoran`);
        }
        continue;
      }
      const short = r.route_short_name || routeId.replace(/^\d{2}T\d+/, '') || routeId;
      const lineId = `${nuc.id}/${short}`;
      if (!lines.has(lineId)) {
        lines.set(lineId, {
          id: lineId,
          nucleo: nuc.id,
          short,
          long: tidyLabel(r.route_long_name ?? ''),
          color: r.route_color || null,
        });
      }
      routeLine.set(routeId, lineId);
      insLineRoute.run(lineId, routeId);
    }
    const lineIds = [...lines.keys()];
    const lineIdx = new Map(lineIds.map((id, i) => [id, i]));

    // --- stops
    const insStop = db.prepare(
      'INSERT OR REPLACE INTO stops (stop_id, name, norm, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    const stopsIt = await rows('stops.txt');
    if (!stopsIt) throw new Error('El zip no trae stops.txt');
    for await (const s of stopsIt) {
      if (!s.stop_id) continue;
      const lat = Number.parseFloat(s.stop_lat ?? '');
      const lon = Number.parseFloat(s.stop_lon ?? '');
      insStop.run(
        s.stop_id,
        s.stop_name ?? '',
        normalizeName(s.stop_name ?? ''),
        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lon) ? lon : null,
      );
    }

    // --- calendar y calendar_dates
    const insCal = db.prepare(
      'INSERT OR REPLACE INTO calendar (service_id, d0, d1, d2, d3, d4, d5, d6, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const calIt = await rows('calendar.txt');
    if (calIt) {
      for await (const c of calIt) {
        if (!c.service_id) continue;
        insCal.run(
          c.service_id,
          Number(c.monday),
          Number(c.tuesday),
          Number(c.wednesday),
          Number(c.thursday),
          Number(c.friday),
          Number(c.saturday),
          Number(c.sunday),
          c.start_date ?? '',
          c.end_date ?? '',
        );
      }
    }
    const insCalDate = db.prepare(
      'INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)',
    );
    const calDatesIt = await rows('calendar_dates.txt');
    if (calDatesIt) {
      for await (const c of calDatesIt) {
        if (!c.service_id || !c.date) continue;
        insCalDate.run(c.service_id, c.date, Number(c.exception_type));
      }
    }

    // --- transfers
    const insTransfer = db.prepare(
      'INSERT INTO transfers (from_stop, to_stop, min_time) VALUES (?, ?, ?)',
    );
    const trIt = await rows('transfers.txt');
    if (trIt) {
      for await (const t of trIt) {
        if (!t.from_stop_id || !t.to_stop_id) continue;
        if (t.transfer_type === '3') continue; // transbordo imposible
        const min = Number.parseInt(t.min_transfer_time ?? '', 10);
        insTransfer.run(t.from_stop_id, t.to_stop_id, Number.isFinite(min) ? min : null);
      }
    }

    // --- trips: se asigna un `tid` entero (las filas de stop_times pesan menos);
    // la fila de `trips` se inserta al final, con sus estadísticas.
    interface TripRow {
      tripId: string;
      routeId: string;
      lineId: string;
      serviceId: string;
      headsign: string;
    }
    const tripTid = new Map<string, number>();
    const tripRows: TripRow[] = [];
    const tripsIt = await rows('trips.txt');
    if (!tripsIt) throw new Error('El zip no trae trips.txt');
    for await (const t of tripsIt) {
      const lineId = routeLine.get(t.route_id ?? '');
      if (!lineId || !t.trip_id) continue;
      tripTid.set(t.trip_id, tripRows.length + 1);
      tripRows.push({
        tripId: t.trip_id,
        routeId: t.route_id!,
        lineId,
        serviceId: t.service_id ?? '',
        headsign: t.trip_headsign ?? '',
      });
    }
    const nTrips = tripRows.length;
    const nStops = new Int32Array(nTrips + 1);
    const minSeq = new Int32Array(nTrips + 1).fill(2147483647);
    const maxSeq = new Int32Array(nTrips + 1).fill(-1);
    const firstDep = new Int32Array(nTrips + 1).fill(-1);
    const firstStop: string[] = new Array<string>(nTrips + 1).fill('');
    const lastStop: string[] = new Array<string>(nTrips + 1).fill('');
    const stopLines = new Map<string, Set<number>>();

    // --- stop_times (el grueso: 1,79 M filas)
    const insST = db.prepare(
      'INSERT INTO stop_times (tid, seq, stop_id, arr, dep) VALUES (?, ?, ?, ?, ?)',
    );
    const stIt = await rows('stop_times.txt');
    if (!stIt) throw new Error('El zip no trae stop_times.txt');
    let stopTimes = 0;
    for await (const st of stIt) {
      const tid = tripTid.get(st.trip_id ?? '');
      if (tid === undefined) continue;
      const dep0 = parseClock(st.departure_time ?? '');
      const arr0 = parseClock(st.arrival_time ?? '');
      const dep = dep0 ?? arr0;
      const arr = arr0 ?? dep0;
      const seq = Number.parseInt(st.stop_sequence ?? '', 10);
      const stopId = st.stop_id ?? '';
      if (dep === null || arr === null || !Number.isFinite(seq) || !stopId) continue;
      insST.run(tid, seq, stopId, arr, dep);
      stopTimes++;
      nStops[tid]!++;
      if (seq < minSeq[tid]!) {
        minSeq[tid] = seq;
        firstStop[tid] = stopId;
        firstDep[tid] = dep;
      }
      if (seq > maxSeq[tid]!) {
        maxSeq[tid] = seq;
        lastStop[tid] = stopId;
      }
      let set = stopLines.get(stopId);
      if (!set) stopLines.set(stopId, (set = new Set()));
      set.add(lineIdx.get(tripRows[tid - 1]!.lineId)!);
    }

    // --- trips con sus estadísticas
    const insTrip = db.prepare(
      'INSERT INTO trips (tid, trip_id, route_id, line_id, service_id, headsign, short_name, first_stop, last_stop, first_dep, n_stops) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < nTrips; i++) {
      const tid = i + 1;
      const t = tripRows[i]!;
      insTrip.run(
        tid,
        t.tripId,
        t.routeId,
        t.lineId,
        t.serviceId,
        t.headsign,
        tripShortNumber(t.tripId, t.serviceId),
        firstStop[tid] || null,
        lastStop[tid] || null,
        firstDep[tid]! >= 0 ? firstDep[tid]! : null,
        nStops[tid]!,
      );
    }

    // --- stop_lines
    const insSL = db.prepare('INSERT INTO stop_lines (stop_id, line_id) VALUES (?, ?)');
    for (const [stopId, set] of stopLines) for (const li of set) insSL.run(stopId, lineIds[li]!);

    db.exec(INDEXES);

    // --- line_stops: el recorrido más largo (el viaje con más paradas) de cada línea
    const longest = db
      .prepare(
        `SELECT line_id, tid FROM (
           SELECT line_id, tid, ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY n_stops DESC, tid) AS rn
           FROM trips WHERE n_stops > 0
         ) WHERE rn = 1`,
      )
      .all() as Array<{ line_id: string; tid: number }>;
    const pattern = db.prepare('SELECT stop_id FROM stop_times WHERE tid = ? ORDER BY seq');
    const insLS = db.prepare('INSERT INTO line_stops (line_id, pos, stop_id) VALUES (?, ?, ?)');
    const lineLen = new Map<string, number>();
    for (const l of longest) {
      const stops = pattern.all(l.tid) as Array<{ stop_id: string }>;
      let pos = 0;
      const seen = new Set<string>();
      for (const s of stops) {
        if (seen.has(s.stop_id)) continue; // un circuito repite estación: se cuenta una vez
        seen.add(s.stop_id);
        insLS.run(l.line_id, ++pos, s.stop_id);
      }
      lineLen.set(l.line_id, pos);
    }

    // --- lines y nucleos (solo los que tienen servicio en el zip)
    const insLine = db.prepare(
      'INSERT INTO lines (id, nucleo, short_name, long_name, color, n_stops) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insNucleo = db.prepare(
      'INSERT INTO nucleos (id, prefix, name, comunidad) VALUES (?, ?, ?, ?)',
    );
    const present = new Set<string>();
    for (const l of lines.values()) {
      if (!lineLen.has(l.id)) continue; // línea sin viajes con paradas: no se ofrece
      present.add(l.nucleo);
      insLine.run(l.id, l.nucleo, l.short, l.long, l.color, lineLen.get(l.id) ?? 0);
    }
    for (const n of NUCLEOS)
      if (present.has(n.id)) insNucleo.run(n.id, n.prefix, n.name, n.comunidad);

    // --- meta
    const feedDate = opts.feedDate ?? zip.newestDate() ?? '';
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insMeta.run('schema_version', INDEX_SCHEMA_VERSION);
    insMeta.run('built_at', (opts.now?.() ?? new Date()).toISOString());
    insMeta.run('feed_date', feedDate);
    insMeta.run('source_url', opts.sourceUrl);

    db.exec('COMMIT');
    db.exec('ANALYZE');
    db.close();
    renameSync(tmp, finalPath);
    ok = true;
    return { path: finalPath, stopTimes, trips: nTrips, ms: Date.now() - started };
  } finally {
    if (!ok) {
      try {
        db.close();
      } catch {
        // ya cerrada
      }
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-journal`, { force: true });
    }
  }
}

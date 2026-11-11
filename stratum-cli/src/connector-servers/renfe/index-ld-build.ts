/**
 * Índice SQLite de la larga y media distancia (GTFS AV/LD/MD de Renfe), aparte
 * del de Cercanías (`index-ld.db` junto a `index.db`): cada uno tiene su propio
 * ciclo de vida y un fallo de uno no toca al otro. El zip es pequeño (~700 KB,
 * 54 000 horas de paso), pero se lee igual en streaming y se escribe en un
 * temporal que, al terminar, se renombra sobre el índice.
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { csvRows } from './csv.js';
import { normalizeName } from './normalize.js';
import { loadSqlite } from './sqlite.js';
import { parseClock } from './time.js';
import { ZipArchive } from './zip.js';

/** Sube si cambia el esquema: un índice de otra versión se ignora y se reconstruye. */
export const LD_INDEX_SCHEMA_VERSION = '1';

export const LD_INDEX_FILE = 'index-ld.db';

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE routes (route_id TEXT PRIMARY KEY, product TEXT NOT NULL);
CREATE TABLE stops (stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, norm TEXT NOT NULL, lat REAL, lon REAL);
CREATE TABLE trips (tid INTEGER PRIMARY KEY, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, product TEXT NOT NULL, number TEXT, service_id TEXT NOT NULL, first_stop TEXT, last_stop TEXT, first_dep INTEGER, n_stops INTEGER NOT NULL DEFAULT 0);
CREATE TABLE stop_times (tid INTEGER NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, arr INTEGER NOT NULL, dep INTEGER NOT NULL, pickup INTEGER NOT NULL DEFAULT 0, drop_off INTEGER NOT NULL DEFAULT 0);
CREATE TABLE calendar (service_id TEXT PRIMARY KEY, d0 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER, d4 INTEGER, d5 INTEGER, d6 INTEGER, start_date TEXT NOT NULL, end_date TEXT NOT NULL);
CREATE TABLE calendar_dates (service_id TEXT NOT NULL, date TEXT NOT NULL, exception_type INTEGER NOT NULL);
`;

const INDEXES = `
CREATE INDEX idx_ld_st_stop ON stop_times (stop_id, dep);
CREATE INDEX idx_ld_st_trip ON stop_times (tid, seq);
CREATE UNIQUE INDEX idx_ld_trips_id ON trips (trip_id);
CREATE INDEX idx_ld_trips_number ON trips (number);
CREATE INDEX idx_ld_stops_norm ON stops (norm);
CREATE INDEX idx_ld_cal_dates ON calendar_dates (date);
`;

export interface LdBuildOptions {
  zipPath: string;
  /** Directorio de la caché: allí quedan `index-ld.db` y el temporal. */
  dir: string;
  sourceUrl: string;
  /** Fecha de los datos (`YYYYMMDD`); por defecto, la del fichero más reciente del zip. */
  feedDate?: string;
  now?: () => Date;
}

export interface LdBuildResult {
  path: string;
  stopTimes: number;
  trips: number;
  ms: number;
}

/**
 * Número de tren que ve la gente: `trip_short_name` `00190` → `190`. Sin él, los
 * cinco primeros dígitos del `trip_id` (`0019012026-11-11` → `190`).
 */
export function trainNumber(shortName: string, tripId: string): string | null {
  const raw = /^\d+$/.test(shortName) ? shortName : (/^(\d{5})/.exec(tripId)?.[1] ?? '');
  if (!raw) return null;
  return raw.replace(/^0+(?=\d)/, '');
}

export async function buildLdIndex(opts: LdBuildOptions): Promise<LdBuildResult> {
  const started = Date.now();
  mkdirSync(opts.dir, { recursive: true });
  // Restos de reconstrucciones interrumpidas de procesos que ya no existen.
  for (const f of readdirSync(opts.dir)) {
    if (
      /^index-ld\.\d+\.tmp\.db(-journal)?$/.test(f) &&
      !f.startsWith(`index-ld.${process.pid}.`)
    ) {
      rmSync(join(opts.dir, f), { force: true });
    }
  }
  const tmp = join(opts.dir, `index-ld.${process.pid}.tmp.db`);
  const finalPath = join(opts.dir, LD_INDEX_FILE);
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

    // --- routes: el producto es `route_short_name` (AVE, ALVIA, Intercity…)
    const routeProduct = new Map<string, string>();
    const routesIt = await rows('routes.txt');
    if (!routesIt) throw new Error('El zip no trae routes.txt');
    const insRoute = db.prepare('INSERT OR REPLACE INTO routes (route_id, product) VALUES (?, ?)');
    for await (const r of routesIt) {
      if (!r.route_id) continue;
      const product = r.route_short_name || r.route_long_name || 'Larga distancia';
      routeProduct.set(r.route_id, product);
      insRoute.run(r.route_id, product);
    }

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

    // --- calendar y calendar_dates (el rango que cubren los horarios sale de aquí)
    let firstDate = '';
    let lastDate = '';
    const widen = (ymd: string) => {
      if (!/^\d{8}$/.test(ymd)) return;
      if (!firstDate || ymd < firstDate) firstDate = ymd;
      if (!lastDate || ymd > lastDate) lastDate = ymd;
    };
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
        widen(c.start_date ?? '');
        widen(c.end_date ?? '');
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
        // Una fecha añadida (tipo 1) amplía lo que cubren los horarios; una quitada, no.
        if (Number(c.exception_type) === 1) widen(c.date);
      }
    }

    // --- trips (`tid` entero para las filas de stop_times)
    interface TripRow {
      tripId: string;
      routeId: string;
      product: string;
      number: string | null;
      serviceId: string;
    }
    const tripTid = new Map<string, number>();
    const tripRows: TripRow[] = [];
    const tripsIt = await rows('trips.txt');
    if (!tripsIt) throw new Error('El zip no trae trips.txt');
    for await (const t of tripsIt) {
      const product = routeProduct.get(t.route_id ?? '');
      if (product === undefined || !t.trip_id) continue;
      tripTid.set(t.trip_id, tripRows.length + 1);
      tripRows.push({
        tripId: t.trip_id,
        routeId: t.route_id!,
        product,
        number: trainNumber(t.trip_short_name ?? '', t.trip_id),
        serviceId: t.service_id ?? '',
      });
    }
    const nTrips = tripRows.length;
    const nStops = new Int32Array(nTrips + 1);
    const minSeq = new Int32Array(nTrips + 1).fill(2147483647);
    const maxSeq = new Int32Array(nTrips + 1).fill(-1);
    const firstDep = new Int32Array(nTrips + 1).fill(-1);
    const firstStop: string[] = new Array<string>(nTrips + 1).fill('');
    const lastStop: string[] = new Array<string>(nTrips + 1).fill('');

    // --- stop_times
    const insST = db.prepare(
      'INSERT INTO stop_times (tid, seq, stop_id, arr, dep, pickup, drop_off) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
      // 1 = no se puede subir (pickup) / bajar (drop_off); 0, 2 y 3 sí (3 con aviso previo).
      const pickup = st.pickup_type === '1' ? 1 : 0;
      const drop = st.drop_off_type === '1' ? 1 : 0;
      insST.run(tid, seq, stopId, arr, dep, pickup, drop);
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
    }

    const insTrip = db.prepare(
      'INSERT INTO trips (tid, trip_id, route_id, product, number, service_id, first_stop, last_stop, first_dep, n_stops) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < nTrips; i++) {
      const tid = i + 1;
      const t = tripRows[i]!;
      insTrip.run(
        tid,
        t.tripId,
        t.routeId,
        t.product,
        t.number,
        t.serviceId,
        firstStop[tid] || null,
        lastStop[tid] || null,
        firstDep[tid]! >= 0 ? firstDep[tid]! : null,
        nStops[tid]!,
      );
    }

    db.exec(INDEXES);

    // --- meta
    const feedDate = opts.feedDate ?? zip.newestDate() ?? '';
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insMeta.run('schema_version', LD_INDEX_SCHEMA_VERSION);
    insMeta.run('built_at', (opts.now?.() ?? new Date()).toISOString());
    insMeta.run('feed_date', feedDate);
    insMeta.run('source_url', opts.sourceUrl);
    insMeta.run('first_date', firstDate);
    insMeta.run('last_date', lastDate);

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

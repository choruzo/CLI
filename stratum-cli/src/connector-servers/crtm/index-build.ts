/**
 * Índice SQLite de un modo del CRTM (`index-<modo>.db`). Se construye desde el
 * GTFS en streaming (zip temporal → índice temporal → rename atómico).
 *
 * Forma del índice, pensada para los tres feeds a la vez:
 * - Una **estación** agrupa andenes: por su `parent_station` si lo tiene y, si
 *   no, por la convención del CRTM (`par_<red>_<n>` ↔ `est_<red>_<n>`, medida en
 *   Metro y Metro Ligero: muchos andenes no declaran el padre). Los accesos
 *   (`location_type` 2) se ignoran. En la EMT cada parada es su propia estación.
 * - Un **patrón** es la secuencia de paradas de un viaje con sus desfases
 *   respecto a su primera salida; los viajes que repiten patrón (la EMT tiene
 *   86 842, casi todos iguales) lo comparten, y cada viaje solo guarda su hora
 *   de inicio. Una parada pasa a `first_dep + desfase`.
 * - Un viaje con filas en `frequencies.txt` es **por frecuencia**: sus ventanas
 *   (`start`, `end`, `headway`) dicen cada cuánto sale desde el origen; sin
 *   ellas es un viaje de hora exacta. Una misma plantilla puede traer varias
 *   ventanas (Metro) o una (EMT).
 * `stop_times.txt` debe venir agrupado por viaje (en los tres feeds reales lo
 * está); si no, se aborta en vez de indexar un viaje partido.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { csvRows } from '../renfe/csv.js';
import { normalizeName } from '../renfe/normalize.js';
import { loadSqlite } from '../renfe/sqlite.js';
import { parseClock } from '../renfe/time.js';
import { ZipArchive } from '../renfe/zip.js';
import { feedMode, type ModeId } from './feeds.js';
import { titleCase } from './names.js';

/** Sube si cambia el esquema: un índice de otra versión se ignora y se reconstruye. */
export const INDEX_SCHEMA_VERSION = '1';

/** Un temporal de construcción más viejo que esto es de un proceso que murió. */
const STALE_TMP_MS = 2 * 60 * 60_000;

export function indexFile(mode: ModeId): string {
  return `index-${mode}.db`;
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE routes (route_id TEXT PRIMARY KEY, short_name TEXT NOT NULL, long_name TEXT NOT NULL, color TEXT);
CREATE TABLE stations (station_id TEXT PRIMARY KEY, name TEXT NOT NULL, norm TEXT NOT NULL, lat REAL, lon REAL);
CREATE TABLE stops (stop_id TEXT PRIMARY KEY, station_id TEXT NOT NULL);
CREATE TABLE patterns (pid INTEGER PRIMARY KEY, n_stops INTEGER NOT NULL, last_stop TEXT NOT NULL);
CREATE TABLE pattern_stops (pid INTEGER NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, arr INTEGER NOT NULL, dep INTEGER NOT NULL);
CREATE TABLE trips (tid INTEGER PRIMARY KEY, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction INTEGER NOT NULL, headsign TEXT NOT NULL, pid INTEGER NOT NULL, first_dep INTEGER NOT NULL, freq INTEGER NOT NULL);
CREATE TABLE windows (tid INTEGER NOT NULL, start_t INTEGER NOT NULL, end_t INTEGER NOT NULL, headway INTEGER NOT NULL);
CREATE TABLE station_routes (station_id TEXT NOT NULL, route_id TEXT NOT NULL);
CREATE TABLE calendar (service_id TEXT PRIMARY KEY, d0 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER, d4 INTEGER, d5 INTEGER, d6 INTEGER, start_date TEXT NOT NULL, end_date TEXT NOT NULL);
CREATE TABLE calendar_dates (service_id TEXT NOT NULL, date TEXT NOT NULL, exception_type INTEGER NOT NULL);
`;

const INDEXES = `
CREATE INDEX idx_ps_stop ON pattern_stops (stop_id);
CREATE INDEX idx_ps_pid ON pattern_stops (pid, seq);
CREATE INDEX idx_trips_pid ON trips (pid);
CREATE INDEX idx_trips_route ON trips (route_id);
CREATE INDEX idx_windows_tid ON windows (tid);
CREATE INDEX idx_stations_norm ON stations (norm);
CREATE INDEX idx_stops_station ON stops (station_id);
CREATE INDEX idx_sr_station ON station_routes (station_id);
CREATE INDEX idx_cal_dates ON calendar_dates (date);
`;

export interface BuildOptions {
  mode: ModeId;
  zipPath: string;
  /** Directorio de la caché: allí quedan `index-<modo>.db` y el temporal. */
  dir: string;
  /** `modified` de ArcGIS (ms epoch, como texto): lo que decide si hay que volver a descargar. */
  feedModified: string;
  now?: () => Date;
  warn?: (msg: string) => void;
}

export interface BuildResult {
  path: string;
  trips: number;
  patterns: number;
  stations: number;
  ms: number;
}

interface StopRow {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  type: string;
  parent: string;
}

/** Estación a la que pertenece una parada: padre declarado, convención `par_`→`est_` o ella misma. */
export function stationOf(stopId: string, stops: ReadonlyMap<string, StopRow>): string {
  const s = stops.get(stopId);
  if (!s || s.type === '1') return stopId;
  if (s.parent && stops.has(s.parent)) return s.parent;
  const m = /^par_(\d+)_(\d+)$/.exec(stopId);
  if (m) {
    const est = `est_${m[1]}_${m[2]}`;
    if (stops.get(est)?.type === '1') return est;
  }
  return stopId;
}

const DAY = 86_400;

/**
 * Corrección de un viaje con la hora local de su `trip_id` (`…_06:05:00_…`,
 * `FeedMode.tripIdClock`): etiqueta − primera salida, llevada a ±12 h (un viaje
 * etiquetado 00:12 que sale a las 23:12 es +1 h, no −23 h). `null` si no hay
 * etiqueta o la diferencia no es un número entero de horas de como mucho 3:
 * entonces no es un desfase de zona horaria y se deja la hora del feed.
 */
export function tripIdShift(tripId: string, firstDep: number): number | null {
  const m = /_(\d{2}):(\d{2}):(\d{2})_/.exec(tripId);
  if (!m) return null;
  const label = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  let d = (label - firstDep) % DAY;
  if (d > DAY / 2) d -= DAY;
  if (d <= -DAY / 2) d += DAY;
  if (d % 3600 !== 0 || Math.abs(d) > 3 * 3600) return null;
  return d;
}

interface Win {
  start: number;
  end: number;
  headway: number;
}

interface TripMeta {
  routeId: string;
  serviceId: string;
  direction: number;
  headsign: string;
}

export async function buildModeIndex(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const mode = feedMode(opts.mode);
  mkdirSync(opts.dir, { recursive: true });
  // Restos de reconstrucciones interrumpidas: solo los antiguos (el temporal de otro proceso vivo
  // que comparta la caché es reciente y no se toca).
  const tmpRe = new RegExp(`^index-${opts.mode}\\.\\d+\\.tmp\\.db(-journal)?$`);
  for (const f of readdirSync(opts.dir)) {
    if (!tmpRe.test(f) || f.startsWith(`index-${opts.mode}.${process.pid}.`)) continue;
    try {
      if (Date.now() - statSync(join(opts.dir, f)).mtimeMs > STALE_TMP_MS) {
        rmSync(join(opts.dir, f), { force: true });
      }
    } catch {
      // desapareció entre el listado y el stat
    }
  }
  const tmp = join(opts.dir, `index-${opts.mode}.${process.pid}.tmp.db`);
  const finalPath = join(opts.dir, indexFile(opts.mode));
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

    // --- routes
    const insRoute = db.prepare(
      'INSERT OR REPLACE INTO routes (route_id, short_name, long_name, color) VALUES (?, ?, ?, ?)',
    );
    const routesIt = await rows('routes.txt');
    if (!routesIt) throw new Error('El zip no trae routes.txt');
    const routeIds = new Set<string>();
    for await (const r of routesIt) {
      if (!r.route_id) continue;
      routeIds.add(r.route_id);
      insRoute.run(
        r.route_id,
        r.route_short_name || r.route_id,
        r.route_long_name ?? '',
        r.route_color || null,
      );
    }

    // --- stops (en memoria: 5 000 filas en la EMT)
    const stops = new Map<string, StopRow>();
    const stopsIt = await rows('stops.txt');
    if (!stopsIt) throw new Error('El zip no trae stops.txt');
    for await (const s of stopsIt) {
      if (!s.stop_id) continue;
      const lat = Number.parseFloat(s.stop_lat ?? '');
      const lon = Number.parseFloat(s.stop_lon ?? '');
      stops.set(s.stop_id, {
        id: s.stop_id,
        name: s.stop_name ?? '',
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        type: s.location_type ?? '',
        parent: s.parent_station ?? '',
      });
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

    // --- trips y frecuencias
    const trips = new Map<string, TripMeta>();
    const tripsIt = await rows('trips.txt');
    if (!tripsIt) throw new Error('El zip no trae trips.txt');
    for await (const t of tripsIt) {
      if (!t.trip_id || !routeIds.has(t.route_id ?? '')) continue;
      trips.set(t.trip_id, {
        routeId: t.route_id!,
        serviceId: t.service_id ?? '',
        direction: t.direction_id === '1' ? 1 : 0,
        headsign: t.trip_headsign ?? '',
      });
    }
    const wins = new Map<string, Win[]>();
    const freqIt = await rows('frequencies.txt');
    if (freqIt) {
      for await (const f of freqIt) {
        const start = parseClock(f.start_time ?? '');
        const end = parseClock(f.end_time ?? '');
        const headway = Number.parseInt(f.headway_secs ?? '', 10);
        if (!f.trip_id || start === null || end === null || !(headway > 0)) continue;
        const list = wins.get(f.trip_id) ?? [];
        list.push({ start, end, headway });
        wins.set(f.trip_id, list);
      }
    }

    // --- stop_times → patrones + viajes
    const insPattern = db.prepare(
      'INSERT INTO patterns (pid, n_stops, last_stop) VALUES (?, ?, ?)',
    );
    const insPS = db.prepare(
      'INSERT INTO pattern_stops (pid, seq, stop_id, arr, dep) VALUES (?, ?, ?, ?, ?)',
    );
    const insTrip = db.prepare(
      'INSERT INTO trips (tid, trip_id, route_id, service_id, direction, headsign, pid, first_dep, freq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insWin = db.prepare(
      'INSERT INTO windows (tid, start_t, end_t, headway) VALUES (?, ?, ?, ?)',
    );
    const patternIds = new Map<string, number>();
    const usedStops = new Set<string>();
    const done = new Set<string>();
    let nTrips = 0;
    // `tripIdClock`: viajes corregidos con su etiqueta, y los que no la traían o no casaban.
    let shifted = 0;
    let unlabeled = 0;

    interface StopTime {
      seq: number;
      stop: string;
      arr: number;
      dep: number;
    }
    let curId = '';
    let cur: StopTime[] = [];
    const flush = (): void => {
      if (!curId) return;
      const meta = trips.get(curId);
      const list = cur;
      const id = curId;
      curId = '';
      cur = [];
      if (!meta || list.length === 0) return;
      done.add(id);
      list.sort((a, b) => a.seq - b.seq);
      const base = list[0]!.dep;
      const key = list.map((r) => `${r.stop}|${r.arr - base}|${r.dep - base}`).join(';');
      let pid = patternIds.get(key);
      if (pid === undefined) {
        pid = patternIds.size + 1;
        patternIds.set(key, pid);
        insPattern.run(pid, list.length, list[list.length - 1]!.stop);
        list.forEach((r, i) => {
          insPS.run(pid!, i, r.stop, r.arr - base, r.dep - base);
          usedStops.add(r.stop);
        });
      }
      const w = wins.get(id);
      const shift = mode.tripIdClock ? tripIdShift(id, base) : 0;
      if (shift === null) unlabeled++;
      else if (shift !== 0) shifted++;
      const tid = ++nTrips;
      const headsign = meta.headsign
        ? titleCase(meta.headsign)
        : titleCase(stops.get(list[list.length - 1]!.stop)?.name ?? '');
      insTrip.run(
        tid,
        id,
        meta.routeId,
        meta.serviceId,
        meta.direction,
        headsign,
        pid,
        base + (shift ?? 0),
        w && w.length > 0 ? 1 : 0,
      );
      for (const x of w ?? []) {
        insWin.run(tid, x.start + (shift ?? 0), x.end + (shift ?? 0), x.headway);
      }
    };

    const stIt = await rows('stop_times.txt');
    if (!stIt) throw new Error('El zip no trae stop_times.txt');
    for await (const st of stIt) {
      const id = st.trip_id ?? '';
      if (id !== curId) {
        flush();
        if (done.has(id)) {
          throw new Error('stop_times.txt no está agrupado por viaje (el viaje reaparece)');
        }
        curId = id;
      }
      if (!trips.has(id)) continue;
      const dep0 = parseClock(st.departure_time ?? '');
      const arr0 = parseClock(st.arrival_time ?? '');
      const dep = dep0 ?? arr0;
      const arr = arr0 ?? dep0;
      const seq = Number.parseInt(st.stop_sequence ?? '', 10);
      if (dep === null || arr === null || !Number.isFinite(seq) || !st.stop_id) continue;
      cur.push({ seq, stop: st.stop_id, arr, dep });
    }
    flush();

    // --- estaciones: solo las que tienen servicio
    const insStop = db.prepare('INSERT INTO stops (stop_id, station_id) VALUES (?, ?)');
    const insStation = db.prepare(
      'INSERT OR IGNORE INTO stations (station_id, name, norm, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    for (const stopId of usedStops) {
      const stationId = stationOf(stopId, stops);
      insStop.run(stopId, stationId);
      const st = stops.get(stationId) ?? stops.get(stopId)!;
      const name = titleCase(st.name || stopId);
      insStation.run(stationId, name, normalizeName(name), st.lat, st.lon);
    }
    db.exec(`INSERT INTO station_routes (station_id, route_id)
      SELECT DISTINCT s.station_id, pr.route_id
      FROM (SELECT DISTINCT pid, route_id FROM trips) pr
      JOIN pattern_stops ps ON ps.pid = pr.pid
      JOIN stops s ON s.stop_id = ps.stop_id`);
    db.exec(INDEXES);

    // --- meta
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insMeta.run('schema_version', INDEX_SCHEMA_VERSION);
    insMeta.run('mode', opts.mode);
    insMeta.run('built_at', (opts.now?.() ?? new Date()).toISOString());
    insMeta.run('feed_modified', opts.feedModified);
    insMeta.run('first_date', firstDate);
    insMeta.run('last_date', lastDate);
    if (nTrips === 0) opts.warn?.(`el GTFS de ${mode.label} no trae viajes con horas de paso`);
    if (mode.tripIdClock) {
      insMeta.run('trip_id_clock', `${shifted} corregidos, ${unlabeled} sin etiqueta válida`);
      if (unlabeled > 0) {
        opts.warn?.(
          `${mode.label}: ${unlabeled} viajes sin hora en el trip_id (o con un desfase que no es de zona horaria); se usan sus horas de stop_times`,
        );
      }
    }

    const nStations = (db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number }).n;
    db.exec('COMMIT');
    db.exec('ANALYZE');
    db.close();
    renameSync(tmp, finalPath);
    ok = true;
    return {
      path: finalPath,
      trips: nTrips,
      patterns: patternIds.size,
      stations: nStations,
      ms: Date.now() - started,
    };
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

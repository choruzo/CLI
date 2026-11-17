/**
 * Utilidades para los tests del conector y su server de fixtures de los evals
 * (`fixture-server.ts`): un zip mínimo (stored o deflate), un codificador
 * protobuf para fabricar feeds GTFS-RT, el índice de las fixtures y un contexto
 * de tools con reloj fijo. Nunca entra en el server de la caja (`server.ts`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './index-build.js';
import { buildLdIndex } from './index-ld-build.js';
import { RenfeIndex } from './queries.js';
import { LdIndex } from './queries-ld.js';
import { RealtimeSource } from './realtime.js';
import { ToolUserError } from '../lib/mcp-stdio.js';
import type { RenfeContext } from './tools.js';
import type { TrenesContext } from './tools-ld.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

// --- ZIP ---------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Escribe un zip. `method` 0 = stored, 8 = deflate. */
export function makeZip(
  entries: Record<string, string | Buffer>,
  method: 0 | 8 = 8,
  date = { y: 2026, m: 11, d: 11 },
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosDate = ((date.y - 1980) << 9) | (date.m << 5) | date.d;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc32(data), 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

const GTFS_FILES = [
  'routes.txt',
  'stops.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'transfers.txt',
];

/** El GTFS recortado de `fixtures/gtfs/` empaquetado en un zip. */
export function fixtureZip(method: 0 | 8 = 8, fixtures = FIXTURES): Buffer {
  const entries: Record<string, string> = {};
  for (const f of GTFS_FILES) entries[f] = readFileSync(join(fixtures, 'gtfs', f), 'utf8');
  return makeZip(entries, method);
}

/** Construye el índice de las fixtures en `dir` y devuelve su ruta. */
export async function buildFixtureIndex(
  dir: string,
  warn?: (m: string) => void,
  fixtures = FIXTURES,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'fixture.zip');
  writeFileSync(zipPath, fixtureZip(8, fixtures));
  const r = await buildIndex({
    zipPath,
    dir,
    sourceUrl: 'test://fixture',
    feedDate: '20261111',
    now: () => new Date('2026-11-11T17:00:00Z'),
    warn: warn ?? (() => undefined),
  });
  return r.path;
}

// --- Protobuf (codificador) ---------------------------------------------------

function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  if (n < 0n) n += 1n << 64n;
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}

const tag = (field: number, wire: number): Buffer => varint(field * 8 + wire);
const vf = (field: number, v: number): Buffer => Buffer.concat([tag(field, 0), varint(v)]);
const lf = (field: number, b: Buffer): Buffer =>
  Buffer.concat([tag(field, 2), varint(b.length), b]);
const sf = (field: number, s: string): Buffer => lf(field, Buffer.from(s, 'utf8'));
const ff = (field: number, v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return Buffer.concat([tag(field, 5), b]);
};

export interface EncEvent {
  delay?: number;
  time?: number;
}
export interface EncStopUpdate {
  seq?: number;
  stopId?: string;
  arrival?: EncEvent;
  departure?: EncEvent;
  /** 0 SCHEDULED, 1 SKIPPED, 2 NO_DATA. */
  relationship?: number;
}

function encEvent(e: EncEvent): Buffer {
  const parts: Buffer[] = [];
  if (e.delay !== undefined) parts.push(vf(1, e.delay));
  if (e.time !== undefined) parts.push(vf(2, e.time));
  return Buffer.concat(parts);
}

function tripDescriptor(tripId: string, relationship?: number): Buffer {
  return Buffer.concat([
    sf(1, tripId),
    ...(relationship !== undefined ? [vf(4, relationship)] : []),
  ]);
}

export function tripUpdateEntity(o: {
  id?: string;
  tripId: string;
  /** 0 SCHEDULED, 3 CANCELED. */
  relationship?: number;
  delay?: number;
  stops?: EncStopUpdate[];
}): Buffer {
  const parts: Buffer[] = [lf(1, tripDescriptor(o.tripId, o.relationship))];
  for (const s of o.stops ?? []) {
    const sp: Buffer[] = [];
    if (s.seq !== undefined) sp.push(vf(1, s.seq));
    if (s.arrival) sp.push(lf(2, encEvent(s.arrival)));
    if (s.departure) sp.push(lf(3, encEvent(s.departure)));
    if (s.stopId !== undefined) sp.push(sf(4, s.stopId));
    if (s.relationship !== undefined) sp.push(vf(5, s.relationship));
    parts.push(lf(2, Buffer.concat(sp)));
  }
  if (o.delay !== undefined) parts.push(vf(5, o.delay));
  return Buffer.concat([sf(1, o.id ?? `TU_${o.tripId}`), lf(3, Buffer.concat(parts))]);
}

export function vehicleEntity(o: {
  id?: string;
  tripId: string;
  label?: string;
  stopId?: string;
  /** 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO. */
  status?: number;
  lat?: number;
  lon?: number;
  seq?: number;
}): Buffer {
  const parts: Buffer[] = [lf(1, tripDescriptor(o.tripId))];
  if (o.lat !== undefined && o.lon !== undefined)
    parts.push(lf(2, Buffer.concat([ff(1, o.lat), ff(2, o.lon)])));
  if (o.seq !== undefined) parts.push(vf(3, o.seq));
  if (o.status !== undefined) parts.push(vf(4, o.status));
  if (o.stopId !== undefined) parts.push(sf(7, o.stopId));
  if (o.label !== undefined) parts.push(lf(8, sf(2, o.label)));
  return Buffer.concat([sf(1, o.id ?? `VP_${o.tripId}`), lf(4, Buffer.concat(parts))]);
}

export function alertEntity(o: {
  id: string;
  routeIds?: string[];
  stopIds?: string[];
  tripIds?: string[];
  header?: string;
  description?: string;
  start?: number;
  end?: number;
  /** Idiomas de las traducciones, por defecto `es`. */
  translations?: Array<{ text: string; language: string }>;
}): Buffer {
  const parts: Buffer[] = [];
  if (o.start !== undefined || o.end !== undefined) {
    parts.push(
      lf(
        1,
        Buffer.concat([
          ...(o.start !== undefined ? [vf(1, o.start)] : []),
          ...(o.end !== undefined ? [vf(2, o.end)] : []),
        ]),
      ),
    );
  }
  for (const r of o.routeIds ?? []) parts.push(lf(5, sf(2, r)));
  for (const s of o.stopIds ?? []) parts.push(lf(5, sf(5, s)));
  for (const t of o.tripIds ?? []) parts.push(lf(5, lf(4, tripDescriptor(t))));
  const translated = (text: string, language = 'es'): Buffer =>
    lf(1, Buffer.concat([sf(1, text), sf(2, language)]));
  if (o.header) parts.push(lf(10, translated(o.header)));
  if (o.translations) {
    parts.push(lf(11, Buffer.concat(o.translations.map((t) => translated(t.text, t.language)))));
  } else if (o.description) parts.push(lf(11, translated(o.description)));
  return Buffer.concat([sf(1, o.id), lf(5, Buffer.concat(parts))]);
}

/** Un `FeedMessage` con las entidades ya codificadas (`tripUpdateEntity`, …). */
export function encodeFeed(timestamp: number, entities: Buffer[]): Buffer {
  const header = Buffer.concat([sf(1, '2.0'), vf(3, timestamp)]);
  return Buffer.concat([lf(1, header), ...entities.map((e) => lf(2, e))]);
}

export interface FakeFeeds {
  trip_updates?: Buffer;
  vehicle_positions?: Buffer;
  alerts?: Buffer;
}

/** Un `fetch` que sirve esos feeds (y 404 para los que falten). */
export function fakeFeedFetch(feeds: FakeFeeds): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const m = /(trip_updates|vehicle_positions|alerts)(?:_LD)?\.pb$/.exec(url);
    const body = m ? feeds[m[1] as keyof FakeFeeds] : undefined;
    if (!body) return new Response('no', { status: 404 });
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
}

// --- Contexto de tools --------------------------------------------------------

/** 2026-11-11 18:36 en Madrid (UTC+1). */
export const NOW = new Date('2026-11-11T17:36:00Z');

export function fixtureContext(
  indexPath: string,
  realtime: RealtimeSource | null,
  now: Date = NOW,
): RenfeContext {
  return {
    realtime,
    now: () => now,
    async withIndex(fn) {
      const ix = await RenfeIndex.open(indexPath);
      if (!ix) throw new ToolUserError('sin índice');
      try {
        return await fn(ix);
      } finally {
        ix.close();
      }
    },
  };
}

export function fakeRealtime(feeds: FakeFeeds, now: Date = NOW): RealtimeSource {
  return new RealtimeSource({ fetch: fakeFeedFetch(feeds), now: () => now.getTime() });
}

// --- Larga y media distancia ---------------------------------------------------

/** Fixtures de larga distancia: un recorte del GTFS AV/LD/MD real y de sus `.pb` reales. */
export const FIXTURES_LD = join(FIXTURES, 'ld');

const GTFS_LD_FILES = [
  'routes.txt',
  'stops.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
];

/** El GTFS de larga distancia recortado de `fixtures/ld/gtfs/` empaquetado en un zip. */
export function ldFixtureZip(method: 0 | 8 = 8, fixtures = FIXTURES): Buffer {
  const entries: Record<string, string> = {};
  for (const f of GTFS_LD_FILES) {
    entries[f] = readFileSync(join(fixtures, 'ld', 'gtfs', f), 'utf8');
  }
  return makeZip(entries, method);
}

/** Construye el índice de larga distancia de las fixtures en `dir` y devuelve su ruta. */
export async function buildLdFixtureIndex(dir: string, fixtures = FIXTURES): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'fixture-ld.zip');
  writeFileSync(zipPath, ldFixtureZip(8, fixtures));
  const r = await buildLdIndex({
    zipPath,
    dir,
    sourceUrl: 'test://fixture-ld',
    feedDate: '20261111',
    now: () => new Date('2026-11-11T17:00:00Z'),
  });
  return r.path;
}

/** Los `.pb` reales de larga distancia de `fixtures/ld/realtime/`. */
export function ldRealtimeFeeds(fixtures = FIXTURES): FakeFeeds {
  const read = (f: string) => readFileSync(join(fixtures, 'ld', 'realtime', f));
  return {
    trip_updates: read('trip_updates_LD.pb'),
    vehicle_positions: read('vehicle_positions_LD.pb'),
  };
}

/** 2026-11-11 07:36 en Madrid (UTC+1): la mañana de la huelga general, antes de las salidas de las 08:00. */
export const NOW_LD = new Date('2026-11-11T06:36:00Z');

export function ldFixtureContext(
  indexPath: string,
  realtime: RealtimeSource | null,
  now: Date = NOW_LD,
): TrenesContext {
  return {
    realtime,
    now: () => now,
    async withIndex(fn) {
      const ix = await LdIndex.open(indexPath);
      if (!ix) throw new ToolUserError('sin índice');
      try {
        return await fn(ix);
      } finally {
        ix.close();
      }
    },
  };
}

export function ldFakeRealtime(
  feeds: FakeFeeds = ldRealtimeFeeds(),
  now: Date = NOW_LD,
): RealtimeSource {
  return new RealtimeSource({
    fetch: fakeFeedFetch(feeds),
    now: () => now.getTime(),
    suffix: '_LD',
  });
}

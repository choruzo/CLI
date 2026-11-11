/**
 * GTFS-Realtime de Renfe (`gtfsrt.renfe.com/*.pb`, protobuf, se renueva cada
 * 20 s, sin autenticación). Subconjunto de `gtfs-realtime.proto` (números de
 * campo comprobados contra el .proto oficial de google/transit):
 *
 *   FeedMessage        header=1 entity=2
 *   FeedHeader         timestamp=3
 *   FeedEntity         id=1 trip_update=3 vehicle=4 alert=5
 *   TripUpdate         trip=1 stop_time_update=2 vehicle=3 timestamp=4 delay=5
 *   StopTimeUpdate     stop_sequence=1 arrival=2 departure=3 stop_id=4 schedule_relationship=5
 *   StopTimeEvent      delay=1 time=2
 *   TripDescriptor     trip_id=1 schedule_relationship=4 route_id=5
 *   VehicleDescriptor  id=1 label=2
 *   VehiclePosition    trip=1 position=2 current_stop_sequence=3 current_status=4
 *                      timestamp=5 stop_id=7 vehicle=8
 *   Position           latitude=1 longitude=2 (float)
 *   Alert              active_period=1 informed_entity=5 cause=6 effect=7
 *                      header_text=10 description_text=11
 *   TimeRange          start=1 end=2
 *   EntitySelector     route_id=2 trip=4 stop_id=5
 *   TranslatedString   translation=1 { text=1 language=2 }
 */
import { WIRE_FIXED32, WIRE_LEN, WIRE_VARINT, readMessage, type PbReader } from './protobuf.js';

// --- Tipos -------------------------------------------------------------------

export type TripRelationship = 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED' | 'OTHER';
export type StopRelationship = 'SCHEDULED' | 'SKIPPED' | 'NO_DATA' | 'UNSCHEDULED';
export type VehicleStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';

export interface StopTimeEvent {
  /** Segundos de retraso (negativo: adelanto). `undefined` = no informado. */
  delay?: number;
  /** Instante absoluto (segundos epoch). */
  time?: number;
}

export interface StopTimeUpdate {
  seq?: number;
  stopId?: string;
  arrival?: StopTimeEvent;
  departure?: StopTimeEvent;
  relationship: StopRelationship;
}

export interface TripUpdate {
  tripId: string;
  relationship: TripRelationship;
  stops: StopTimeUpdate[];
  vehicleLabel?: string;
  timestamp?: number;
  /** Retraso del viaje (segundos), si lo informa. */
  delay?: number;
}

export interface VehiclePosition {
  tripId?: string;
  label?: string;
  latitude?: number;
  longitude?: number;
  currentSeq?: number;
  stopId?: string;
  status?: VehicleStatus;
  timestamp?: number;
}

export interface InformedEntity {
  routeId?: string;
  stopId?: string;
  tripId?: string;
}

export interface Alert {
  id: string;
  periods: Array<{ start?: number; end?: number }>;
  entities: InformedEntity[];
  cause?: number;
  effect?: number;
  header?: string;
  description?: string;
}

export interface FeedEntity {
  id: string;
  tripUpdate?: TripUpdate;
  vehicle?: VehiclePosition;
  alert?: Alert;
}

export interface Feed {
  /** Instante del feed (segundos epoch), si lo trae. */
  timestamp?: number;
  entities: FeedEntity[];
}

// --- Decodificación ----------------------------------------------------------

function tripRelationship(n: number): TripRelationship {
  switch (n) {
    case 0:
      return 'SCHEDULED';
    case 1:
      return 'ADDED';
    case 2:
      return 'UNSCHEDULED';
    case 3:
      return 'CANCELED';
    default:
      return 'OTHER';
  }
}

function stopRelationship(n: number): StopRelationship {
  switch (n) {
    case 1:
      return 'SKIPPED';
    case 2:
      return 'NO_DATA';
    case 3:
      return 'UNSCHEDULED';
    default:
      return 'SCHEDULED';
  }
}

function decodeTripDescriptor(buf: Uint8Array): {
  tripId?: string;
  relationship: TripRelationship;
} {
  const out: { tripId?: string; relationship: TripRelationship } = { relationship: 'SCHEDULED' };
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.tripId = r.string();
    else if (f === 4 && w === WIRE_VARINT) out.relationship = tripRelationship(r.varint());
    else return false;
    return true;
  });
  return out;
}

function decodeVehicleDescriptor(buf: Uint8Array): { id?: string; label?: string } {
  const out: { id?: string; label?: string } = {};
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.id = r.string();
    else if (f === 2 && w === WIRE_LEN) out.label = r.string();
    else return false;
    return true;
  });
  return out;
}

function decodeEvent(buf: Uint8Array): StopTimeEvent {
  const out: StopTimeEvent = {};
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_VARINT) out.delay = r.int32();
    else if (f === 2 && w === WIRE_VARINT) out.time = r.varint();
    else return false;
    return true;
  });
  return out;
}

function decodeStopTimeUpdate(buf: Uint8Array): StopTimeUpdate {
  const out: StopTimeUpdate = { relationship: 'SCHEDULED' };
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_VARINT) out.seq = r.varint();
    else if (f === 2 && w === WIRE_LEN) out.arrival = decodeEvent(r.bytes());
    else if (f === 3 && w === WIRE_LEN) out.departure = decodeEvent(r.bytes());
    else if (f === 4 && w === WIRE_LEN) out.stopId = r.string();
    else if (f === 5 && w === WIRE_VARINT) out.relationship = stopRelationship(r.varint());
    else return false;
    return true;
  });
  return out;
}

function decodeTripUpdate(buf: Uint8Array): TripUpdate {
  const out: TripUpdate = { tripId: '', relationship: 'SCHEDULED', stops: [] };
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) {
      const t = decodeTripDescriptor(r.bytes());
      out.tripId = t.tripId ?? '';
      out.relationship = t.relationship;
    } else if (f === 2 && w === WIRE_LEN) out.stops.push(decodeStopTimeUpdate(r.bytes()));
    else if (f === 3 && w === WIRE_LEN) out.vehicleLabel = decodeVehicleDescriptor(r.bytes()).label;
    else if (f === 4 && w === WIRE_VARINT) out.timestamp = r.varint();
    else if (f === 5 && w === WIRE_VARINT) out.delay = r.int32();
    else return false;
    return true;
  });
  return out;
}

function decodePosition(buf: Uint8Array): { latitude?: number; longitude?: number } {
  const out: { latitude?: number; longitude?: number } = {};
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_FIXED32) out.latitude = r.float();
    else if (f === 2 && w === WIRE_FIXED32) out.longitude = r.float();
    else return false;
    return true;
  });
  return out;
}

function vehicleStatus(n: number): VehicleStatus | undefined {
  if (n === 0) return 'INCOMING_AT';
  if (n === 1) return 'STOPPED_AT';
  if (n === 2) return 'IN_TRANSIT_TO';
  return undefined;
}

function decodeVehicle(buf: Uint8Array): VehiclePosition {
  const out: VehiclePosition = {};
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.tripId = decodeTripDescriptor(r.bytes()).tripId;
    else if (f === 2 && w === WIRE_LEN) {
      const p = decodePosition(r.bytes());
      out.latitude = p.latitude;
      out.longitude = p.longitude;
    } else if (f === 3 && w === WIRE_VARINT) out.currentSeq = r.varint();
    else if (f === 4 && w === WIRE_VARINT) out.status = vehicleStatus(r.varint());
    else if (f === 5 && w === WIRE_VARINT) out.timestamp = r.varint();
    else if (f === 7 && w === WIRE_LEN) out.stopId = r.string();
    else if (f === 8 && w === WIRE_LEN) out.label = decodeVehicleDescriptor(r.bytes()).label;
    else return false;
    return true;
  });
  return out;
}

function decodeTimeRange(buf: Uint8Array): { start?: number; end?: number } {
  const out: { start?: number; end?: number } = {};
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_VARINT) out.start = r.varint();
    else if (f === 2 && w === WIRE_VARINT) out.end = r.varint();
    else return false;
    return true;
  });
  return out;
}

function decodeSelector(buf: Uint8Array): InformedEntity {
  const out: InformedEntity = {};
  readMessage(buf, (f, w, r) => {
    if (f === 2 && w === WIRE_LEN) out.routeId = r.string();
    else if (f === 4 && w === WIRE_LEN) out.tripId = decodeTripDescriptor(r.bytes()).tripId;
    else if (f === 5 && w === WIRE_LEN) out.stopId = r.string();
    else return false;
    return true;
  });
  return out;
}

/** `TranslatedString`: el texto en `es` si lo hay, si no el primero. */
function decodeTranslated(buf: Uint8Array): string | undefined {
  const all: Array<{ text: string; language?: string }> = [];
  readMessage(buf, (f, w, r) => {
    if (f !== 1 || w !== WIRE_LEN) return false;
    const t: { text: string; language?: string } = { text: '' };
    readMessage(r.bytes(), (f2, w2, r2) => {
      if (f2 === 1 && w2 === WIRE_LEN) t.text = r2.string();
      else if (f2 === 2 && w2 === WIRE_LEN) t.language = r2.string();
      else return false;
      return true;
    });
    all.push(t);
    return true;
  });
  const es = all.find((t) => t.language?.toLowerCase().startsWith('es'));
  return (es ?? all[0])?.text;
}

function decodeAlert(buf: Uint8Array, id: string): Alert {
  const out: Alert = { id, periods: [], entities: [] };
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.periods.push(decodeTimeRange(r.bytes()));
    else if (f === 5 && w === WIRE_LEN) out.entities.push(decodeSelector(r.bytes()));
    else if (f === 6 && w === WIRE_VARINT) out.cause = r.varint();
    else if (f === 7 && w === WIRE_VARINT) out.effect = r.varint();
    else if (f === 10 && w === WIRE_LEN) out.header = decodeTranslated(r.bytes());
    else if (f === 11 && w === WIRE_LEN) out.description = decodeTranslated(r.bytes());
    else return false;
    return true;
  });
  return out;
}

function decodeEntity(buf: Uint8Array): FeedEntity {
  const out: FeedEntity = { id: '' };
  let alertBuf: Uint8Array | undefined;
  readMessage(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.id = r.string();
    else if (f === 3 && w === WIRE_LEN) out.tripUpdate = decodeTripUpdate(r.bytes());
    else if (f === 4 && w === WIRE_LEN) out.vehicle = decodeVehicle(r.bytes());
    else if (f === 5 && w === WIRE_LEN) alertBuf = r.bytes();
    else return false;
    return true;
  });
  // El id puede venir después del cuerpo: el aviso se decodifica al final.
  if (alertBuf) out.alert = decodeAlert(alertBuf, out.id);
  return out;
}

/** Decodifica un `FeedMessage` completo. Lanza si el protobuf está dañado. */
export function decodeFeed(buf: Uint8Array): Feed {
  const feed: Feed = { entities: [] };
  readMessage(buf, (f, w, r: PbReader) => {
    if (f === 1 && w === WIRE_LEN) {
      readMessage(r.bytes(), (f2, w2, r2) => {
        if (f2 === 3 && w2 === WIRE_VARINT) feed.timestamp = r2.varint();
        else return false;
        return true;
      });
    } else if (f === 2 && w === WIRE_LEN) feed.entities.push(decodeEntity(r.bytes()));
    else return false;
    return true;
  });
  return feed;
}

// --- Fuente con caché --------------------------------------------------------

export const RT_BASE_URL = 'https://gtfsrt.renfe.com';
const TTL_MS = 20_000;
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'stratum-connector-renfe/1.0';

export type RealtimeKind = 'trip_updates' | 'vehicle_positions' | 'alerts';

export interface RealtimeOptions {
  fetch: typeof fetch;
  now?: () => number;
  baseUrl?: string;
  /** Sufijo del nombre del feed (`_LD`: `trip_updates_LD.pb`); por defecto, ninguno. */
  suffix?: string;
}

interface CacheSlot {
  at: number;
  feed: Feed | null;
  inflight?: Promise<Feed | null>;
}

/** Tiempo real con caché en memoria de 20 s por feed. Un fallo se devuelve como `null`. */
export class RealtimeSource {
  private readonly slots = new Map<RealtimeKind, CacheSlot>();
  private readonly now: () => number;

  constructor(private readonly opts: RealtimeOptions) {
    this.now = opts.now ?? Date.now;
  }

  async get(kind: RealtimeKind, signal?: AbortSignal): Promise<Feed | null> {
    const slot = this.slots.get(kind);
    if (slot?.inflight) return slot.inflight;
    if (slot && this.now() - slot.at < TTL_MS) return slot.feed;
    const inflight = this.load(kind, signal).then((feed) => {
      this.slots.set(kind, { at: this.now(), feed });
      return feed;
    });
    this.slots.set(kind, { at: slot?.at ?? 0, feed: slot?.feed ?? null, inflight });
    return inflight;
  }

  private async load(kind: RealtimeKind, signal?: AbortSignal): Promise<Feed | null> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await this.opts.fetch(
        `${this.opts.baseUrl ?? RT_BASE_URL}/${kind}${this.opts.suffix ?? ''}.pb`,
        {
          signal: sig,
          headers: { 'User-Agent': USER_AGENT },
        },
      );
      if (!res.ok) return null;
      return decodeFeed(new Uint8Array(await res.arrayBuffer()));
    } catch {
      return null;
    }
  }
}

/** Vista de un feed para una tool: recuerda el instante más reciente que usó. */
export class RealtimeUse {
  /** Instante (segundos epoch) del dato de tiempo real más reciente consultado con éxito. */
  latest: number | null = null;

  constructor(private readonly source: RealtimeSource | null) {}

  async feed(kind: RealtimeKind, signal?: AbortSignal): Promise<Feed | null> {
    if (!this.source) return null;
    const feed = await this.source.get(kind, signal);
    if (feed) {
      const ts = feed.timestamp ?? null;
      if (ts !== null && (this.latest === null || ts > this.latest)) this.latest = ts;
    }
    return feed;
  }

  async tripUpdates(signal?: AbortSignal): Promise<Map<string, TripUpdate> | null> {
    const feed = await this.feed('trip_updates', signal);
    if (!feed) return null;
    const map = new Map<string, TripUpdate>();
    for (const e of feed.entities)
      if (e.tripUpdate?.tripId) map.set(e.tripUpdate.tripId, e.tripUpdate);
    return map;
  }

  /**
   * Como `tripUpdates`, pero fundiendo las entidades repetidas de un mismo viaje
   * (el feed de larga distancia las repite): ver `mergeTripUpdates`.
   */
  async mergedTripUpdates(signal?: AbortSignal): Promise<Map<string, TripUpdate> | null> {
    const feed = await this.feed('trip_updates', signal);
    if (!feed) return null;
    const groups = new Map<string, TripUpdate[]>();
    for (const e of feed.entities) {
      const u = e.tripUpdate;
      if (!u?.tripId) continue;
      const list = groups.get(u.tripId);
      if (list) list.push(u);
      else groups.set(u.tripId, [u]);
    }
    return new Map([...groups].map(([id, list]) => [id, mergeTripUpdates(list)]));
  }

  async vehicles(signal?: AbortSignal): Promise<Map<string, VehiclePosition> | null> {
    const feed = await this.feed('vehicle_positions', signal);
    if (!feed) return null;
    const map = new Map<string, VehiclePosition>();
    for (const e of feed.entities) if (e.vehicle?.tripId) map.set(e.vehicle.tripId, e.vehicle);
    return map;
  }

  async alerts(signal?: AbortSignal): Promise<Alert[] | null> {
    const feed = await this.feed('alerts', signal);
    if (!feed) return null;
    return feed.entities.flatMap((e) => (e.alert ? [e.alert] : []));
  }
}

/** ¿Trae el `TripUpdate` algún dato de retraso (el del viaje o el de una parada)? */
function hasDelayData(u: TripUpdate): boolean {
  return (
    u.delay !== undefined ||
    u.stops.some(
      (s) =>
        s.relationship !== 'SKIPPED' &&
        (s.arrival?.delay !== undefined ||
          s.arrival?.time !== undefined ||
          s.departure?.delay !== undefined ||
          s.departure?.time !== undefined),
    )
  );
}

/**
 * Funde las actualizaciones repetidas de un mismo viaje en una. Gana la que trae
 * datos de retraso (la de `timestamp` más reciente si hay varias): en el feed de
 * larga distancia un viaje con retraso y posición de vehículo trae además una
 * entidad `CANCELED` residual, y el tren circula. Sin datos de retraso, gana una
 * `CANCELED` (cancelado); si no hay ninguna, la última.
 */
export function mergeTripUpdates(updates: TripUpdate[]): TripUpdate {
  let best: TripUpdate | undefined;
  for (const u of updates) {
    if (u.relationship === 'CANCELED' || !hasDelayData(u)) continue;
    if (!best || (u.timestamp ?? 0) >= (best.timestamp ?? 0)) best = u;
  }
  return best ?? updates.find((u) => u.relationship === 'CANCELED') ?? updates[updates.length - 1]!;
}

// --- Semántica del retraso ---------------------------------------------------

export interface ScheduledStop {
  seq: number;
  stopId: string;
  /** Segundos desde la medianoche del día de servicio. */
  arr: number;
  dep: number;
}

export interface Estimate {
  /**
   * `none`: sin datos de tiempo real para esta parada; `ok`: hay retraso;
   * `cancelled`: el viaje está cancelado; `skipped`: el tren no para aquí.
   */
  status: 'none' | 'ok' | 'cancelled' | 'skipped';
  /** Retraso de llegada y de salida en segundos (`null` si no se sabe: nunca 0 por defecto). */
  arrDelay: number | null;
  depDelay: number | null;
  /** `informed`: lo informa el feed para esta parada; `propagated`: se arrastra de una anterior o del viaje. */
  kind: 'informed' | 'propagated' | null;
}

const NONE: Estimate = { status: 'none', arrDelay: null, depDelay: null, kind: null };

function eventDelay(ev: StopTimeEvent | undefined, scheduledEpoch: number): number | null {
  if (!ev) return null;
  if (ev.delay !== undefined) return ev.delay;
  if (ev.time !== undefined) return ev.time - scheduledEpoch;
  return null;
}

/**
 * Aplica un `TripUpdate` a las paradas de un viaje. Lo normal es UNA
 * actualización (la próxima parada) más el `delay` del viaje: el retraso de una
 * `stop_time_update` vale para esa parada y las siguientes hasta la próxima
 * actualización; sin actualización aplicable se usa el `delay` del viaje.
 * `dayEpoch` es la medianoche (segundos epoch) del día de servicio.
 */
export function estimateStops(
  stops: ScheduledStop[],
  upd: TripUpdate | undefined,
  dayEpoch: number,
  opts: { ignoreSkipped?: boolean } = {},
): Estimate[] {
  if (!upd) return stops.map(() => NONE);
  if (upd.relationship === 'CANCELED') {
    return stops.map(() => ({ status: 'cancelled', arrDelay: null, depDelay: null, kind: null }));
  }
  // Cada actualización se resuelve al índice de parada al que se refiere.
  const resolved: Array<{ idx: number; stu: StopTimeUpdate }> = [];
  let from = 0;
  // En larga distancia el feed marca `SKIPPED` paradas que a la vez informa con
  // retraso: no es fiable, y con `ignoreSkipped` esas actualizaciones no cuentan.
  const updates = opts.ignoreSkipped
    ? upd.stops.filter((s) => s.relationship !== 'SKIPPED')
    : upd.stops;
  for (const stu of updates) {
    let idx = -1;
    if (stu.seq !== undefined) idx = stops.findIndex((s) => s.seq === stu.seq);
    if (idx < 0 && stu.stopId !== undefined) {
      idx = stops.findIndex((s, i) => i >= from && s.stopId === stu.stopId);
      if (idx < 0) idx = stops.findIndex((s) => s.stopId === stu.stopId);
    }
    if (idx < 0) continue;
    resolved.push({ idx, stu });
    from = idx;
  }
  resolved.sort((a, b) => a.idx - b.idx);

  return stops.map((s, i): Estimate => {
    const own = resolved.find((r) => r.idx === i && r.stu.relationship !== 'NO_DATA');
    if (own?.stu.relationship === 'SKIPPED') {
      return { status: 'skipped', arrDelay: null, depDelay: null, kind: null };
    }
    if (own) {
      const arrDelay = eventDelay(own.stu.arrival ?? own.stu.departure, dayEpoch + s.arr);
      const depDelay = eventDelay(own.stu.departure ?? own.stu.arrival, dayEpoch + s.dep);
      if (arrDelay !== null || depDelay !== null) {
        return {
          status: 'ok',
          arrDelay: arrDelay ?? depDelay,
          depDelay: depDelay ?? arrDelay,
          kind: 'informed',
        };
      }
    }
    // Retraso arrastrado de la última actualización anterior con dato.
    for (let k = resolved.length - 1; k >= 0; k--) {
      const r = resolved[k]!;
      if (r.idx >= i || r.stu.relationship === 'SKIPPED' || r.stu.relationship === 'NO_DATA')
        continue;
      const prev = stops[r.idx]!;
      const d = eventDelay(r.stu.departure ?? r.stu.arrival, dayEpoch + prev.dep);
      if (d !== null) return propagated(d);
    }
    if (upd.delay !== undefined) return propagated(upd.delay);
    return NONE;
  });
}

/**
 * Un retraso arrastrado a paradas siguientes. Un adelanto no se arrastra: el
 * tren espera en cada parada a su hora, así que a partir de la siguiente se
 * estima puntual (lo informado para la propia parada sí puede ser negativo).
 */
function propagated(delay: number): Estimate {
  const d = Math.max(0, delay);
  return { status: 'ok', arrDelay: d, depDelay: d, kind: 'propagated' };
}

/** Vía del label del vehículo: `C1-23537-PLATF.(3)` → `3`. */
export function platformOfLabel(label: string | undefined): string | null {
  if (!label) return null;
  const m = /PLATF\.?\s*\(\s*([^)\s]+)\s*\)/i.exec(label);
  return m ? m[1]! : null;
}

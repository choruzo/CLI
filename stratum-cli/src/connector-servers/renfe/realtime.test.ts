import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PbReader } from './protobuf.js';
import {
  RealtimeSource,
  RealtimeUse,
  decodeFeed,
  estimateStops,
  platformOfLabel,
  type ScheduledStop,
  type TripUpdate,
} from './realtime.js';
import {
  FIXTURES,
  alertEntity,
  encodeFeed,
  fakeFeedFetch,
  tripUpdateEntity,
  vehicleEntity,
} from './test-helpers.js';

const rt = (name: string) => join(FIXTURES, 'realtime', name);
const pb = (n: string) => new Uint8Array(readFileSync(rt(`${n}.pb`)));
/** Forma del JSON de Renfe (solo lo que comprueban los tests). */
interface JsonEntity {
  id: string;
  tripUpdate?: {
    trip: { tripId: string; scheduleRelationship: string };
    delay?: number;
    stopTimeUpdate?: Array<{ stopId: string; arrival?: { delay?: number; time: string } }>;
  };
  vehicle?: {
    trip: { tripId: string };
    stopId: string;
    currentStatus: string;
    timestamp: string;
    position: { latitude: number; longitude: number };
    vehicle: { label: string };
  };
  alert?: {
    activePeriod: Array<{ start: string }>;
    informedEntity?: Array<{ routeId?: string; stopId?: string }>;
  };
}
interface JsonFeed {
  header: { timestamp: string };
  entity: JsonEntity[];
}
const json = (n: string) => JSON.parse(readFileSync(rt(`${n}.json`), 'utf8')) as JsonFeed;

describe('protobuf: lector', () => {
  it('varint de 1 byte, multibyte y negativo extendido a 64 bits', () => {
    const r = new PbReader(
      Buffer.from([0x05, 0xac, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    );
    expect(r.varint()).toBe(5);
    expect(r.varint()).toBe(300);
    expect(r.int32()).toBe(-1);
  });

  it('un protobuf truncado lanza', () => {
    expect(() => decodeFeed(Buffer.from([0x12, 0x10, 0x01]))).toThrow(/truncado/);
  });
});

describe('decodeFeed contra los .pb reales (con su .json descargado a la vez)', () => {
  it('trip_updates: mismas entidades, ids y campos que el JSON', () => {
    const feed = decodeFeed(pb('trip_updates'));
    const j = json('trip_updates');
    expect(feed.timestamp).toBe(Number(j.header.timestamp));
    expect(feed.entities).toHaveLength(j.entity.length);
    expect(feed.entities.map((e) => e.id)).toEqual(j.entity.map((e) => e.id));
    for (let i = 0; i < j.entity.length; i++) {
      const tu = feed.entities[i]!.tripUpdate!;
      const jt = j.entity[i]!.tripUpdate!;
      expect(tu.tripId).toBe(jt.trip.tripId);
      expect(tu.relationship).toBe(jt.trip.scheduleRelationship);
      expect(tu.delay).toBe(jt.delay);
      expect(tu.stops).toHaveLength((jt.stopTimeUpdate ?? []).length);
      (jt.stopTimeUpdate ?? []).forEach((s, k: number) => {
        expect(tu.stops[k]!.stopId).toBe(s.stopId);
        expect(tu.stops[k]!.arrival?.delay).toBe(s.arrival?.delay);
        expect(tu.stops[k]!.arrival?.time).toBe(s.arrival ? Number(s.arrival.time) : undefined);
      });
    }
  });

  it('vehicle_positions: posición, estado y label como el JSON', () => {
    const feed = decodeFeed(pb('vehicle_positions'));
    const j = json('vehicle_positions');
    expect(feed.entities).toHaveLength(j.entity.length);
    expect(feed.entities.map((e) => e.id)).toEqual(j.entity.map((e) => e.id));
    for (let i = 0; i < j.entity.length; i++) {
      const v = feed.entities[i]!.vehicle!;
      const jv = j.entity[i]!.vehicle!;
      expect(v.tripId).toBe(jv.trip.tripId);
      expect(v.stopId).toBe(jv.stopId);
      expect(v.status).toBe(jv.currentStatus);
      expect(v.label).toBe(jv.vehicle.label);
      expect(v.latitude).toBeCloseTo(jv.position.latitude, 4);
      expect(v.longitude).toBeCloseTo(jv.position.longitude, 4);
      expect(v.timestamp).toBe(Number(jv.timestamp));
    }
  });

  it('alerts: mismas entidades y periodos; los acentos salen bien del .pb', () => {
    const feed = decodeFeed(pb('alerts'));
    const j = json('alerts');
    expect(feed.entities).toHaveLength(j.entity.length);
    expect(feed.entities.map((e) => e.id)).toEqual(j.entity.map((e) => e.id));
    for (let i = 0; i < j.entity.length; i++) {
      const a = feed.entities[i]!.alert!;
      const ja = j.entity[i]!.alert!;
      expect(a.periods[0]?.start).toBe(Number(ja.activePeriod[0]!.start));
      expect(a.entities.filter((e) => e.routeId).map((e) => e.routeId)).toEqual(
        (ja.informedEntity ?? []).filter((e) => e.routeId).map((e) => e.routeId),
      );
      expect(a.entities.filter((e) => e.stopId).map((e) => e.stopId)).toEqual(
        (ja.informedEntity ?? []).filter((e) => e.stopId).map((e) => e.stopId),
      );
      const text = a.description ?? a.header ?? '';
      expect(text.length).toBeGreaterThan(0);
    }
    const all = feed.entities.map((e) => e.alert?.description ?? '').join(' ');
    expect(all).toMatch(/[áéíóúñ]/);
    expect(all).not.toContain('�');
  });
});

describe('decodeFeed: campos sintéticos', () => {
  it('TranslatedString: elige es si hay, si no la primera', () => {
    const feed = decodeFeed(
      encodeFeed(100, [
        alertEntity({
          id: 'A1',
          routeIds: ['10T0001C1'],
          translations: [
            { text: 'Hello', language: 'en' },
            { text: 'Hola', language: 'es' },
          ],
        }),
        alertEntity({ id: 'A2', translations: [{ text: 'Bonjour', language: 'fr' }] }),
      ]),
    );
    expect(feed.entities[0]!.alert!.description).toBe('Hola');
    expect(feed.entities[1]!.alert!.description).toBe('Bonjour');
  });

  it('retraso negativo, cancelado, saltado, vehículo y selectores de aviso', () => {
    const feed = decodeFeed(
      encodeFeed(100, [
        tripUpdateEntity({
          tripId: 'T1',
          delay: -120,
          stops: [{ stopId: 'X', arrival: { delay: -120, time: 5 } }],
        }),
        tripUpdateEntity({ tripId: 'T2', relationship: 3 }),
        tripUpdateEntity({ tripId: 'T3', stops: [{ seq: 4, stopId: 'Y', relationship: 1 }] }),
        vehicleEntity({
          tripId: 'T1',
          label: 'C1-1-PLATF.(3)',
          status: 1,
          lat: 40.5,
          lon: -3.25,
          seq: 2,
          stopId: 'X',
        }),
        alertEntity({ id: 'A', stopIds: ['S1'], tripIds: ['T9'], start: 10, end: 20 }),
      ]),
    );
    expect(feed.entities[0]!.tripUpdate!.delay).toBe(-120);
    expect(feed.entities[0]!.tripUpdate!.stops[0]!.arrival?.delay).toBe(-120);
    expect(feed.entities[1]!.tripUpdate!.relationship).toBe('CANCELED');
    expect(feed.entities[2]!.tripUpdate!.stops[0]).toMatchObject({
      seq: 4,
      relationship: 'SKIPPED',
    });
    expect(feed.entities[3]!.vehicle).toMatchObject({
      status: 'STOPPED_AT',
      latitude: 40.5,
      longitude: -3.25,
      currentSeq: 2,
    });
    expect(feed.entities[4]!.alert).toMatchObject({
      periods: [{ start: 10, end: 20 }],
      entities: [{ stopId: 'S1' }, { tripId: 'T9' }],
    });
  });
});

describe('platformOfLabel', () => {
  it('la vía sale del label del vehículo', () => {
    expect(platformOfLabel('C1-23537-PLATF.(3)')).toBe('3');
    expect(platformOfLabel('C5-35729-PLATF.(10)')).toBe('10');
    expect(platformOfLabel('C5-35729')).toBeNull();
    expect(platformOfLabel(undefined)).toBeNull();
  });
});

// Paradas de un viaje a las 18:00, 18:10, 18:20, 18:30 (día de servicio con medianoche en DAY).
const DAY = 1_000_000;
const STOPS: ScheduledStop[] = [
  { seq: 1, stopId: 'A', arr: 18 * 3600, dep: 18 * 3600 },
  { seq: 2, stopId: 'B', arr: 18 * 3600 + 600, dep: 18 * 3600 + 600 },
  { seq: 3, stopId: 'C', arr: 18 * 3600 + 1200, dep: 18 * 3600 + 1200 },
  { seq: 4, stopId: 'D', arr: 18 * 3600 + 1800, dep: 18 * 3600 + 1800 },
];

function upd(over: Partial<TripUpdate>): TripUpdate {
  return { tripId: 'T', relationship: 'SCHEDULED', stops: [], ...over };
}

describe('estimateStops: semántica del retraso', () => {
  it('sin actualización del viaje: sin datos (nunca 0)', () => {
    const est = estimateStops(STOPS, undefined, DAY);
    expect(est.every((e) => e.status === 'none' && e.arrDelay === null && e.kind === null)).toBe(
      true,
    );
  });

  it('una actualización: informado en su parada y arrastrado a las siguientes', () => {
    const est = estimateStops(
      STOPS,
      upd({
        delay: 240,
        stops: [{ stopId: 'B', arrival: { delay: 240 }, relationship: 'SCHEDULED' }],
      }),
      DAY,
    );
    expect(est[1]).toMatchObject({ status: 'ok', arrDelay: 240, depDelay: 240, kind: 'informed' });
    expect(est[2]).toMatchObject({ status: 'ok', arrDelay: 240, kind: 'propagated' });
    expect(est[3]).toMatchObject({ kind: 'propagated', arrDelay: 240 });
    // Antes de la primera actualización se usa el delay del viaje.
    expect(est[0]).toMatchObject({ arrDelay: 240, kind: 'propagated' });
  });

  it('sin stop_time_update aplicable se usa el delay del viaje; sin nada, sin datos', () => {
    expect(estimateStops(STOPS, upd({ delay: 0 }), DAY)[2]).toMatchObject({
      status: 'ok',
      arrDelay: 0,
      kind: 'propagated',
    });
    expect(estimateStops(STOPS, upd({}), DAY)[2]).toMatchObject({ status: 'none', arrDelay: null });
  });

  it('un adelanto se informa en su parada pero no se arrastra: después, puntual', () => {
    const est = estimateStops(
      STOPS,
      upd({
        delay: -480,
        stops: [{ stopId: 'B', arrival: { delay: -480 }, relationship: 'SCHEDULED' }],
      }),
      DAY,
    );
    expect(est[1]).toMatchObject({ arrDelay: -480, kind: 'informed' });
    expect(est[2]).toMatchObject({ arrDelay: 0, depDelay: 0, kind: 'propagated' });
    expect(est[0]).toMatchObject({ arrDelay: 0, kind: 'propagated' });
  });

  it('el retraso de una actualización posterior sustituye al arrastrado', () => {
    const est = estimateStops(
      STOPS,
      upd({
        stops: [
          { stopId: 'B', arrival: { delay: 60 }, relationship: 'SCHEDULED' },
          { seq: 4, arrival: { delay: 300 }, relationship: 'SCHEDULED' },
        ],
      }),
      DAY,
    );
    expect(est[2]).toMatchObject({ arrDelay: 60, kind: 'propagated' });
    expect(est[3]).toMatchObject({ arrDelay: 300, kind: 'informed' });
  });

  it('si solo hay hora absoluta, el retraso es la diferencia con el horario', () => {
    const est = estimateStops(
      STOPS,
      upd({
        stops: [
          {
            stopId: 'C',
            arrival: { time: DAY + 18 * 3600 + 1200 + 180 },
            relationship: 'SCHEDULED',
          },
        ],
      }),
      DAY,
    );
    expect(est[2]).toMatchObject({ arrDelay: 180, kind: 'informed' });
  });

  it('cancelado: todas las paradas', () => {
    const est = estimateStops(STOPS, upd({ relationship: 'CANCELED' }), DAY);
    expect(est.every((e) => e.status === 'cancelled')).toBe(true);
  });

  it('parada saltada: solo esa, y no sirve para arrastrar retraso', () => {
    const est = estimateStops(
      STOPS,
      upd({
        delay: 60,
        stops: [
          { stopId: 'B', arrival: { delay: 120 }, relationship: 'SCHEDULED' },
          { stopId: 'C', relationship: 'SKIPPED' },
        ],
      }),
      DAY,
    );
    expect(est[2]!.status).toBe('skipped');
    expect(est[1]).toMatchObject({ arrDelay: 120, kind: 'informed' });
    expect(est[3]).toMatchObject({ status: 'ok', arrDelay: 120, kind: 'propagated' });
  });

  it('una actualización con un stop_id que el viaje no tiene se ignora', () => {
    const est = estimateStops(
      STOPS,
      upd({
        delay: 30,
        stops: [{ stopId: 'ZZ', arrival: { delay: 999 }, relationship: 'SCHEDULED' }],
      }),
      DAY,
    );
    expect(est[0]).toMatchObject({ arrDelay: 30, kind: 'propagated' });
  });
});

describe('RealtimeSource', () => {
  const feed = encodeFeed(1_794_424_000, [tripUpdateEntity({ tripId: 'T1', delay: 60 })]);

  it('cachea 20 s por feed y vuelve a pedir pasado el plazo', async () => {
    let calls = 0;
    let t = 0;
    const inner = fakeFeedFetch({ trip_updates: feed });
    const src = new RealtimeSource({
      fetch: ((u: string) => {
        calls++;
        return inner(u);
      }) as typeof fetch,
      now: () => t,
    });
    expect((await src.get('trip_updates'))?.entities).toHaveLength(1);
    t = 19_000;
    await src.get('trip_updates');
    expect(calls).toBe(1);
    t = 21_000;
    await src.get('trip_updates');
    expect(calls).toBe(2);
  });

  it('un fallo (HTTP o red) es null, no una excepción', async () => {
    const http = new RealtimeSource({ fetch: fakeFeedFetch({}) });
    expect(await http.get('alerts')).toBeNull();
    const net = new RealtimeSource({
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch,
    });
    expect(await net.get('alerts')).toBeNull();
    // Un cuerpo que no es protobuf válido también.
    const bad = new RealtimeSource({
      fetch: fakeFeedFetch({ alerts: Buffer.from([0x0a, 0x7f, 0x01]) }),
    });
    expect(await bad.get('alerts')).toBeNull();
  });

  it('RealtimeUse recuerda el instante más reciente que consultó', async () => {
    const src = new RealtimeSource({ fetch: fakeFeedFetch({ trip_updates: feed }) });
    const use = new RealtimeUse(src);
    expect(use.latest).toBeNull();
    const map = await use.tripUpdates();
    expect(map?.get('T1')?.delay).toBe(60);
    expect(use.latest).toBe(1_794_424_000);
    expect(await new RealtimeUse(null).alerts()).toBeNull();
  });
});

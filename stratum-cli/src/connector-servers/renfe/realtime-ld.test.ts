/**
 * Tiempo real de larga distancia: `.pb` reales recortados (`fixtures/ld/realtime/`),
 * fusión de entidades repetidas, `SKIPPED` ignorado y la fuente aparte (sufijo
 * `_LD`, su propia caché).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RealtimeSource,
  RealtimeUse,
  decodeFeed,
  estimateStops,
  mergeTripUpdates,
  type ScheduledStop,
  type TripUpdate,
} from './realtime.js';
import { FIXTURES_LD, fakeFeedFetch, ldFakeRealtime, ldRealtimeFeeds } from './test-helpers.js';

const real = (n: string) =>
  decodeFeed(new Uint8Array(readFileSync(join(FIXTURES_LD, 'realtime', `${n}_LD.pb`))));

const upd = (o: Partial<TripUpdate> & { tripId: string }): TripUpdate => ({
  relationship: 'SCHEDULED',
  stops: [],
  ...o,
});

describe('feeds reales de larga distancia', () => {
  it('se decodifican con el decodificador de Cercanías (mismo protobuf)', () => {
    const tu = real('trip_updates');
    const vp = real('vehicle_positions');
    expect(tu.entities).toHaveLength(24);
    expect(vp.entities).toHaveLength(6);
    expect(tu.timestamp).toBe(1794425443);
    // Un viaje cancelado y uno con retraso y vehículo.
    const canceled = tu.entities.find((e) => e.id === 'TUCANCEL_0019012026-11-11');
    expect(canceled?.tripUpdate?.relationship).toBe('CANCELED');
    expect(vp.entities[0]!.vehicle).toMatchObject({
      tripId: '0019412026-11-11',
      status: 'STOPPED_AT',
      stopId: '35206',
    });
  });
});

describe('mergeTripUpdates', () => {
  it('gana la que trae retraso aunque haya otra CANCELED del mismo viaje', () => {
    const cancel = upd({ tripId: 'T', relationship: 'CANCELED' });
    const delayed = upd({ tripId: 'T', delay: 780 });
    expect(mergeTripUpdates([cancel, delayed])).toBe(delayed);
    expect(mergeTripUpdates([delayed, cancel])).toBe(delayed);
  });

  it('entre varias con retraso, la de timestamp más reciente', () => {
    const old = upd({ tripId: 'T', delay: 60, timestamp: 100 });
    const recent = upd({ tripId: 'T', delay: 120, timestamp: 200 });
    expect(mergeTripUpdates([recent, old])).toBe(recent);
    expect(mergeTripUpdates([old, recent])).toBe(recent);
  });

  it('un retraso solo en una parada también cuenta como dato', () => {
    const cancel = upd({ tripId: 'T', relationship: 'CANCELED' });
    const withStop = upd({
      tripId: 'T',
      stops: [{ relationship: 'SCHEDULED', arrival: { delay: 30 } }],
    });
    expect(mergeTripUpdates([cancel, withStop])).toBe(withStop);
  });

  it('sin datos de retraso, CANCELED gana; si no hay ninguna, la última', () => {
    const cancel = upd({ tripId: 'T', relationship: 'CANCELED' });
    const empty = upd({ tripId: 'T' });
    expect(mergeTripUpdates([empty, cancel])).toBe(cancel);
    expect(mergeTripUpdates([cancel, cancel]).relationship).toBe('CANCELED');
    expect(mergeTripUpdates([empty, upd({ tripId: 'T', timestamp: 5 })]).timestamp).toBe(5);
  });
});

describe('RealtimeUse.mergedTripUpdates sobre el feed real', () => {
  it('une las entidades repetidas por trip_id (una entrada por viaje)', async () => {
    const use = new RealtimeUse(ldFakeRealtime());
    const map = await use.mergedTripUpdates();
    const ids = new Set(real('trip_updates').entities.map((e) => e.tripUpdate!.tripId));
    expect(map!.size).toBe(ids.size);
    expect(ids.size).toBeLessThan(real('trip_updates').entities.length);
  });

  it('retraso + CANCELED residual → circula con retraso; solo CANCELED → cancelado', async () => {
    const map = (await new RealtimeUse(ldFakeRealtime()).mergedTripUpdates())!;
    // 00194: dos entidades (retraso de 13 min y CANCELED) y un vehículo en circulación.
    expect(map.get('0019412026-11-11')).toMatchObject({ relationship: 'SCHEDULED', delay: 780 });
    // 00190: solo CANCELED.
    expect(map.get('0019012026-11-11')?.relationship).toBe('CANCELED');
    // 00530: adelanto de 6 min, sin cancelación.
    expect(map.get('0053012026-11-11')).toMatchObject({ relationship: 'SCHEDULED', delay: -360 });
  });

  it('sin feed (404) devuelve null', async () => {
    const use = new RealtimeUse(ldFakeRealtime({}));
    expect(await use.mergedTripUpdates()).toBeNull();
    expect(use.latest).toBeNull();
  });
});

describe('estimateStops en larga distancia', () => {
  const stops: ScheduledStop[] = [
    { seq: 1, stopId: 'A', arr: 1000, dep: 1000 },
    { seq: 2, stopId: 'B', arr: 2000, dep: 2060 },
    { seq: 3, stopId: 'C', arr: 3000, dep: 3060 },
    { seq: 4, stopId: 'D', arr: 4000, dep: 4000 },
  ];
  // Como en el feed real: C con retraso informado y, a la vez, todas «SKIPPED».
  const contradictory = upd({
    tripId: 'T',
    delay: 780,
    stops: [
      { stopId: 'C', relationship: 'SCHEDULED', arrival: { delay: 780 } },
      { stopId: 'A', relationship: 'SKIPPED' },
      { stopId: 'B', relationship: 'SKIPPED' },
      { stopId: 'C', relationship: 'SKIPPED' },
      { stopId: 'D', relationship: 'SKIPPED' },
    ],
  });

  it('con ignoreSkipped no hay paradas saltadas y el retraso se arrastra a las siguientes', () => {
    const est = estimateStops(stops, contradictory, 0, { ignoreSkipped: true });
    expect(est.map((e) => e.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(est[2]).toMatchObject({ kind: 'informed', arrDelay: 780 });
    expect(est[3]).toMatchObject({ kind: 'propagated', arrDelay: 780, depDelay: 780 });
  });

  it('sin ignoreSkipped (Cercanías) el SKIPPED sigue contando', () => {
    const est = estimateStops(stops, contradictory, 0);
    expect(est[3]!.status).toBe('skipped');
  });

  it('un adelanto no se arrastra: la parada siguiente sale puntual', () => {
    const early = upd({
      tripId: 'T',
      delay: -360,
      stops: [{ stopId: 'B', relationship: 'SCHEDULED', arrival: { delay: -360 } }],
    });
    const est = estimateStops(stops, early, 0, { ignoreSkipped: true });
    expect(est[1]).toMatchObject({ kind: 'informed', arrDelay: -360 });
    expect(est[2]).toMatchObject({ kind: 'propagated', arrDelay: 0 });
  });

  it('un viaje CANCELED marca todas las paradas como canceladas', () => {
    const est = estimateStops(stops, upd({ tripId: 'T', relationship: 'CANCELED' }), 0, {
      ignoreSkipped: true,
    });
    expect(est.every((e) => e.status === 'cancelled')).toBe(true);
  });
});

describe('RealtimeSource de larga distancia', () => {
  it('pide los feeds con el sufijo _LD y no los de Cercanías', async () => {
    const urls: string[] = [];
    const feeds = ldRealtimeFeeds();
    const inner = fakeFeedFetch(feeds);
    const src = new RealtimeSource({
      suffix: '_LD',
      fetch: ((u: string | URL | Request, init?: RequestInit) => {
        urls.push(String(u));
        return inner(u, init);
      }) as typeof fetch,
    });
    expect(await src.get('trip_updates')).not.toBeNull();
    expect(await src.get('vehicle_positions')).not.toBeNull();
    expect(urls).toEqual([
      'https://gtfsrt.renfe.com/trip_updates_LD.pb',
      'https://gtfsrt.renfe.com/vehicle_positions_LD.pb',
    ]);
  });

  it('caché de 20 s propia: dos fuentes no se comparten y un fallo es null', async () => {
    let now = 1_000_000;
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(new Uint8Array(ldRealtimeFeeds().trip_updates!), { status: 200 });
    }) as typeof fetch;
    const a = new RealtimeSource({ fetch: counting, suffix: '_LD', now: () => now });
    const b = new RealtimeSource({ fetch: counting, suffix: '_LD', now: () => now });
    await a.get('trip_updates');
    await a.get('trip_updates');
    expect(calls).toBe(1);
    await b.get('trip_updates');
    expect(calls).toBe(2);
    now += 21_000;
    await a.get('trip_updates');
    expect(calls).toBe(3);

    const failing = new RealtimeSource({
      fetch: (async () => {
        throw new Error('timeout');
      }) as typeof fetch,
      suffix: '_LD',
    });
    expect(await failing.get('trip_updates')).toBeNull();
  });
});

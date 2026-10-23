import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NotificationName, NotificationParams } from '../protocol/index.js';
import { ProtocolError } from '../ipc/codec.js';
import { TRACE_FORMAT_VERSION } from '../trace/records.js';
import { TraceFeeds, type TraceClient } from './trace-feeds.js';

type Sent = {
  [N in NotificationName]: { name: N; params: NotificationParams<N> };
}[NotificationName];

type TraceRecords = NotificationParams<'trace.records'>;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sondea `cond` hasta que se cumple o se agota `ms`. */
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 >= ms) throw new Error('until: condición no cumplida a tiempo');
    await delay(5);
  }
}

const total = (sends: TraceRecords[]): number => sends.reduce((n, s) => n + s.records.length, 0);

function fakeClient(id: number) {
  const sent: Sent[] = [];
  const state = { ready: true };
  const client: TraceClient = {
    id,
    ready: () => state.ready,
    notify: (name, params) => {
      sent.push({ name, params } as Sent);
    },
  };
  const records = (): TraceRecords[] =>
    sent.flatMap((s) => (s.name === 'trace.records' ? [s.params] : []));
  return { client, records, state };
}

const line = (i: number): string => JSON.stringify({ i });

const appendLines = (file: string, from: number, to: number): void => {
  const lines: string[] = [];
  for (let i = from; i <= to; i++) lines.push(line(i));
  appendFileSync(file, `${lines.join('\n')}\n`);
};

describe('TraceFeeds', () => {
  let dir: string;
  let feeds: TraceFeeds;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-feeds-'));
    feeds = new TraceFeeds({ pollMs: 20 });
  });

  afterEach(() => {
    feeds.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fichero inexistente: nada síncrono, un reset vacío y luego las líneas nuevas con reset false', async () => {
    const file = join(dir, 's1.jsonl');
    const { client, records } = fakeClient(1);
    const { subscriptionId } = feeds.subscribe(client, 'sess-1', file);
    expect(records()).toEqual([]);
    await until(() => records().length >= 1);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      subscriptionId,
      sessionId: 'sess-1',
      reset: true,
      format: TRACE_FORMAT_VERSION,
      records: [],
    });
    appendLines(file, 1, 2);
    await until(() => total(records()) >= 2);
    expect(records()).toHaveLength(2);
    expect(records()[1].reset).toBe(false);
    expect(records()[1].records).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it('líneas previas: el primer envío las lleva todas con reset true; la nueva llega sola con reset false', async () => {
    const file = join(dir, 's2.jsonl');
    appendLines(file, 1, 3);
    const { client, records } = fakeClient(1);
    feeds.subscribe(client, 'sess-2', file);
    await until(() => records().length >= 1);
    expect(records()).toHaveLength(1);
    expect(records()[0].reset).toBe(true);
    expect(records()[0].records).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    appendLines(file, 4, 4);
    await until(() => total(records()) >= 4);
    expect(records()).toHaveLength(2);
    expect(records()[1].reset).toBe(false);
    expect(records()[1].records).toEqual([{ i: 4 }]);
  });

  it('las líneas que no son objetos JSON se saltan; las válidas pasan', async () => {
    const file = join(dir, 's3.jsonl');
    const { client, records } = fakeClient(1);
    feeds.subscribe(client, 'sess-3', file);
    await until(() => records().length >= 1);
    appendFileSync(file, `no soy json\n[1, 2]\n${line(7)}\n${line(8)}\n`);
    await until(() => total(records()) >= 2);
    expect(records()[1].reset).toBe(false);
    expect(records()[1].records).toEqual([{ i: 7 }, { i: 8 }]);
  });

  it('truncado: llega reset true otra vez, con el contenido nuevo', async () => {
    const file = join(dir, 's4.jsonl');
    appendLines(file, 1, 2);
    const { client, records } = fakeClient(1);
    feeds.subscribe(client, 'sess-4', file);
    await until(() => total(records()) >= 2);
    writeFileSync(file, `${line(9)}\n`);
    await until(() => total(records()) >= 3);
    const last = records()[records().length - 1];
    expect(last.reset).toBe(true);
    expect(last.records).toEqual([{ i: 9 }]);
  });

  it('contrapresión: con ready false no envía; al reanudar y hacer pump llegan todas, en orden', async () => {
    const file = join(dir, 's5.jsonl');
    const { client, records, state } = fakeClient(1);
    state.ready = false;
    feeds.subscribe(client, 'sess-5', file);
    appendLines(file, 1, 3);
    await delay(80);
    expect(records()).toEqual([]);
    state.ready = true;
    feeds.pump(client);
    await until(() => total(records()) >= 3);
    expect(records()).toHaveLength(1);
    expect(records()[0].reset).toBe(true);
    expect(records()[0].records).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('máximo 8 suscripciones por cliente: la novena es UNAVAILABLE; otro cliente sí puede', () => {
    const first = fakeClient(1);
    for (let k = 0; k < 8; k++) {
      feeds.subscribe(first.client, `sess-${k}`, join(dir, `a${k}.jsonl`));
    }
    expect(feeds.subscriptions(first.client)).toBe(8);
    let ninth: unknown;
    try {
      feeds.subscribe(first.client, 'sess-9', join(dir, 'a9.jsonl'));
    } catch (e) {
      ninth = e;
    }
    expect(ninth).toBeInstanceOf(ProtocolError);
    expect((ninth as ProtocolError).code).toBe('UNAVAILABLE');
    expect(feeds.subscriptions(first.client)).toBe(8);
    const second = fakeClient(2);
    expect(() => feeds.subscribe(second.client, 'sess-9', join(dir, 'a9.jsonl'))).not.toThrow();
    expect(feeds.subscriptions(second.client)).toBe(1);
  });

  it('unsubscribe y dropClient cortan los envíos; repetir unsubscribe no lanza', async () => {
    const fileA = join(dir, 's7a.jsonl');
    const a = fakeClient(1);
    const { subscriptionId } = feeds.subscribe(a.client, 'sess-7a', fileA);
    await until(() => a.records().length >= 1);
    feeds.unsubscribe(a.client, subscriptionId);
    expect(() => feeds.unsubscribe(a.client, subscriptionId)).not.toThrow();
    expect(feeds.subscriptions(a.client)).toBe(0);
    appendLines(fileA, 1, 2);
    await delay(80);
    expect(a.records()).toHaveLength(1);

    const fileB = join(dir, 's7b.jsonl');
    const b = fakeClient(2);
    feeds.subscribe(b.client, 'sess-7b', fileB);
    await until(() => b.records().length >= 1);
    feeds.dropClient(b.client);
    expect(feeds.subscriptions(b.client)).toBe(0);
    appendLines(fileB, 1, 2);
    await delay(80);
    expect(b.records()).toHaveLength(1);
  });

  it('con la traza ya escrita, el reset nunca sale vacío aunque coincidan el temporizador y pump', async () => {
    const file = join(dir, 's9.jsonl');
    appendLines(file, 1, 2_000);
    const { client, records } = fakeClient(1);
    feeds.subscribe(client, 'sess-9', file);
    // Muchos `pump` mientras el primer sondeo lee: ninguno debe adelantar un reset vacío.
    for (let k = 0; k < 20; k++) {
      await delay(2);
      feeds.pump(client);
    }
    await until(() => total(records()) >= 2_000);
    expect(records()[0]!.reset).toBe(true);
    expect(records()[0]!.records.length).toBeGreaterThan(0);
    expect(records().filter((r) => r.reset)).toHaveLength(1);
    expect(records().flatMap((r) => r.records)).toHaveLength(2_000);
  });

  it('450 líneas: varios envíos, ninguno con más de 200 registros y todos juntos en orden', async () => {
    const file = join(dir, 's8.jsonl');
    const { client, records } = fakeClient(1);
    feeds.subscribe(client, 'sess-8', file);
    await until(() => records().length >= 1);
    appendLines(file, 1, 450);
    await until(() => total(records()) >= 450);
    const batches = records();
    expect(batches.length).toBeGreaterThanOrEqual(4); // el reset vacío + al menos 3 lotes
    for (const b of batches) expect(b.records.length).toBeLessThanOrEqual(200);
    expect(total(records())).toBe(450);
    const expected = Array.from({ length: 450 }, (_, k) => ({ i: k + 1 }));
    expect(batches.flatMap((b) => b.records)).toEqual(expected);
  });
});

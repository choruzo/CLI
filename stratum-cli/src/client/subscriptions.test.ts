import { describe, it, expect, afterEach, vi } from 'vitest';
import { StratumClient } from './client.js';
import { staticDiscovery } from './discovery.js';
import { startFakeServer, type FakeServer } from './testing/fake-server.js';
import type {
  ProtocolEvent,
  ProtocolSessionSnapshot,
  ProtocolStateEvent,
  SubscriptionScope,
} from '../protocol/index.js';
import { sampleSession, sampleSnapshot } from '../protocol/protocol.fixtures.js';

vi.setConfig({ testTimeout: 20_000 });

const SESSION = sampleSession().id;

let server: FakeServer | null = null;
let client: StratumClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await server?.close();
  server = null;
});

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Servidor que apunta las suscripciones que recibe y reparte ids `sub1`, `sub2`… */
async function setup(mode: 'snapshot' | 'replay' = 'snapshot'): Promise<{
  server: FakeServer;
  client: StratumClient;
  scopes: SubscriptionScope[];
  unsubscribed: string[];
  push: (subscriptionId: string, events: ProtocolEvent[]) => void;
  snapshot: (subscriptionId: string, snapshot: ProtocolSessionSnapshot) => void;
}> {
  const scopes: SubscriptionScope[] = [];
  const unsubscribed: string[] = [];
  let next = 0;
  server = await startFakeServer({
    handlers: {
      'events.subscribe': ({ scope }) => {
        scopes.push(scope);
        const hasSince = scope.kind === 'session' && scope.sinceSeq !== undefined;
        return { subscriptionId: `sub${++next}`, mode: hasSince ? mode : 'snapshot' };
      },
      'events.unsubscribe': ({ subscriptionId }) => {
        unsubscribed.push(subscriptionId);
        return {};
      },
      'trace.subscribe': () => ({ subscriptionId: `sub${++next}` }),
      'trace.unsubscribe': () => ({}),
    },
  });
  const live = server;
  client = new StratumClient({
    discovery: staticDiscovery(() => live.endpoint),
    identity: { kind: 'dot', name: 'subs', version: '0', roles: ['observer'] },
    reconnect: { initialMs: 20, maxMs: 40, jitter: 0 },
  });
  await client.connect();
  const peer = (): FakeServer['connections'][number]['peer'] => live.connections.at(-1)!.peer;
  return {
    server: live,
    client,
    scopes,
    unsubscribed,
    push: (subscriptionId, events) => void peer().notify('events', { subscriptionId, events }),
    snapshot: (subscriptionId, snap) =>
      void peer().notify('snapshot', { subscriptionId, snapshot: snap }),
  };
}

const state = (seq: number, text = `m${seq}`): ProtocolStateEvent => ({
  type: 'message.completed',
  sessionId: SESSION,
  at: seq,
  seq,
  data: { text },
});

const delta = (after: number, text: string): ProtocolEvent => ({
  type: 'message.delta',
  sessionId: SESSION,
  at: after,
  after,
  data: { text },
});

function recorder(): {
  events: ProtocolEvent[];
  snapshots: ProtocolSessionSnapshot[];
  handlers: {
    onEvent: (e: ProtocolEvent) => void;
    onSnapshot: (s: ProtocolSessionSnapshot) => void;
  };
} {
  const events: ProtocolEvent[] = [];
  const snapshots: ProtocolSessionSnapshot[] = [];
  return {
    events,
    snapshots,
    handlers: { onEvent: (e) => events.push(e), onSnapshot: (s) => snapshots.push(s) },
  };
}

const seqs = (events: ProtocolEvent[]): Array<number | string> =>
  events.map((e) => ('seq' in e ? e.seq : `Δ${e.data.text}`));

describe('suscripción a una sesión', () => {
  it('empieza con foto y sigue con los eventos posteriores a su seq', async () => {
    const t = await setup();
    const rec = recorder();
    t.client.subscribeSession(SESSION, rec.handlers);
    await until(() => t.scopes.length === 1);
    expect(t.scopes[0]).toEqual({ kind: 'session', sessionId: SESSION, volatile: true });

    t.snapshot('sub1', sampleSnapshot({ seq: 3 }));
    t.push('sub1', [state(4), delta(4, 'ho'), delta(4, 'la'), state(5)]);
    await until(() => rec.events.length === 4);

    expect(rec.snapshots).toHaveLength(1);
    expect(seqs(rec.events)).toEqual([4, 'Δho', 'Δla', 5]);
  });

  it('descarta lo ya visto: eventos de estado repetidos y fragmentos rezagados', async () => {
    const t = await setup();
    const rec = recorder();
    t.client.subscribeSession(SESSION, rec.handlers);
    await until(() => t.scopes.length === 1);
    t.snapshot('sub1', sampleSnapshot({ seq: 3 }));
    t.push('sub1', [state(2), state(3), delta(1, 'viejo'), state(4), state(4), delta(4, 'nuevo')]);
    await until(() => rec.events.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(seqs(rec.events)).toEqual([4, 'Δnuevo']);
  });

  it('un hueco de seq pide una foto nueva y no entrega nada hasta tenerla', async () => {
    const t = await setup();
    const rec = recorder();
    t.client.subscribeSession(SESSION, rec.handlers);
    await until(() => t.scopes.length === 1);
    t.snapshot('sub1', sampleSnapshot({ seq: 3 }));

    // Se perdieron 4 y 5.
    t.push('sub1', [state(6), state(7)]);
    await until(() => t.scopes.length === 2);

    // La suscripción nueva no pide reenvío: pide foto.
    expect(t.scopes[1]).toEqual({ kind: 'session', sessionId: SESSION, volatile: true });
    expect(t.unsubscribed).toEqual(['sub1']);
    expect(rec.events).toEqual([]);

    // Lo que llegue antes de la foto se ignora; después se sigue desde su seq.
    t.push('sub2', [state(8)]);
    t.snapshot('sub2', sampleSnapshot({ seq: 8 }));
    t.push('sub2', [state(9)]);
    await until(() => rec.events.length === 1);
    expect(rec.snapshots.map((s) => s.seq)).toEqual([3, 8]);
    expect(seqs(rec.events)).toEqual([9]);
  });

  it('tras reconectar se restablece sola, desde el último seq visto', async () => {
    const t = await setup('replay');
    const rec = recorder();
    t.client.subscribeSession(SESSION, rec.handlers);
    await until(() => t.scopes.length === 1);
    t.snapshot('sub1', sampleSnapshot({ seq: 3 }));
    t.push('sub1', [state(4), state(5)]);
    await until(() => rec.events.length === 2);

    t.server.dropAll();
    await t.server.waitForAuthenticated(2);
    await until(() => t.scopes.length === 2);

    expect(t.scopes[1]).toEqual({
      kind: 'session',
      sessionId: SESSION,
      volatile: true,
      sinceSeq: 5,
    });
    // El servidor reenvía desde ahí (con solape): no se duplica nada.
    t.push('sub2', [state(5), state(6)]);
    await until(() => rec.events.length === 3);
    expect(seqs(rec.events)).toEqual([4, 5, 6]);
    expect(rec.snapshots).toHaveLength(1);
  });

  it('si al reconectar el servidor ya no puede reenviar, manda foto y esa manda', async () => {
    const t = await setup('snapshot');
    const rec = recorder();
    t.client.subscribeSession(SESSION, rec.handlers, { sinceSeq: 5 });
    await until(() => t.scopes.length === 1);
    expect(t.scopes[0]).toMatchObject({ sinceSeq: 5 });

    // Eventos sueltos antes de la foto: se ignoran.
    t.push('sub1', [state(40)]);
    t.snapshot('sub1', sampleSnapshot({ seq: 41 }));
    t.push('sub1', [state(42)]);
    await until(() => rec.events.length === 1);
    expect(seqs(rec.events)).toEqual([42]);
    expect(rec.snapshots.map((s) => s.seq)).toEqual([41]);
  });

  it('cerrar la suscripción avisa al servidor y deja de entregar', async () => {
    const t = await setup();
    const rec = recorder();
    const sub = t.client.subscribeSession(SESSION, rec.handlers);
    await until(() => t.scopes.length === 1);
    t.snapshot('sub1', sampleSnapshot({ seq: 1 }));
    await until(() => rec.snapshots.length === 1);

    sub.close();
    sub.close();
    await until(() => t.unsubscribed.length === 1);
    t.push('sub1', [state(2)]);
    await new Promise((r) => setTimeout(r, 40));
    expect(rec.events).toEqual([]);

    // Y no se restablece al reconectar.
    t.server.dropAll();
    await t.server.waitForAuthenticated(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.scopes).toHaveLength(1);
  });

  it('un consumidor que lanza no corta el reparto', async () => {
    const t = await setup();
    const seen: number[] = [];
    t.client.subscribeSession(SESSION, {
      onSnapshot: () => undefined,
      onEvent: (e) => {
        if ('seq' in e) seen.push(e.seq);
        throw new Error('consumidor roto');
      },
    });
    await until(() => t.scopes.length === 1);
    t.snapshot('sub1', sampleSnapshot({ seq: 0 }));
    t.push('sub1', [state(1), state(2)]);
    await until(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
  });
});

describe('suscripción de resumen', () => {
  it('recibe la foto de conjunto y eventos de varias sesiones, cada una con su seq', async () => {
    const t = await setup();
    const events: ProtocolStateEvent[] = [];
    let overviews = 0;
    t.client.subscribeOverview({ onOverview: () => overviews++, onEvent: (e) => events.push(e) });
    await until(() => t.scopes.length === 1);
    expect(t.scopes[0]).toEqual({ kind: 'overview' });

    const a = sampleSession({ id: 'ses_a', seq: 10 });
    const b = sampleSession({ id: 'ses_b', seq: 2 });
    t.server.connections[0]!.peer.notify('overview', {
      subscriptionId: 'sub1',
      overview: { sessions: [a, b], approvals: [], questions: [], plans: [] },
    });
    const updated = (session: typeof a, seq: number): ProtocolStateEvent => ({
      type: 'session.updated',
      sessionId: session.id,
      at: seq,
      seq,
      data: { session: { ...session, seq } },
    });
    // Los seq son por sesión: el 3 de B no es anterior al 14 de A.
    t.push('sub1', [updated(a, 10), updated(a, 14), updated(b, 3), updated(b, 3), updated(b, 7)]);
    await until(() => events.length === 3);

    expect(overviews).toBe(1);
    expect(events.map((e) => `${e.sessionId}:${e.seq}`)).toEqual([
      'ses_a:14',
      'ses_b:3',
      'ses_b:7',
    ]);
  });
});

describe('suscripción a una traza', () => {
  it('entrega los registros y se restablece al reconectar', async () => {
    const t = await setup();
    const batches: Array<{ n: number; reset: boolean }> = [];
    t.client.subscribeTrace(SESSION, {
      onRecords: (records, reset) => batches.push({ n: records.length, reset }),
    });
    await until(() => t.server.received.some((r) => r.method === 'trace.subscribe'));
    const send = (subscriptionId: string, reset: boolean): void =>
      void t.server.connections.at(-1)!.peer.notify('trace.records', {
        subscriptionId,
        sessionId: SESSION,
        reset,
        format: 1,
        records: [{ t: 'turn', at: 1, input: 'hola' }],
      });
    send('sub1', true);
    await until(() => batches.length === 1);

    t.server.dropAll();
    await t.server.waitForAuthenticated(2);
    await until(() => t.server.received.filter((r) => r.method === 'trace.subscribe').length === 2);
    send('sub2', true);
    await until(() => batches.length === 2);
    expect(batches).toEqual([
      { n: 1, reset: true },
      { n: 1, reset: true },
    ]);
  });
});

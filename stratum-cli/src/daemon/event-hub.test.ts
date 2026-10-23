import { describe, it, expect } from 'vitest';
import type {
  NotificationName,
  NotificationParams,
  ProtocolEvent,
  ProtocolSession,
  ProtocolSessionSnapshot,
  ProtocolStateEvent,
  ProtocolVolatileEvent,
} from '../protocol/index.js';
import { NOTIFICATION_PARAMS } from '../protocol/schemas.js';
import { encodeMessage } from '../ipc/codec.js';
import { EventHub, type EventHubOptions, type HubClient } from './event-hub.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function warning(sessionId: string, seq: number): ProtocolStateEvent {
  return { type: 'warning', sessionId, at: 1_000 + seq, seq, data: { message: `w${seq}` } };
}

function delta(sessionId: string, after: number, text: string): ProtocolVolatileEvent {
  return { type: 'message.delta', sessionId, at: 2_000, after, data: { text } };
}

function session(id: string, seq: number): ProtocolSession {
  return {
    id,
    title: '',
    cwd: `/${id}`,
    host: { kind: 'daemon', client: 'daemon', connected: true },
    state: 'idle',
    agent: 'general',
    provider: 'test',
    model: 'm',
    sessionProfile: 'code',
    readOnly: false,
    activeTarget: 'local',
    context: { used: 0, max: 100, pct: 0, estimated: true },
    tokens: { total: null, status: 'unavailable' },
    currentRunId: null,
    seq,
    createdAt: 1,
    updatedAt: 1,
  };
}

type Sent = {
  [N in NotificationName]: { name: N; params: NotificationParams<N> };
}[NotificationName];

class FakeClient implements HubClient {
  open = true;
  readonly sent: Sent[] = [];
  constructor(readonly id: number) {}
  ready(): boolean {
    return this.open;
  }
  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): void {
    // Lo que sale tiene que cumplir el contrato tal cual.
    expect(NOTIFICATION_PARAMS[name].safeParse(params).success, name).toBe(true);
    this.sent.push({ name, params } as Sent);
  }
  sendEncoded(line: string): void {
    // La trama montada a mano es, byte a byte, la del codificador.
    const { method, params } = JSON.parse(line) as { method: NotificationName; params: never };
    expect(line).toBe(encodeMessage({ method, params }));
    this.notify(method, params);
  }
  /** Eventos recibidos, en orden. */
  events(): ProtocolEvent[] {
    return this.sent.flatMap((n) => (n.name === 'events' ? n.params.events : []));
  }
  seqs(): number[] {
    return this.events().flatMap((e) => ('seq' in e ? [e.seq] : []));
  }
  snapshots(): ProtocolSessionSnapshot[] {
    return this.sent.flatMap((n) => (n.name === 'snapshot' ? [n.params.snapshot] : []));
  }
}

/** Un bus con un anfitrión de mentira que lleva la cuenta del `seq` de cada sesión. */
function setup(options: Partial<EventHubOptions> = {}) {
  const seqs = new Map<string, number>();
  const hub = new EventHub({
    snapshotOf: (id) => {
      const seq = seqs.get(id);
      if (seq === undefined) return null;
      return {
        session: session(id, seq),
        seq,
        run: null,
        partial: { text: '', reasoning: '' },
        toolCalls: [],
        subagents: [],
        todos: [],
        jobs: [],
        approvals: [],
        questions: [],
        plans: [],
        messages: [],
        messagesTruncated: false,
      };
    },
    overviewOf: () => ({
      sessions: [...seqs].map(([id, seq]) => session(id, seq)),
      approvals: [],
      questions: [],
      plans: [],
    }),
    ...options,
  });
  const open = (id: string): void => {
    seqs.set(id, 0);
    hub.openSession(id);
  };
  /** El anfitrión emite `n` eventos de estado seguidos. */
  const emit = (id: string, n = 1): void => {
    const events: ProtocolEvent[] = [];
    for (let i = 0; i < n; i++) {
      const seq = seqs.get(id)! + 1;
      seqs.set(id, seq);
      events.push(warning(id, seq));
    }
    hub.ingest(id, events);
  };
  return { hub, seqs, open, emit };
}

describe('EventHub', () => {
  it('no entrega nada de forma síncrona: la respuesta de subscribe va siempre antes', async () => {
    const { hub, open, emit } = setup();
    open('a');
    emit('a', 2);
    const client = new FakeClient(1);
    const result = hub.subscribe(client, { kind: 'session', sessionId: 'a' });
    expect(result.mode).toBe('snapshot');
    expect(client.sent).toEqual([]);
    await tick();
    expect(client.sent[0]).toMatchObject({
      name: 'snapshot',
      params: { subscriptionId: result.subscriptionId },
    });
  });

  it('snapshot inicial y los eventos posteriores, sin repetir lo que ya cubre la foto', async () => {
    const { hub, open, emit } = setup();
    open('a');
    emit('a', 3);
    const client = new FakeClient(1);
    hub.subscribe(client, { kind: 'session', sessionId: 'a' });
    await tick();
    expect(client.snapshots().map((s) => s.seq)).toEqual([3]);
    emit('a', 2);
    await tick();
    // Sigue exactamente desde seq + 1.
    expect(client.seqs()).toEqual([4, 5]);
  });

  it('dos clientes ven los mismos eventos, en el mismo orden y con el seq del anfitrión', async () => {
    const { hub, open, emit } = setup();
    open('a');
    const one = new FakeClient(1);
    const two = new FakeClient(2);
    hub.subscribe(one, { kind: 'session', sessionId: 'a' });
    hub.subscribe(two, { kind: 'session', sessionId: 'a' });
    await tick();
    emit('a', 5);
    hub.ingest('a', [delta('a', 5, 'hola')]);
    emit('a', 1);
    await tick();
    expect(one.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(one.events()).toEqual(two.events());
  });

  it('el seq es de cada sesión: no hay contador global ni eventos que crucen', async () => {
    const { hub, open, emit } = setup();
    open('a');
    open('b');
    const onA = new FakeClient(1);
    const onB = new FakeClient(2);
    hub.subscribe(onA, { kind: 'session', sessionId: 'a' });
    hub.subscribe(onB, { kind: 'session', sessionId: 'b' });
    await tick();
    emit('a', 2);
    emit('b', 1);
    emit('a', 1);
    emit('b', 2);
    await tick();
    expect(onA.seqs()).toEqual([1, 2, 3]);
    expect(onB.seqs()).toEqual([1, 2, 3]);
    expect(onA.events().every((e) => e.sessionId === 'a')).toBe(true);
    expect(onB.events().every((e) => e.sessionId === 'b')).toBe(true);
    // Un evento de otra sesión colado en el lote no se acepta.
    hub.ingest('a', [warning('b', 4)]);
    await tick();
    expect(onA.seqs()).toEqual([1, 2, 3]);
    expect(hub.lastSeq('b')).toBe(3);
  });

  it('reconexión con sinceSeq dentro del buffer: reenvía justo lo que falta', async () => {
    const { hub, open, emit } = setup({ bufferSize: 10 });
    open('a');
    emit('a', 8);
    const client = new FakeClient(1);
    const { mode } = hub.subscribe(client, { kind: 'session', sessionId: 'a', sinceSeq: 5 });
    expect(mode).toBe('replay');
    await tick();
    expect(client.snapshots()).toEqual([]);
    expect(client.seqs()).toEqual([6, 7, 8]);
    emit('a', 1);
    await tick();
    expect(client.seqs()).toEqual([6, 7, 8, 9]);
  });

  it('al día: replay sin nada que reenviar', async () => {
    const { hub, open, emit } = setup();
    open('a');
    emit('a', 4);
    const client = new FakeClient(1);
    expect(hub.subscribe(client, { kind: 'session', sessionId: 'a', sinceSeq: 4 }).mode).toBe(
      'replay',
    );
    await tick();
    expect(client.sent).toEqual([]);
  });

  it('hueco mayor que el buffer → snapshot, y después los deltas posteriores', async () => {
    const { hub, open, emit } = setup({ bufferSize: 4 });
    open('a');
    emit('a', 20);
    const client = new FakeClient(1);
    const { mode } = hub.subscribe(client, { kind: 'session', sessionId: 'a', sinceSeq: 3 });
    expect(mode).toBe('snapshot');
    await tick();
    expect(client.snapshots().map((s) => s.seq)).toEqual([20]);
    expect(client.seqs()).toEqual([]);
    emit('a', 2);
    await tick();
    expect(client.seqs()).toEqual([21, 22]);
  });

  it('un sinceSeq del futuro (otra vida del servidor) no se cree: snapshot', () => {
    const { hub, open, emit } = setup();
    open('a');
    emit('a', 2);
    const client = new FakeClient(1);
    expect(hub.subscribe(client, { kind: 'session', sessionId: 'a', sinceSeq: 90 }).mode).toBe(
      'snapshot',
    );
  });

  it('los volátiles seguidos se agrupan y solo llegan a quien los pide', async () => {
    const { hub, open, emit } = setup();
    open('a');
    emit('a', 1);
    const withText = new FakeClient(1);
    const stateOnly = new FakeClient(2);
    hub.subscribe(withText, { kind: 'session', sessionId: 'a' });
    hub.subscribe(stateOnly, { kind: 'session', sessionId: 'a', volatile: false });
    await tick();
    hub.ingest('a', [delta('a', 1, 'Ho'), delta('a', 1, 'la'), delta('a', 1, '!')]);
    emit('a', 1);
    await tick();
    expect(withText.events()).toEqual([delta('a', 1, 'Hola!'), warning('a', 2)]);
    expect(stateOnly.events()).toEqual([warning('a', 2)]);
  });

  it('cliente lento: se le descarta lo volátil y nunca frena a los demás', async () => {
    const { hub, open, emit } = setup({ maxQueue: 8 });
    open('a');
    const slow = new FakeClient(1);
    const fast = new FakeClient(2);
    hub.subscribe(slow, { kind: 'session', sessionId: 'a' });
    hub.subscribe(fast, { kind: 'session', sessionId: 'a' });
    await tick();
    slow.open = false;
    for (let i = 1; i <= 6; i++) {
      emit('a', 1);
      // Fragmentos de bloques distintos: no se pueden agrupar entre sí.
      hub.ingest('a', [delta('a', i, `t${i}`)]);
      await tick();
    }
    expect(fast.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fast.events()).toHaveLength(12);
    expect(slow.events()).toEqual([]);
    const stats = hub.stats(slow);
    expect(stats.queued).toBeLessThanOrEqual(8);
    expect(stats.volatileDropped).toBeGreaterThan(0);
    expect(stats.resyncs).toBe(0);
    // Al volver recibe todos los eventos de estado, sin hueco: no perdió ninguno.
    slow.open = true;
    hub.pump(slow);
    await tick();
    expect(slow.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slow.snapshots()).toHaveLength(1); // solo la inicial
  });

  it('cliente lento que no cabe ni sin volátiles: se desincroniza y recibe un snapshot', async () => {
    const { hub, open, emit } = setup({ maxQueue: 8 });
    open('a');
    const slow = new FakeClient(1);
    const fast = new FakeClient(2);
    hub.subscribe(slow, { kind: 'session', sessionId: 'a' });
    hub.subscribe(fast, { kind: 'session', sessionId: 'a' });
    await tick();
    slow.open = false;
    for (let i = 0; i < 50; i++) {
      emit('a', 1);
      await tick();
    }
    // La memoria que ocupa el cliente lento está acotada, pase lo que pase.
    expect(hub.stats(slow).queued).toBeLessThanOrEqual(8);
    expect(hub.stats(slow).resyncs).toBe(1);
    expect(fast.seqs()).toHaveLength(50);

    slow.open = true;
    hub.pump(slow);
    await tick();
    // Sustituye su estado por la foto y sigue desde ahí: nada de «fusionar lo que haya».
    expect(slow.snapshots().map((s) => s.seq)).toEqual([0, 50]);
    expect(slow.seqs()).toEqual([]);
    emit('a', 2);
    await tick();
    expect(slow.seqs()).toEqual([51, 52]);
    expect(fast.seqs()).toHaveLength(52);
  });

  it('hueco en lo que publica el anfitrión: no se renumera, se fuerza un snapshot', async () => {
    const { hub, seqs, open, emit } = setup();
    open('a');
    const client = new FakeClient(1);
    hub.subscribe(client, { kind: 'session', sessionId: 'a' });
    await tick();
    emit('a', 2);
    await tick();
    // El anfitrión perdió el 3 y el 4.
    seqs.set('a', 5);
    hub.ingest('a', [warning('a', 5)]);
    await tick();
    expect(client.seqs()).toEqual([1, 2]);
    expect(client.snapshots().map((s) => s.seq)).toEqual([0, 5]);
    expect(hub.stats(client).resyncs).toBe(1);
    // Lo anterior al hueco ya no se puede reenviar.
    const late = new FakeClient(2);
    expect(hub.subscribe(late, { kind: 'session', sessionId: 'a', sinceSeq: 1 }).mode).toBe(
      'snapshot',
    );
    emit('a', 1);
    await tick();
    expect(client.seqs()).toEqual([1, 2, 6]);
  });

  it('la foto puede ir por delante de lo ya repartido: lo que cubre no se repite', async () => {
    const { hub, seqs, open } = setup();
    open('a');
    const client = new FakeClient(1);
    // El anfitrión ya va por el 3, pero al bus aún no le ha llegado nada.
    seqs.set('a', 3);
    hub.subscribe(client, { kind: 'session', sessionId: 'a' });
    await tick();
    expect(client.snapshots().map((s) => s.seq)).toEqual([3]);
    hub.ingest('a', [warning('a', 1), warning('a', 2), warning('a', 3), delta('a', 2, 'viejo')]);
    hub.ingest('a', [warning('a', 4), delta('a', 4, 'nuevo')]);
    await tick();
    expect(client.events()).toEqual([warning('a', 4), delta('a', 4, 'nuevo')]);
  });

  it('resumen: foto de conjunto y solo los eventos de resumen, de todas las sesiones', async () => {
    const { hub, open, emit } = setup();
    open('a');
    open('b');
    const client = new FakeClient(1);
    const { mode } = hub.subscribe(client, { kind: 'overview' });
    expect(mode).toBe('snapshot');
    await tick();
    expect(client.sent[0]).toMatchObject({ name: 'overview' });
    emit('a', 1); // un warning no es de resumen
    hub.ingest('b', [
      {
        type: 'session.updated',
        sessionId: 'b',
        at: 1,
        seq: 1,
        data: { session: session('b', 1) },
      },
      delta('b', 1, 'texto'),
    ]);
    await tick();
    expect(client.events().map((e) => `${e.sessionId}:${e.type}`)).toEqual(['b:session.updated']);
  });

  it('suscribirse a una sesión que no existe es NOT_FOUND', () => {
    const { hub } = setup();
    expect(() => hub.subscribe(new FakeClient(1), { kind: 'session', sessionId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('desuscribirse o desconectarse deja de recibir, sin afectar a nadie más', async () => {
    const { hub, open, emit } = setup();
    open('a');
    const gone = new FakeClient(1);
    const quiet = new FakeClient(2);
    const stays = new FakeClient(3);
    hub.subscribe(gone, { kind: 'session', sessionId: 'a' });
    const { subscriptionId } = hub.subscribe(quiet, { kind: 'session', sessionId: 'a' });
    hub.subscribe(stays, { kind: 'session', sessionId: 'a' });
    await tick();
    hub.dropClient(gone);
    expect(hub.unsubscribe(quiet, subscriptionId)).toBe(true);
    emit('a', 3);
    await tick();
    expect(gone.seqs()).toEqual([]);
    expect(quiet.seqs()).toEqual([]);
    expect(stays.seqs()).toEqual([1, 2, 3]);
  });

  it('al cerrar la sesión, lo ya encolado se entrega', async () => {
    const { hub, open, emit } = setup();
    open('a');
    const client = new FakeClient(1);
    hub.subscribe(client, { kind: 'session', sessionId: 'a' });
    await tick();
    emit('a', 2);
    hub.closeSession('a');
    await tick();
    expect(client.seqs()).toEqual([1, 2]);
    expect(hub.hasSession('a')).toBe(false);
  });
});

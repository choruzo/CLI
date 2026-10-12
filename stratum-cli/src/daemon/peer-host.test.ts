import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StratumClient } from '../client/client.js';
import { ENDPOINT_FILE } from '../client/discovery.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  STRATUM_PROTOCOL_VERSION,
  applySessionEvent,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
} from '../protocol/index.js';
import { sampleRun, sampleSession, sampleSnapshot } from '../protocol/protocol.fixtures.js';
import {
  gate,
  idleAgain,
  runEnded,
  startPeer,
  startTestDaemon,
  textRound,
  watch,
  type Round,
  type TestDaemon,
  type TestPeer,
} from './daemon.fixtures.js';

/**
 * M3 — la CLI como anfitrión par. Una sesión que vive en otro «proceso» (aquí,
 * otro `SessionHost` con su `PeerHostBridge`, sobre el pipe real) se ve y se
 * gobierna desde `stratumd` como cualquier otra, sin que el daemon la aloje.
 */

let t: TestDaemon | undefined;
const peers: TestPeer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop().catch(() => undefined);
  await t?.stop();
  t = undefined;
});

async function peer(...args: Parameters<typeof startPeer>): Promise<TestPeer> {
  const started = await startPeer(...args);
  peers.push(started);
  return started;
}

const failure = (p: Promise<unknown>): Promise<{ code: string; reason?: string }> =>
  p.then(
    () => ({ code: 'OK' }),
    (err: unknown) =>
      err instanceof ProtocolError
        ? { code: err.code, ...(err.data?.reason ? { reason: err.data.reason } : {}) }
        : { code: `threw ${String(err)}` },
  );

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Una foto de ejemplo de una sesión par en reposo, lista para `host.register`. */
function idleSnapshot(id: string, seq = 1): ProtocolSessionSnapshot {
  return sampleSnapshot({
    session: sampleSession({ id, seq, state: 'idle', currentRunId: null }),
    seq,
    run: null,
    partial: { text: '', reasoning: '' },
    toolCalls: [],
    approvals: [],
  });
}

function runningSnapshot(id: string, seq = 3): ProtocolSessionSnapshot {
  const run = sampleRun({ id: `run_${id}`, sessionId: id });
  return sampleSnapshot({
    session: sampleSession({ id, seq, state: 'running', currentRunId: run.id }),
    seq,
    run,
    toolCalls: [],
    approvals: [],
  });
}

const warning = (sessionId: string, seq: number): ProtocolStateEvent => ({
  type: 'warning',
  sessionId,
  at: 1_760_000_002_000 + seq,
  seq,
  data: { message: `aviso ${seq}` },
});

/** Lo que cambia legítimamente entre dos ejecuciones de la misma secuencia. */
function comparable(snapshot: ProtocolSessionSnapshot): unknown {
  const text = JSON.stringify(snapshot, (key, value: unknown) => {
    if (['at', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs'].includes(key)) {
      return 0;
    }
    if (key === 'cwd') return '<cwd>';
    if (key === 'host') return '<host>';
    if (key === 'context' || key === 'tokens') return '<usage>';
    return value;
  })
    .replaceAll(snapshot.session.id, '<session>')
    .replaceAll(snapshot.run?.id ?? '<none>', '<run>');
  return JSON.parse(text);
}

const script = (): Round[] => [
  makeToolCallRound('c1', 'write_file', { path: 'nota.txt', content: 'hola' }),
  textRound(['Hecho', ': ', 'nota escrita.']),
];

describe('A — misma secuencia, alojada en el daemon o en un par', () => {
  it('un observador ve los mismos eventos y la misma foto; solo cambia host.kind', async () => {
    t = await startTestDaemon();
    const observer = await t.connect(['observer']);
    const operator = await t.connect(['operator']);

    // Sesión A: la aloja el daemon.
    const cwd = t.project('local', script());
    const { session: a } = await operator.request('sessions.open', { cwd });
    const watchA = watch(observer, a.id);
    await watchA.untilSnapshot();
    await operator.request('runs.start', { sessionId: a.id, input: 'escribe la nota' });
    await watchA.until(idleAgain);

    // Sesión B: la aloja «la CLI» y la publica.
    const b = await peer(t, 'peer', script());
    expect(b.bridge.connected).toBe(true);
    const watchB = watch(observer, b.sessionId);
    const firstB = await watchB.untilSnapshot();
    const done = await b.run('escribe la nota');
    expect(done).toEqual({ text: 'Hecho: nota escrita.', stopReason: 'stop' });
    await watchB.until(idleAgain);

    // Los mismos eventos de estado, y cada sesión con su propio `seq` desde 1.
    const afterOpening = (types: string[]): string[] => types.filter((x) => x !== 'session.opened');
    expect(afterOpening(watchB.types())).toEqual(afterOpening(watchA.types()));
    const seqsB = watchB.seqs();
    expect(seqsB).toEqual(seqsB.map((_, i) => seqsB[0]! + i));
    expect(seqsB[0]).toBe(firstB.seq + 1);

    const snapA = (await observer.request('sessions.get', { sessionId: a.id })).snapshot;
    const snapB = (await observer.request('sessions.get', { sessionId: b.sessionId })).snapshot;
    expect(snapA.session.host).toEqual({ kind: 'daemon', client: 'daemon', connected: true });
    expect(snapB.session.host).toEqual({ kind: 'peer', client: 'cli', connected: true });
    expect(comparable(snapB)).toEqual(comparable(snapA));
    expect(snapB.run).toMatchObject({ status: 'completed', input: 'escribe la nota' });
    expect(snapB.toolCalls.map((c) => [c.name, c.state])).toEqual([['write_file', 'completed']]);

    // La proyección del daemon es la foto del anfitrión: ni más ni menos, y con su `seq`.
    await until(() => b.bridge.publisher.queued === 0);
    const authoritative = b.bridge.publisher.snapshot();
    expect(snapB.seq).toBe(authoritative.seq);
    expect(comparable(snapB)).toEqual(comparable(authoritative));

    // Y quien sigue la sesión por eventos llega a esa misma foto.
    let reduced = firstB;
    for (const event of watchB.events) reduced = applySessionEvent(reduced, event);
    expect(comparable(reduced)).toEqual(comparable(snapB));

    const { sessions } = await observer.request('sessions.list', {});
    expect(sessions.map((s) => [s.id, s.host.kind, s.state]).sort()).toEqual(
      [
        [a.id, 'daemon', 'idle'],
        [b.sessionId, 'peer', 'idle'],
      ].sort(),
    );
    // El daemon no monta nada para la sesión par: sigue teniendo una sola sesión propia.
    expect(t.daemon.liveSessions).toBe(1);
  }, 30_000);

  it('una sesión par se publica desde su primer evento y se despide con session.closed', async () => {
    t = await startTestDaemon();
    const observer = await t.connect(['observer']);
    const overview: string[] = [];
    observer.subscribeOverview({
      onOverview: (o) => overview.push(`overview:${o.sessions.length}`),
      onEvent: (e) => overview.push(e.type),
    });
    const p = await peer(t, 'peer', [makeTextRound('hola')]);
    const w = watch(observer, p.sessionId, { sinceSeq: 0 });
    await p.run('saluda');
    await w.until(idleAgain);
    // Registrada con `seq` 0: `session.opened` es su evento 1, como en cualquier sesión.
    expect(w.types()[0]).toBe('session.opened');
    expect(w.seqs()[0]).toBe(1);

    await p.stop();
    await w.until((e) => e.type === 'session.closed');
    await until(async () => (await observer.request('sessions.list', {})).sessions.length === 0);
    expect(overview).toContain('session.opened');
    expect(overview).toContain('session.closed');
    expect(await failure(observer.request('sessions.get', { sessionId: p.sessionId }))).toEqual({
      code: 'NOT_FOUND',
    });
  }, 30_000);
});

describe('B — el daemon cae con un run en marcha', () => {
  it('el run sigue, el daemon vuelve, la CLI reconecta y la sesión reaparece con su seq', async () => {
    t = await startTestDaemon();
    const base = t.base;
    const hold = gate();
    const p = await peer(t, 'peer', [
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      {
        wait: hold.wait,
        then: makeToolCallRound('c2', 'write_file', { path: 'b.txt', content: 'b' }),
      },
      makeTextRound('terminado sin daemon'),
    ]);
    const observer = await t.connect(['observer']);
    const w = watch(observer, p.sessionId);
    const running = p.run('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    const seqBefore = w.seqs().at(-1)!;

    // El daemon muere sin avisar.
    await t.daemon.crash();
    await until(() => !p.bridge.connected);

    // La sesión no se entera: el turno termina con su resultado.
    hold.open();
    expect(await running).toEqual({ text: 'terminado sin daemon', stopReason: 'stop' });
    const local = p.bridge.publisher.snapshot();
    expect(local.run?.status).toBe('completed');
    expect(local.seq).toBeGreaterThan(seqBefore);

    // Otro daemon en el mismo sitio: no sabe nada de la sesión.
    const next = await startTestDaemon({ base, dir: t.dir });
    try {
      await until(() => p.bridge.connected);
      const observer2 = await next.connect(['observer']);
      const { sessions } = await observer2.request('sessions.list', {});
      expect(sessions.map((s) => s.id)).toEqual([p.sessionId]);
      const { snapshot } = await observer2.request('sessions.get', { sessionId: p.sessionId });
      // La foto del anfitrión manda: nadie reenvió lo que pasó sin daemon.
      expect(snapshot.seq).toBe(local.seq);
      expect(snapshot.run).toMatchObject({ id: local.run!.id, status: 'completed' });
      expect(snapshot.session).toMatchObject({ state: 'idle', host: { connected: true } });
      // Y sigue publicando a partir de ahí, sin renumerar.
      const w2 = watch(observer2, p.sessionId, { sinceSeq: snapshot.seq });
      p.provider.calls = 2;
      await p.run('otra vez');
      await w2.until(idleAgain);
      expect(w2.seqs()[0]).toBe(local.seq + 1);
    } finally {
      await p.stop();
      await next.stop();
    }
  }, 30_000);

  it('una desconexión con el daemon vivo: detached, y al volver se reclama con la foto', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const hold = gate();
    const p = await peer(t, 'peer', [
      {
        wait: hold.wait,
        then: makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      },
      makeTextRound('listo'),
    ]);
    const observer = await t.connect(['observer']);
    const w = watch(observer, p.sessionId);
    await w.untilSnapshot();
    const running = p.run('trabaja');
    await w.until((e) => e.type === 'run.started');

    // El daemon corta la conexión del anfitrión.
    const hostConn = t.daemon.clients.find((c) => c.client?.name === 'test-peer')!;
    (hostConn as unknown as { socket: { destroy(): void } }).socket.destroy();
    const detached = await w.untilSnapshot(2);
    // Sin anfitrión no es un fallo: el run sigue como estaba, y no se inventa un evento.
    expect(detached.session).toMatchObject({
      state: 'detached',
      host: { kind: 'peer', connected: false },
    });
    expect(detached.run?.status).toBe('running');
    expect(w.types()).not.toContain('session.detached');
    expect(w.types()).not.toContain('session.closed');

    // Mientras tanto la sesión sigue trabajando, y lo que ocurre no llega a nadie.
    hold.open();
    await running;

    // Reconecta sola y reclama la sesión: su foto sustituye lo que hubiera.
    const back = await w.untilSnapshot(3);
    expect(back.session).toMatchObject({ host: { connected: true } });
    await until(async () => {
      const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
      return snapshot.run?.status === 'completed' && snapshot.session.state === 'idle';
    });
    const { runs } = await observer.request('runs.list', { sessionId: p.sessionId });
    expect(runs.map((r) => r.status)).toEqual(['completed']);
  }, 30_000);
});

describe('C — el proceso de la CLI muere', () => {
  async function fakeHost(pid: number): Promise<{ host: StratumClient; id: string }> {
    const host = await t!.connect(['host'], 'fake-host');
    const id = `sess_fake_${pid}`;
    await host.request('host.register', { snapshot: runningSnapshot(id), pid });
    return { host, id };
  }

  it('muerte confirmada: la proyección se descarta y el run queda interrupted', async () => {
    const alive = new Set<number>([4242]);
    t = await startTestDaemon({ isAlive: (pid) => alive.has(pid), peerWatchIntervalMs: 30 });
    const observer = await t.connect(['observer']);
    const { host, id } = await fakeHost(4242);
    const w = watch(observer, id);
    await w.untilSnapshot();

    alive.delete(4242);
    host.close();
    await until(() => w.snapshots.at(-1)?.session.state === 'closed');
    const final = w.snapshots.at(-1)!;
    expect(final.session).toMatchObject({ state: 'closed', host: { connected: false } });
    await until(async () => (await observer.request('sessions.list', {})).sessions.length === 0);
    expect((await observer.request('runs.get', { runId: `run_${id}` })).run.status).toBe(
      'interrupted',
    );
    expect((await observer.request('core.status', {})).activeRuns).toBe(0);
  });

  it('sin poder confirmarla: queda detached hasta que vence el plazo', async () => {
    t = await startTestDaemon({
      isAlive: () => true,
      peerWatchIntervalMs: 30,
      detachedTtlMs: 400,
    });
    const observer = await t.connect(['observer']);
    const { host, id } = await fakeHost(4243);
    host.close();
    await until(async () => {
      const { sessions } = await observer.request('sessions.list', {});
      return sessions[0]?.state === 'detached';
    });
    const { snapshot } = await observer.request('sessions.get', { sessionId: id });
    expect(snapshot.session.host.connected).toBe(false);
    expect(snapshot.run?.status).toBe('running');
    // Sigue contando como run en curso: el daemon no afirma que haya terminado.
    expect((await observer.request('core.status', {})).activeRuns).toBe(1);

    await until(async () => (await observer.request('sessions.list', {})).sessions.length === 0);
    expect((await observer.request('core.status', {})).activeRuns).toBe(0);
  });
});

describe('D — dos anfitriones', () => {
  it('cada conexión solo publica, da de baja y reclama lo que registró', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const hostA = await t.connect(['host'], 'host-a');
    const hostB = await t.connect(['host'], 'host-b');
    await hostA.request('host.register', { snapshot: idleSnapshot('sess_a') });
    const { claim } = await hostB.request('host.register', { snapshot: idleSnapshot('sess_b') });

    const intruder = (p: Promise<unknown>): Promise<string> => failure(p).then((f) => f.code);
    // A conoce el id de B, y no le sirve de nada.
    expect(
      await intruder(
        hostA.request('host.publish', { sessionId: 'sess_b', events: [warning('sess_b', 2)] }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await intruder(
        hostA.request('host.publish', {
          sessionId: 'sess_b',
          snapshot: idleSnapshot('sess_b', 9),
          events: [],
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await intruder(hostA.request('host.unregister', { sessionId: 'sess_b' }))).toBe(
      'FORBIDDEN',
    );
    expect(
      await intruder(hostA.request('host.register', { snapshot: idleSnapshot('sess_b', 9) })),
    ).toBe('FORBIDDEN');
    // Tampoco colando en su propia sesión algo de la otra.
    expect(
      await intruder(
        hostA.request('host.publish', { sessionId: 'sess_a', events: [warning('sess_b', 2)] }),
      ),
    ).toBe('INVALID_PARAMS');
    await hostB.request('host.publish', {
      sessionId: 'sess_b',
      snapshot: runningSnapshot('sess_b', 5),
      events: [],
    });
    const stolenRun: ProtocolEvent = {
      type: 'run.completed',
      sessionId: 'sess_a',
      at: 1,
      seq: 2,
      data: {
        run: sampleRun({ id: 'run_sess_b', sessionId: 'sess_a', status: 'completed' }),
      },
    };
    expect(
      await intruder(hostA.request('host.publish', { sessionId: 'sess_a', events: [stolenRun] })),
    ).toBe('INVALID_PARAMS');
    // Alojar no es gobernar: ni la suya ni la ajena.
    expect(await intruder(hostA.request('runs.cancel', { sessionId: 'sess_b' }))).toBe('FORBIDDEN');
    expect(await intruder(hostA.request('sessions.close', { sessionId: 'sess_a' }))).toBe(
      'FORBIDDEN',
    );

    const observer = await t.connect(['observer']);
    const b = (await observer.request('sessions.get', { sessionId: 'sess_b' })).snapshot;
    expect(b.seq).toBe(5);
    expect(b.run?.status).toBe('running');

    // B se desconecta: su sesión queda sin anfitrión, y A sigue sin poder quedársela.
    hostB.close();
    await until(async () => {
      const { snapshot } = await observer.request('sessions.get', { sessionId: 'sess_b' });
      return !snapshot.session.host.connected;
    });
    expect(
      await intruder(hostA.request('host.register', { snapshot: runningSnapshot('sess_b', 6) })),
    ).toBe('FORBIDDEN');
    expect(
      await intruder(
        hostA.request('host.register', {
          snapshot: runningSnapshot('sess_b', 6),
          claim: 'x'.repeat(48),
        }),
      ),
    ).toBe('FORBIDDEN');

    // Quien la registró vuelve con lo que se le dio, y la recupera.
    const hostB2 = await t.connect(['host'], 'host-b');
    expect(
      await intruder(
        hostB2.request('host.register', { snapshot: runningSnapshot('sess_b', 4), claim }),
      ),
    ).toBe('STALE_STATE');
    const again = await hostB2.request('host.register', {
      snapshot: runningSnapshot('sess_b', 8),
      claim,
    });
    expect(again.claim).toBe(claim);
    const back = (await observer.request('sessions.get', { sessionId: 'sess_b' })).snapshot;
    expect(back).toMatchObject({
      seq: 8,
      session: { state: 'running', host: { connected: true } },
    });

    // Un id de una sesión del daemon tampoco se puede registrar.
    const operator = await t.connect(['operator']);
    const cwd = t.project('local', []);
    const { session } = await operator.request('sessions.open', { cwd });
    expect(
      await intruder(hostA.request('host.register', { snapshot: idleSnapshot(session.id) })),
    ).toBe('FORBIDDEN');
    // Ni presentarla como alojada en el daemon.
    const lying = idleSnapshot('sess_c');
    lying.session.host = { kind: 'daemon', client: 'daemon', connected: true };
    expect(await intruder(hostA.request('host.register', { snapshot: lying }))).toBe(
      'INVALID_PARAMS',
    );
  });
});

describe('E — control remoto de una sesión par', () => {
  it('steer y cancel llegan al runtime de la CLI y el observador ve el resultado', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const hold = gate();
    const p = await peer(t, 'peer', [
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      { wait: hold.wait, then: makeTextRound('no debería llegar') },
    ]);
    const observer = await t.connect(['observer']);
    const operator = await t.connect(['operator']);
    const w = watch(observer, p.sessionId);

    // Sin turno en curso, lo dice el runtime.
    expect(await operator.request('runs.steer', { sessionId: p.sessionId, text: 'hola' })).toEqual({
      status: 'not-accepting',
    });
    expect(await operator.request('runs.cancel', { sessionId: p.sessionId })).toEqual({
      status: 'not-running',
    });

    const running = p.run('trabaja');
    const started = await w.until((e) => e.type === 'run.started');
    const runId = started.runId!;
    await w.until((e) => e.type === 'tool.completed');

    // Steering: lo acepta la Runtime Inbox de la sesión, no el daemon.
    expect(
      await operator.request('runs.steer', { sessionId: p.sessionId, text: 'cambia de plan' }),
    ).toEqual({ status: 'accepted' });
    expect(await operator.request('runs.steer', { sessionId: p.sessionId, text: '   ' })).toEqual({
      status: 'empty',
    });
    const queued = await w.until((e) => e.type === 'steering.queued');
    expect(queued).toMatchObject({ data: { chars: 'cambia de plan'.length } });
    expect(p.host.agent.inbox.pendingUserMessages()).toHaveLength(1);

    // Cancelar un run que no es el vigente no cancela nada.
    expect(
      await failure(operator.request('runs.cancel', { sessionId: p.sessionId, runId: 'run_otro' })),
    ).toEqual({ code: 'STALE_STATE' });
    expect(await operator.request('runs.cancel', { sessionId: p.sessionId, runId })).toEqual({
      status: 'cancelled',
    });
    expect((await running).stopReason).toBe('cancelled');
    const ended = await w.until(runEnded);
    expect(ended.type).toBe('run.cancelled');
    expect(await operator.request('runs.cancel', { sessionId: p.sessionId })).toEqual({
      status: 'not-running',
    });

    // Lo que solo puede hacer quien aloja la sesión se rechaza diciéndolo.
    const refused = await Promise.all([
      failure(operator.request('runs.start', { sessionId: p.sessionId, input: 'x' })),
      failure(operator.request('sessions.close', { sessionId: p.sessionId })),
      failure(operator.request('sessions.setReadOnly', { sessionId: p.sessionId, readOnly: true })),
    ]);
    for (const attempt of refused) {
      expect(attempt).toEqual({ code: 'UNAVAILABLE', reason: 'peer-hosted' });
    }
    hold.open();
  }, 30_000);

  it('sin anfitrión conectado: UNAVAILABLE, nunca un resultado inventado', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const host = await t.connect(['host'], 'fake-host');
    await host.request('host.register', { snapshot: runningSnapshot('sess_x') });
    const operator = await t.connect(['operator']);
    host.close();
    await until(async () => {
      const { snapshot } = await operator.request('sessions.get', { sessionId: 'sess_x' });
      return !snapshot.session.host.connected;
    });
    const unavailable = { code: 'UNAVAILABLE', reason: 'host-unavailable' };
    expect(await failure(operator.request('runs.cancel', { sessionId: 'sess_x' }))).toEqual(
      unavailable,
    );
    expect(
      await failure(operator.request('runs.steer', { sessionId: 'sess_x', text: 'hola' })),
    ).toEqual(unavailable);
  });

  it('un cancel no espera detrás de lo que el anfitrión está publicando', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const hold = gate();
    const rounds: Round[] = [];
    for (let i = 0; i < 40; i++) {
      rounds.push(makeToolCallRound(`c${i}`, 'write_file', { path: `f${i}.txt`, content: 'x' }));
    }
    rounds.push({ wait: hold.wait, then: makeTextRound('fin') });
    const p = await peer(t, 'peer', rounds);
    const operator = await t.connect(['operator']);
    const running = p.run('escribe mucho');
    await until(() => p.provider.calls > 5);
    const before = Date.now();
    expect(await operator.request('runs.cancel', { sessionId: p.sessionId })).toEqual({
      status: 'cancelled',
    });
    expect(Date.now() - before).toBeLessThan(2_000);
    expect((await running).stopReason).toBe('cancelled');
    hold.open();
  }, 30_000);
});

describe('F — publicar es opcional', () => {
  const run = async (p: TestPeer): Promise<void> => {
    expect(await p.run('saluda')).toEqual({ text: 'hola', stopReason: 'stop' });
    expect(p.bridge.connected).toBe(false);
  };

  it('sin daemon, con un endpoint corrupto, incompatible o con el token equivocado', async () => {
    t = await startTestDaemon();
    const base = t.base;
    const place = (name: string, content: string): { base: string; dir: string } => {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      if (content) writeFileSync(join(dir, ENDPOINT_FILE), content);
      return { base, dir };
    };
    const live = t.daemon.endpoint;

    const started = Date.now();
    await run(await peer(place('none', ''), 'p1', [makeTextRound('hola')]));
    // Sin daemon no hay nada que esperar.
    expect(Date.now() - started).toBeLessThan(1_000);
    await run(await peer(place('corrupt', '{ esto no es json'), 'p2', [makeTextRound('hola')]));
    await run(
      await peer(
        place('other', JSON.stringify({ ...live, protocol: STRATUM_PROTOCOL_VERSION + 1 })),
        'p3',
        [makeTextRound('hola')],
      ),
    );
    await run(
      await peer(place('badtoken', JSON.stringify({ ...live, token: 'f'.repeat(64) })), 'p4', [
        makeTextRound('hola'),
      ]),
    );
    // Nada de eso llegó al daemon.
    const observer = await t.connect(['observer']);
    expect((await observer.request('sessions.list', {})).sessions).toEqual([]);
  }, 30_000);

  it('host.publish rechazado: la sesión sigue, y el puente vuelve con una foto', async () => {
    t = await startTestDaemon({ isAlive: () => true, detachedTtlMs: 0 });
    const hold = gate();
    const p = await peer(t, 'peer', [
      {
        wait: hold.wait,
        then: makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      },
      makeTextRound('hola'),
    ]);
    const observer = await t.connect(['observer']);
    const running = p.run('saluda');
    await until(
      async () => (await observer.request('runs.list', { active: true })).runs.length > 0,
    );

    // Un hueco provocado: el daemon ya va por un `seq` que la CLI no ha emitido.
    const peersOf = t.daemon as unknown as {
      peers: { sessions: Map<string, { snapshot: ProtocolSessionSnapshot }> };
    };
    const projection = peersOf.peers.sessions.get(p.sessionId)!;
    projection.snapshot = { ...projection.snapshot, seq: projection.snapshot.seq - 1 };
    const stale = projection.snapshot.seq;

    hold.open();
    expect(await running).toEqual({ text: 'hola', stopReason: 'stop' });
    // El lote con hueco se rechazó (`STALE_STATE`) y la foto del anfitrión lo arregló.
    await until(async () => {
      const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
      return snapshot.run?.status === 'completed' && snapshot.seq > stale;
    });
    const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
    await until(() => p.bridge.publisher.queued === 0);
    expect(snapshot.seq).toBe(p.bridge.publisher.seq);
    expect(p.bridge.connected).toBe(true);
  }, 30_000);
});

describe('G — daemon.autoStart', () => {
  it('sin autoStart no arranca nada; con él, arranca una vez y publica', async () => {
    t = await startTestDaemon();
    const base = t.base;
    const dir = join(base, 'later');
    mkdirSync(dir, { recursive: true });

    // Sin autoStart: no hay daemon en esa carpeta y no se crea.
    const quiet = await peer({ base, dir }, 'p1', [makeTextRound('hola')]);
    expect(quiet.bridge.connected).toBe(false);

    let started: TestDaemon | undefined;
    let calls = 0;
    const eager = await peer({ base, dir }, 'p2', [makeTextRound('hola')], {
      autoStart: async () => {
        calls++;
        started = await startTestDaemon({ base, dir });
      },
    });
    try {
      expect(calls).toBe(1);
      expect(eager.bridge.connected).toBe(true);
      const observer = await started!.connect(['observer']);
      // El que no arrancaba nada lo encuentra en cuanto existe.
      await until(async () => (await observer.request('sessions.list', {})).sessions.length === 2);
      expect(calls).toBe(1);
    } finally {
      await quiet.stop();
      await eager.stop();
      await started?.stop();
    }
  }, 30_000);

  it('un autoStart que falla o tarda no impide ejecutar', async () => {
    t = await startTestDaemon();
    const dir = join(t.base, 'never');
    mkdirSync(dir, { recursive: true });
    const p = await peer({ base: t.base, dir }, 'p1', [makeTextRound('hola')], {
      autoStart: async () => {
        throw new Error('no arranca');
      },
    });
    expect(p.bridge.connected).toBe(false);
    expect(await p.run('saluda')).toEqual({ text: 'hola', stopReason: 'stop' });
  });
});

describe('H — huecos', () => {
  it('un lote con hueco se rechaza entero; una foto lo sustituye y los clientes la reciben', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const host = await t.connect(['host'], 'fake-host');
    const observer = await t.connect(['observer']);
    await host.request('host.register', { snapshot: idleSnapshot('sess_g', 1) });
    const w = watch(observer, 'sess_g', { sinceSeq: 1 });

    await host.request('host.publish', {
      sessionId: 'sess_g',
      events: [warning('sess_g', 2), warning('sess_g', 3)],
    });
    // Repetidos: se ignoran, no rompen nada.
    await host.request('host.publish', { sessionId: 'sess_g', events: [warning('sess_g', 3)] });
    await w.until((e) => 'seq' in e && e.seq === 3);

    // Faltan 4..8: no se aplica nada del lote, ni se renumera.
    expect(
      await failure(
        host.request('host.publish', {
          sessionId: 'sess_g',
          events: [warning('sess_g', 4), warning('sess_g', 9)],
        }),
      ),
    ).toEqual({ code: 'STALE_STATE', reason: 'seq-gap' });
    expect((await observer.request('sessions.get', { sessionId: 'sess_g' })).snapshot.seq).toBe(3);

    // La foto del anfitrión manda, y lo que sigue continúa desde ella.
    await host.request('host.publish', {
      sessionId: 'sess_g',
      snapshot: idleSnapshot('sess_g', 9),
      events: [warning('sess_g', 10)],
    });
    // Quien la seguía recibe la foto (ya con el evento 10 dentro), no los eventos perdidos.
    const snapshot = await w.untilSnapshot();
    expect(snapshot.seq).toBe(10);
    await host.request('host.publish', { sessionId: 'sess_g', events: [warning('sess_g', 11)] });
    await w.until((e) => 'seq' in e && e.seq === 11);
    expect(w.seqs()).toEqual([2, 3, 11]);
    expect((await observer.request('sessions.get', { sessionId: 'sess_g' })).snapshot.seq).toBe(11);
  });

  it('la cola de salida del puente está acotada: al llenarse viaja una foto, no la historia', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const rounds: Round[] = [];
    for (let i = 0; i < 30; i++) {
      rounds.push(makeToolCallRound(`c${i}`, 'write_file', { path: `f${i}.txt`, content: 'x' }));
    }
    rounds.push(makeTextRound('fin'));
    const p = await peer(t, 'peer', rounds, { maxQueue: 16 });
    const observer = await t.connect(['observer']);

    // El daemon deja de contestar a ese anfitrión durante el turno.
    const internals = p.bridge as unknown as { client: StratumClient };
    const real = internals.client.request.bind(internals.client);
    const stalled = gate();
    let held = 0;
    internals.client.request = (async (method: string, params: unknown, options: unknown) => {
      if (method === 'host.publish') {
        held++;
        await stalled.wait;
      }
      return (real as (...args: unknown[]) => Promise<unknown>)(method, params, options);
    }) as typeof internals.client.request;

    expect((await p.run('escribe mucho')).stopReason).toBe('stop');
    const queue = (p.bridge as unknown as { queue: unknown[] }).queue;
    expect(queue.length).toBeLessThanOrEqual(16);
    expect(held).toBe(1);

    stalled.open();
    await until(async () => {
      const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
      return snapshot.seq === p.bridge.publisher.seq;
    });
    const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
    expect(snapshot.run?.status).toBe('completed');
    expect(snapshot.run?.counters.toolCalls).toBe(30);
  }, 30_000);
});

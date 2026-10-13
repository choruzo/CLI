/**
 * M5 — pausa cooperativa a través del daemon. Daemon, clientes y sesiones de
 * verdad sobre un pipe real; lo único de guion es el modelo.
 *
 * Lo que se comprueba aquí es lo que ve y puede hacer un cliente: que pedir una
 * pausa no la da por alcanzada, que `paused` lo publica el runtime de la sesión
 * (el del daemon o el de la CLI, que es el mismo código), y que mientras dura
 * el modelo no recibe nada y ninguna tool empieza.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StratumClient } from '../client/client.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { ProtocolEvent, ProtocolSessionSnapshot } from '../protocol/index.js';
import {
  gate,
  idleAgain,
  runEnded,
  startPeer,
  startTestDaemon,
  watch,
  type Gate,
  type Round,
  type TestDaemon,
  type TestPeer,
  type Watcher,
} from './daemon.fixtures.js';

let t: TestDaemon | undefined;
const extra: TestDaemon[] = [];
const peers: TestPeer[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  for (const d of extra.splice(0)) await d.stop().catch(() => undefined);
  await t?.stop();
  t = undefined;
});

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
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Lo bastante para que, si algo fuera a ocurrir, ya hubiera ocurrido. */
const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

const paused = (e: ProtocolEvent): boolean =>
  e.type === 'run.updated' && e.data.run.status === 'paused';
const runningAgain =
  (after: number) =>
  (e: ProtocolEvent): boolean =>
    e.type === 'run.updated' && e.data.run.status === 'running' && e.seq > after;

/** Lo que cambia legítimamente entre dos ejecuciones de la misma secuencia. */
function comparable(snapshot: ProtocolSessionSnapshot): unknown {
  const text = JSON.stringify(snapshot, (key, value: unknown) => {
    if (['at', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs'].includes(key)) {
      return 0;
    }
    if (key === 'cwd') return '<cwd>';
    if (key === 'host') return '<host>';
    if (key === 'context' || key === 'tokens') return '<usage>';
    if (key === 'id' && typeof value === 'string' && value.startsWith('steer')) return '<steer>';
    return value;
  })
    .replaceAll(snapshot.session.id, '<session>')
    .replaceAll(snapshot.run?.id ?? '<none>', '<run>');
  return JSON.parse(text);
}

/**
 * Una tarea de varios pasos con dos llamadas al modelo que el test retiene:
 * `first` propone escribir `b.txt` y `second` propone escribir `c.txt`.
 */
function steps(): { rounds: Round[]; first: Gate; second: Gate } {
  const first = gate();
  const second = gate();
  return {
    first,
    second,
    rounds: [
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      {
        wait: first.wait,
        then: makeToolCallRound('c2', 'write_file', { path: 'b.txt', content: 'b' }),
      },
      {
        wait: second.wait,
        then: makeToolCallRound('c3', 'write_file', { path: 'c.txt', content: 'c' }),
      },
      makeTextRound('terminado'),
    ],
  };
}

/** Una sesión bajo prueba, la aloje quien la aloje. */
interface Subject {
  kind: 'daemon' | 'peer';
  sessionId: string;
  cwd: string;
  first: Gate;
  second: Gate;
  /** Peticiones que ha recibido el modelo. */
  calls(): number;
  start(input: string): Promise<void>;
  /** Estado de pausa del runtime real de la sesión. */
  runtimeState(): string;
}

async function subject(
  daemon: TestDaemon,
  operator: StratumClient,
  kind: 'daemon' | 'peer',
): Promise<Subject> {
  const { rounds, first, second } = steps();
  if (kind === 'daemon') {
    const cwd = daemon.project(`d${Math.random().toString(36).slice(2, 8)}`, rounds);
    const { session } = await operator.request('sessions.open', { cwd });
    return {
      kind,
      sessionId: session.id,
      cwd,
      first,
      second,
      calls: () => daemon.provider(cwd).calls,
      start: async (input) => {
        await operator.request('runs.start', { sessionId: session.id, input });
      },
      runtimeState: () => 'n/a',
    };
  }
  const p = await startPeer(daemon, `p${Math.random().toString(36).slice(2, 8)}`, rounds);
  peers.push(p);
  return {
    kind,
    sessionId: p.sessionId,
    cwd: p.host.env.cwd,
    first,
    second,
    calls: () => p.provider.calls,
    start: async (input) => {
      void p.run(input);
    },
    runtimeState: () => p.host.pauseState,
  };
}

/**
 * La secuencia del «test rey»: pausa con una llamada al modelo en vuelo →
 * `paused` sin ejecutar la tool propuesta → steering (sigue en pausa) →
 * reanudar (el modelo recibe el steering) → pausa otra vez → cancelar.
 */
async function pauseSteerResumeCancel(
  s: Subject,
  operator: StratumClient,
  w: Watcher,
): Promise<{ whilePaused: ProtocolSessionSnapshot; final: ProtocolSessionSnapshot }> {
  const get = async (): Promise<ProtocolSessionSnapshot> =>
    (await operator.request('sessions.get', { sessionId: s.sessionId })).snapshot;

  await s.start('haz una tarea de varios pasos');
  const started = await w.until((e) => e.type === 'run.started');
  const runId = started.runId!;
  await w.until((e) => e.type === 'tool.completed');
  await until(() => s.calls() === 2);

  // Con la segunda llamada al modelo en vuelo: pedida, no alcanzada.
  expect(await operator.request('runs.pause', { sessionId: s.sessionId, runId })).toEqual({
    status: 'requested',
  });
  expect(await operator.request('runs.pause', { sessionId: s.sessionId })).toEqual({
    status: 'already-requested',
  });
  expect((await get()).run?.status).toBe('running');
  expect(w.events.some(paused)).toBe(false);

  // La llamada termina (no se cortó) y propone una tool: no se ejecuta.
  s.first.open();
  await w.until(paused);
  await settle();
  expect(existsSync(join(s.cwd, 'b.txt'))).toBe(false);
  expect(s.calls()).toBe(2);
  expect(await operator.request('runs.pause', { sessionId: s.sessionId })).toEqual({
    status: 'already-paused',
  });
  const whilePaused = await get();
  expect(whilePaused.run).toMatchObject({ id: runId, status: 'paused' });
  expect(whilePaused.session).toMatchObject({ state: 'paused', currentRunId: runId });
  // Nada se pierde por pausar: lo hecho y lo propuesto siguen en la foto.
  expect(whilePaused.toolCalls.map((c) => c.id)).toEqual(['c1', 'c2']);
  expect(whilePaused.toolCalls[0]).toMatchObject({ state: 'completed' });

  // Redirigir con el run en pausa: se acepta y no reanuda.
  expect(
    await operator.request('runs.steer', { sessionId: s.sessionId, text: 'cambia el enfoque' }),
  ).toEqual({ status: 'accepted' });
  await w.until((e) => e.type === 'steering.queued');
  await settle();
  expect((await get()).run?.status).toBe('paused');
  expect(s.calls()).toBe(2);
  expect(w.types()).not.toContain('steering.delivered');

  // Reanudar: el mismo run, y el modelo decide de nuevo con el mensaje delante.
  const before = w.seqs().at(-1)!;
  expect(await operator.request('runs.resume', { sessionId: s.sessionId, runId })).toEqual({
    status: 'resumed',
  });
  expect(await operator.request('runs.resume', { sessionId: s.sessionId })).toEqual({
    status: 'not-paused',
  });
  await w.until(runningAgain(before));
  await w.until((e) => e.type === 'steering.delivered');
  await until(() => s.calls() === 3);
  expect(existsSync(join(s.cwd, 'b.txt'))).toBe(false);
  expect((await get()).run).toMatchObject({ id: runId, status: 'running' });

  // Otra pausa, y cancelar sin reanudar.
  expect(await operator.request('runs.pause', { sessionId: s.sessionId })).toEqual({
    status: 'requested',
  });
  s.second.open();
  await w.until((e) => paused(e) && 'seq' in e && e.seq > before);
  expect(await operator.request('runs.cancel', { sessionId: s.sessionId, runId })).toEqual({
    status: 'cancelled',
  });
  const ended = await w.until(runEnded);
  expect(ended.type).toBe('run.cancelled');
  await w.until((e) => idleAgain(e) && 'seq' in e && e.seq > before);
  expect(existsSync(join(s.cwd, 'c.txt'))).toBe(false);
  expect(s.calls()).toBe(3);

  // Sin run, ni pausa ni reanudación.
  expect(await operator.request('runs.pause', { sessionId: s.sessionId })).toEqual({
    status: 'not-running',
  });
  expect(await operator.request('runs.resume', { sessionId: s.sessionId })).toEqual({
    status: 'not-running',
  });
  const final = await get();
  expect(final.run).toMatchObject({ id: runId, status: 'cancelled' });
  expect(final.session.state).toBe('idle');
  return { whilePaused, final };
}

describe('L — sesión alojada en el daemon', () => {
  it('pausa → steering → reanudar → pausa → cancelar', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'daemon');
    const w = watch(observer, s.sessionId);
    await w.untilSnapshot();
    await pauseSteerResumeCancel(s, operator, w);
    // Los `seq` siguen siendo los de la sesión, sin huecos.
    const seqs = w.seqs();
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  }, 30_000);

  it('pausar exige la capacidad de control, y un run que no es el vigente no se pausa', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'daemon');
    const w = watch(observer, s.sessionId);
    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');

    expect(await failure(observer.request('runs.pause', { sessionId: s.sessionId }))).toEqual({
      code: 'FORBIDDEN',
    });
    expect(
      await failure(operator.request('runs.pause', { sessionId: s.sessionId, runId: 'run_otro' })),
    ).toEqual({ code: 'STALE_STATE' });
    expect(
      await failure(operator.request('runs.resume', { sessionId: s.sessionId, runId: 'run_otro' })),
    ).toEqual({ code: 'STALE_STATE' });
    expect(await failure(operator.request('runs.pause', { sessionId: 'nope' }))).toEqual({
      code: 'NOT_FOUND',
    });
    await settle(100);
    expect(w.events.some(paused)).toBe(false);
  }, 30_000);
});

describe('K — sesión alojada en la CLI', () => {
  it('la pausa remota llega al runtime de la CLI, y es él quien confirma', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'peer');
    const w = watch(observer, s.sessionId);
    await w.untilSnapshot();

    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    await until(() => s.calls() === 2);
    await operator.request('runs.pause', { sessionId: s.sessionId });
    // El daemon reenvió la orden, pero no da nada por pausado por su cuenta.
    expect(s.runtimeState()).toBe('pause-requested');
    const { snapshot } = await operator.request('sessions.get', { sessionId: s.sessionId });
    expect(snapshot.run?.status).toBe('running');

    s.first.open();
    await w.until(paused);
    expect(s.runtimeState()).toBe('paused');
    // El daemon sigue sin alojar nada: solo tiene la proyección.
    expect(t.daemon.liveSessions).toBe(0);

    expect(await operator.request('runs.resume', { sessionId: s.sessionId })).toEqual({
      status: 'resumed',
    });
    expect(s.runtimeState()).toBe('running');
    await until(() => existsSync(join(s.cwd, 'b.txt')));
    s.second.open();
    await w.until(runEnded);
    expect(existsSync(join(s.cwd, 'c.txt'))).toBe(true);
  }, 30_000);
});

describe('equivalencia — alojada en el daemon o en un par', () => {
  it('pause, steer, resume y cancel: mismo ciclo de vida observable; solo cambia host.kind', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);

    const seen: Record<string, { types: string[]; statuses: string[]; states: string[] }> = {};
    const fotos: Record<string, Awaited<ReturnType<typeof pauseSteerResumeCancel>>> = {};
    for (const kind of ['daemon', 'peer'] as const) {
      const s = await subject(t, operator, kind);
      const w = watch(observer, s.sessionId);
      await w.untilSnapshot();
      fotos[kind] = await pauseSteerResumeCancel(s, operator, w);
      seen[kind] = {
        types: w.types().filter((x) => x !== 'session.opened'),
        statuses: w
          .states()
          .flatMap((e) =>
            e.type.startsWith('run.') && 'run' in e.data ? [e.data.run.status] : [],
          ),
        states: w
          .states()
          .flatMap((e) => (e.type === 'session.updated' ? [e.data.session.state] : [])),
      };
      w.close();
    }

    expect(seen.peer).toEqual(seen.daemon);
    expect(seen.daemon!.statuses).toEqual(['running', 'paused', 'running', 'paused', 'cancelled']);
    expect(seen.daemon!.states).toEqual(['running', 'paused', 'running', 'paused', 'idle']);
    expect(fotos.daemon!.whilePaused.session.host.kind).toBe('daemon');
    expect(fotos.peer!.whilePaused.session.host.kind).toBe('peer');
    expect(comparable(fotos.peer!.whilePaused)).toEqual(comparable(fotos.daemon!.whilePaused));
    expect(comparable(fotos.peer!.final)).toEqual(comparable(fotos.daemon!.final));
  }, 60_000);
});

describe('J — aprobación pendiente y pausa', () => {
  it('aprobar no reanuda: la tool aprobada no se ejecuta hasta runs.resume', async () => {
    t = await startTestDaemon();
    const cwd = t.project('aprobacion', [
      makeToolCallRound('c1', 'exec', { command: 'rm victim.txt' }),
      makeTextRound('hecho'),
    ]);
    const file = join(cwd, 'victim.txt');
    writeFileSync(file, 'no me borres\n');
    const operator = await t.connect(['operator']);
    const approver = await t.connect(['approver']);
    const { session } = await operator.request('sessions.open', { cwd });
    const w = watch(approver, session.id);
    await w.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'borra' });
    const asked = await w.until((e) => e.type === 'approval.requested');
    const approvalId = (asked as Extract<ProtocolEvent, { type: 'approval.requested' }>).data
      .approval.id;

    // Pausar no toca la solicitud: sigue pendiente y el run sigue esperándola.
    expect(await operator.request('runs.pause', { sessionId: session.id })).toEqual({
      status: 'requested',
    });
    await settle();
    const waiting = (await operator.request('sessions.get', { sessionId: session.id })).snapshot;
    expect(waiting.run?.status).toBe('waiting_approval');
    expect(waiting.approvals.map((a) => a.id)).toEqual([approvalId]);
    expect((await approver.request('approvals.list', {})).approvals).toHaveLength(1);

    // Resolverla no es reanudar.
    await approver.request('approvals.resolve', { approvalId, decision: 'approve' });
    await w.until(paused);
    await settle();
    expect(existsSync(file)).toBe(true);
    expect(t.provider(cwd).calls).toBe(1);
    const held = (await operator.request('sessions.get', { sessionId: session.id })).snapshot;
    expect(held.run?.status).toBe('paused');
    expect(held.approvals).toEqual([]);

    await operator.request('runs.resume', { sessionId: session.id });
    await w.until(runEnded);
    // Se ejecutó lo aprobado, una vez.
    expect(existsSync(file)).toBe(false);
    expect(w.types().filter((x) => x === 'approval.requested')).toHaveLength(1);
  }, 30_000);
});

describe('M — el plano de control cae con un run en pausa', () => {
  it('el daemon muere: la CLI sigue en pausa, y al volver su foto lo dice', async () => {
    t = await startTestDaemon();
    const base = t.base;
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'peer');
    const p = peers.at(-1)!;
    const w = watch(observer, s.sessionId);
    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    await until(() => s.calls() === 2);
    await operator.request('runs.pause', { sessionId: s.sessionId });
    s.first.open();
    await w.until(paused);

    await t.daemon.crash();
    await until(() => !p.bridge.connected);
    await settle();
    // La pausa es del runtime: no se levanta porque no haya quien la mire.
    expect(p.host.pauseState).toBe('paused');
    expect(existsSync(join(s.cwd, 'b.txt'))).toBe(false);
    expect(s.calls()).toBe(2);

    const next = await startTestDaemon({ base, dir: t.dir });
    extra.push(next);
    await until(() => p.bridge.connected);
    const operator2 = await next.connect(['operator']);
    const { snapshot } = await operator2.request('sessions.get', { sessionId: s.sessionId });
    expect(snapshot.run?.status).toBe('paused');
    expect(snapshot.session).toMatchObject({ state: 'paused', host: { connected: true } });
    expect((await operator2.request('runs.list', {})).runs.map((r) => r.status)).toEqual([
      'paused',
    ]);

    // Y el daemon nuevo la gobierna como cualquier otra.
    expect(await operator2.request('runs.resume', { sessionId: s.sessionId })).toEqual({
      status: 'resumed',
    });
    await until(() => existsSync(join(s.cwd, 'b.txt')));
    s.second.open();
    await until(async () => {
      const now = await operator2.request('sessions.get', { sessionId: s.sessionId });
      return now.snapshot.run?.status === 'completed';
    });
  }, 30_000);

  it('el anfitrión se desconecta en pausa: detached, y el run sigue pausado, no fallido', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'peer');
    const w = watch(observer, s.sessionId);
    await w.untilSnapshot();
    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    await until(() => s.calls() === 2);
    await operator.request('runs.pause', { sessionId: s.sessionId });
    s.first.open();
    await w.until(paused);

    const hostConn = t.daemon.clients.find((c) => c.client?.name === 'test-peer')!;
    (hostConn as unknown as { socket: { destroy(): void } }).socket.destroy();
    const detached = await w.untilSnapshot(2);
    expect(detached.session).toMatchObject({ state: 'detached', host: { connected: false } });
    expect(detached.run?.status).toBe('paused');

    // Reconecta sola y sigue en pausa.
    const back = await w.untilSnapshot(3);
    expect(back.session).toMatchObject({ state: 'paused', host: { connected: true } });
    expect(back.run?.status).toBe('paused');
  }, 30_000);
});

describe('el daemon con una sesión en pausa', () => {
  it('no se apaga por inactividad: una sesión en pausa sigue viva', async () => {
    t = await startTestDaemon({ idleExitMs: 150 });
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'daemon');
    const w = watch(observer, s.sessionId);
    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    await operator.request('runs.pause', { sessionId: s.sessionId });
    s.first.open();
    await w.until(paused);
    operator.close();
    observer.close();

    let closed = false;
    void t.daemon.closed.then(() => (closed = true));
    await settle(800);
    expect(closed).toBe(false);
    expect(t.daemon.liveSessions).toBe(1);
  }, 30_000);

  it('sigue atendiendo a todos mientras tanto, y otra sesión trabaja con normalidad', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const s = await subject(t, operator, 'daemon');
    const w = watch(observer, s.sessionId);
    await s.start('trabaja');
    await w.until((e) => e.type === 'tool.completed');
    await operator.request('runs.pause', { sessionId: s.sessionId });
    s.first.open();
    await w.until(paused);

    const cwd = t.project('otra', [makeTextRound('hola')]);
    const { session: other } = await operator.request('sessions.open', { cwd });
    const w2 = watch(observer, other.id);
    await operator.request('runs.start', { sessionId: other.id, input: 'saluda' });
    await w2.until(runEnded);
    const { sessions } = await observer.request('sessions.list', {});
    expect(sessions.map((x) => [x.id, x.state]).sort()).toEqual(
      [
        [s.sessionId, 'paused'],
        [other.id, 'idle'],
      ].sort(),
    );
    expect((await observer.request('core.status', {})).activeRuns).toBe(1);
  }, 30_000);

  it('cerrar la sesión o apagar el daemon con force suelta la pausa: nada queda colgado', async () => {
    t = await startTestDaemon();
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const a = await subject(t, operator, 'daemon');
    const b = await subject(t, operator, 'daemon');
    const wa = watch(observer, a.sessionId);
    const wb = watch(observer, b.sessionId);
    for (const [s, w] of [
      [a, wa],
      [b, wb],
    ] as const) {
      await s.start('trabaja');
      await w.until((e) => e.type === 'tool.completed');
      await operator.request('runs.pause', { sessionId: s.sessionId });
      s.first.open();
      await w.until(paused);
    }

    const started = Date.now();
    await operator.request('sessions.close', { sessionId: a.sessionId });
    expect((await wa.until(runEnded)).type).toBe('run.cancelled');
    await wa.until((e) => e.type === 'session.closed');

    expect(await failure(operator.request('core.shutdown', {}))).toEqual({ code: 'BUSY' });
    await operator.request('core.shutdown', { force: true });
    expect(await t.daemon.closed).toBe('requested');
    // Muy por debajo de lo que se espera a un turno que no cierra (10 s).
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(b.cwd, 'b.txt'))).toBe(false);
  }, 30_000);
});

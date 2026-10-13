import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createConnection, type Socket } from 'net';
import { ProtocolError, encodeMessage } from '../ipc/codec.js';
import { LineDecoder } from '../ipc/framing.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  MAX_MESSAGE_BYTES,
  STRATUM_PROTOCOL_VERSION,
  type ProtocolEvent,
} from '../protocol/index.js';
import { sessionSnapshotSchema } from '../protocol/schemas.js';
import {
  gate,
  idleAgain,
  runEnded,
  startTestDaemon,
  textRound,
  watch,
  type TestDaemon,
} from './daemon.fixtures.js';

/**
 * El plano de control de punta a punta, sin interfaz gráfica:
 *
 *   connect → sessions.open → runs.start → eventos → snapshot → resync → sessions.close
 *
 * con varios clientes a la vez sobre el mismo daemon.
 */

let t: TestDaemon;
afterEach(async () => {
  await t?.stop();
});

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

/** Cliente crudo: un socket y líneas, para lo que un cliente correcto no hace. */
function rawClient(ipcPath: string): {
  socket: Socket;
  send(message: object): void;
  next(match?: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<void>;
} {
  const socket = createConnection(ipcPath);
  const decoder = new LineDecoder(MAX_MESSAGE_BYTES);
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) inbox.push(JSON.parse(line) as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  });
  socket.on('error', () => undefined);
  const closed = new Promise<void>((r) => socket.on('close', () => r()));
  return {
    socket,
    closed,
    send: (message) => void socket.write(encodeMessage(message as never)),
    next: (match = () => true) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('raw client: timeout')), 10_000);
        const check = (): void => {
          const i = inbox.findIndex(match);
          if (i === -1) return void waiters.push(check);
          clearTimeout(timer);
          resolve(inbox.splice(i, 1)[0]!);
        };
        check();
      }),
  };
}

const hello = (token: string, roles = ['observer'], protocol = STRATUM_PROTOCOL_VERSION) => ({
  id: 1,
  method: 'core.hello',
  params: { protocol, token, client: { kind: 'other', name: 'raw', version: '0' }, roles },
});

describe('stratumd — handshake y autorización', () => {
  it('antes de core.hello no funciona ninguna operación', async () => {
    t = await startTestDaemon();
    const raw = rawClient(t.daemon.endpoint.ipcPath);
    raw.send({ id: 1, method: 'core.status', params: {} });
    raw.send({ id: 2, method: 'sessions.open', params: { cwd: t.base } });
    raw.send({ id: 3, method: 'core.shutdown', params: { force: true } });
    for (const id of [1, 2, 3]) {
      expect(await raw.next((m) => m.id === id)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
    expect(t.daemon.liveSessions).toBe(0);
    raw.socket.destroy();
  });

  it('un token incorrecto es UNAUTHORIZED y la conexión se cierra', async () => {
    t = await startTestDaemon();
    const raw = rawClient(t.daemon.endpoint.ipcPath);
    raw.send(hello('0'.repeat(64)));
    const reply = await raw.next();
    expect(reply).toMatchObject({ id: 1, error: { code: 'UNAUTHORIZED' } });
    // Ni el token bueno ni nada interno viaja en el error.
    expect(JSON.stringify(reply)).not.toContain(t.daemon.endpoint.token);
    await raw.closed;
    expect(t.daemon.clients).toHaveLength(0);
  });

  it('una versión de protocolo distinta se rechaza antes de cualquier otro método', async () => {
    t = await startTestDaemon();
    const raw = rawClient(t.daemon.endpoint.ipcPath);
    raw.send(hello(t.daemon.endpoint.token, ['operator'], 99));
    expect(await raw.next()).toMatchObject({
      error: { code: 'PROTOCOL_MISMATCH', data: { protocol: STRATUM_PROTOCOL_VERSION } },
    });
    await raw.closed;
  });

  it('quien no se presenta a tiempo pierde la conexión', async () => {
    t = await startTestDaemon();
    // El plazo real son 5 s; aquí basta con ver que un cliente mudo no cuenta como cliente.
    const raw = rawClient(t.daemon.endpoint.ipcPath);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.daemon.clients).toHaveLength(0);
    raw.socket.destroy();
  });

  it('capacidades reales: observer lee, operator controla, approver aprueba — y nada más', async () => {
    t = await startTestDaemon();
    const cwd = t.project('p', [{ wait: new Promise(() => undefined), then: [] }]);
    const observer = await t.connect(['observer'], 'obs');
    const operator = await t.connect(['operator'], 'op');
    const approver = await t.connect(['approver'], 'appr');
    expect(observer.capabilities).toEqual(['observe']);
    expect(operator.capabilities).toEqual(['observe', 'control']);
    expect(approver.capabilities).toEqual(['observe', 'approve']);

    const { session } = await operator.request('sessions.open', { cwd });
    const sessionId = session.id;
    await operator.request('runs.start', { sessionId, input: 'trabaja' });

    // observer → leer sí, cancelar no.
    expect(await code(observer.request('sessions.get', { sessionId }))).toBe('OK');
    expect(await code(observer.request('runs.cancel', { sessionId }))).toBe('FORBIDDEN');
    expect(await code(observer.request('sessions.close', { sessionId }))).toBe('FORBIDDEN');
    // operator → aprobar no.
    const resolve = { approvalId: 'x', decision: 'approve' } as const;
    expect(await code(operator.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
    // El token no basta para el rol approver: sin clave, no trae la capacidad.
    const unverified = await t.connect(['approver'], 'appr-sin-clave', { approverKey: null });
    expect(unverified.capabilities).toEqual(['observe']);
    expect(await code(unverified.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
    // approver → aprobar le está permitido (no hay nada pendiente: NOT_FOUND, no FORBIDDEN)…
    expect(await code(approver.request('approvals.resolve', resolve))).toBe('NOT_FOUND');
    expect(await code(approver.request('approvals.list', {}))).toBe('OK');
    // …y cancelar no.
    expect(await code(approver.request('runs.cancel', { sessionId }))).toBe('FORBIDDEN');
    // El run sigue intacto después de todos los intentos denegados.
    expect((await observer.request('runs.list', { active: true })).runs).toHaveLength(1);
    // operator → cancelar sí.
    expect(await code(operator.request('runs.cancel', { sessionId }))).toBe('OK');
  });
});

describe('stratumd — varios clientes', () => {
  it('dos observadores ven lo mismo, un operador controla, y que uno se vaya no cambia nada', async () => {
    t = await startTestDaemon();
    const hold = gate();
    const cwd = t.project('p', [
      makeToolCallRound('c1', 'write_file', { path: 'uno.txt', content: 'uno' }),
      {
        wait: hold.wait,
        then: makeToolCallRound('c2', 'write_file', { path: 'dos.txt', content: 'dos' }),
      },
      textRound(['He ', 'terminado', '.']),
    ]);
    const observerA = await t.connect(['observer'], 'A');
    const operatorB = await t.connect(['operator'], 'B');
    const observerC = await t.connect(['observer'], 'C');

    const { session } = await operatorB.request('sessions.open', { cwd });
    expect(session).toMatchObject({ cwd, state: 'idle', host: { kind: 'daemon' }, seq: 1 });
    const a = watch(observerA, session.id);
    const b = watch(operatorB, session.id);
    const c = watch(observerC, session.id);
    await Promise.all([a.untilSnapshot(), b.untilSnapshot(), c.untilSnapshot()]);

    const { run } = await operatorB.request('runs.start', {
      sessionId: session.id,
      input: 'hazlo',
    });
    expect(run).toMatchObject({ sessionId: session.id, status: 'running', input: 'hazlo' });
    // Un segundo turno a la vez no cabe.
    expect(
      await code(operatorB.request('runs.start', { sessionId: session.id, input: 'otro' })),
    ).toBe('BUSY');

    // A media ejecución, A desaparece sin despedirse.
    await a.until((e) => e.type === 'tool.completed');
    const seenByA = a.seqs();
    observerA.close();
    hold.open();

    await Promise.all([b.until(idleAgain), c.until(idleAgain)]);
    // B y C ven exactamente la misma secuencia de estado, con el mismo `seq`.
    expect(c.states()).toEqual(b.states());
    expect(b.seqs()).toEqual(b.seqs().map((_, i) => b.seqs()[0]! + i));
    // Lo que A llegó a ver es un prefijo de eso.
    expect(b.seqs().slice(0, seenByA.length)).toEqual(seenByA);
    expect(b.types()).toEqual([
      'run.started',
      'session.updated',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'message.completed',
      'run.completed',
      'session.updated',
    ]);
    // El texto llegó por fragmentos y, completo, en el evento de estado.
    const text = b.events
      .flatMap((e) => (e.type === 'message.delta' ? [e.data.text] : []))
      .join('');
    expect(text).toBe('He terminado.');
    expect(b.events.find((e) => e.type === 'message.completed')).toMatchObject({
      data: { text: 'He terminado.' },
    });
    // El run terminó de verdad: la marcha de A no lo tocó.
    expect(readFileSync(join(cwd, 'dos.txt'), 'utf-8')).toBe('dos');
    expect((await observerC.request('runs.get', { runId: run.id })).run).toMatchObject({
      status: 'completed',
      stopReason: 'stop',
      counters: { toolCalls: 2, toolErrors: 0 },
    });
    expect((await observerC.request('core.status', {})).clients).toBe(2);
  });

  it('un cliente lento no bloquea a los demás ni al run, y su memoria está acotada', async () => {
    t = await startTestDaemon({ highWaterBytes: 2_000, subscriptionQueue: 16 });
    // Mucho más de lo que absorbe el buffer del canal: 120 salidas de ~8 KB.
    const rounds = [];
    for (let i = 0; i < 120; i++)
      rounds.push(makeToolCallRound(`c${i}`, 'read_file', { path: 'big.txt' }));
    rounds.push(textRound(['listo']));
    const cwd = t.project('p', rounds, { agent: { maxIterations: 200 } });
    writeFileSync(
      join(cwd, 'big.txt'),
      Array.from({ length: 300 }, (_, i) => `linea ${i} ${'x'.repeat(60)}`).join('\n'),
    );
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });

    // Un cliente que se suscribe y deja de leer.
    const slow = rawClient(t.daemon.endpoint.ipcPath);
    slow.send(hello(t.daemon.endpoint.token));
    const helloReply = await slow.next((m) => m.id === 1);
    const slowId = (helloReply.result as { connectionId: number }).connectionId;
    slow.send({
      id: 2,
      method: 'events.subscribe',
      params: { scope: { kind: 'session', sessionId: session.id } },
    });
    await slow.next((m) => m.id === 2);
    await slow.next((m) => m.method === 'snapshot');
    slow.socket.pause();

    const fast = watch(operator, session.id);
    await fast.untilSnapshot();
    const startedAt = Date.now();
    await operator.request('runs.start', { sessionId: session.id, input: 'lee mucho' });
    await fast.until(idleAgain, 30_000);

    // El run acabó entero y el cliente rápido lo vio todo, sin huecos.
    expect(fast.types().filter((type) => type === 'tool.completed')).toHaveLength(120);
    expect(fast.seqs()).toEqual(fast.seqs().map((_, i) => fast.seqs()[0]! + i));
    expect(Date.now() - startedAt).toBeLessThan(25_000);
    // El lento se quedó atrás: su cola no creció sin límite y se le forzó una foto.
    const stats = t.daemon.clientStats(slowId)!;
    expect(stats.queued).toBeLessThanOrEqual(16);
    expect(stats.resyncs).toBeGreaterThanOrEqual(1);

    // Cuando vuelve a leer, lo que recibe es un snapshot coherente con el final.
    slow.socket.resume();
    const fresh = (await slow.next(
      (m) =>
        m.method === 'snapshot' && (m.params as { snapshot: { seq: number } }).snapshot.seq > 2,
    )) as { params: { snapshot: unknown } };
    const snapshot = sessionSnapshotSchema.parse(fresh.params.snapshot);
    expect(snapshot.seq).toBe(fast.seqs().at(-1));
    expect(snapshot.session.state).toBe('idle');
    expect(snapshot.run?.status).toBe('completed');
    slow.socket.destroy();
  }, 60_000);
});

describe('stratumd — snapshots y resincronización', () => {
  it('el snapshot es el estado tras aplicar todos los eventos hasta su seq', async () => {
    t = await startTestDaemon();
    const hold = gate();
    const cwd = t.project('p', [
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a' }),
      { wait: hold.wait, then: textRound(['fin']) },
    ]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const sessionId = session.id;

    // Inicial: recién abierta, solo ha ocurrido `session.opened`.
    const initial = (await operator.request('sessions.get', { sessionId })).snapshot;
    expect(initial).toMatchObject({ seq: 1, run: null, toolCalls: [], partial: { text: '' } });
    expect(initial.session).toMatchObject({ state: 'idle', seq: 1, currentRunId: null });

    const live = watch(operator, sessionId);
    await live.untilSnapshot();
    const { run } = await operator.request('runs.start', { sessionId, input: 'una tool' });
    await live.until((e) => e.type === 'tool.completed');

    // Con el run activo y tras una tool.
    const during = (await operator.request('sessions.get', { sessionId })).snapshot;
    expect(during.run).toMatchObject({ id: run.id, status: 'running', counters: { toolCalls: 1 } });
    expect(during.session).toMatchObject({
      state: 'running',
      currentRunId: run.id,
      seq: during.seq,
    });
    expect(during.toolCalls).toMatchObject([{ id: 'c1', name: 'write_file', state: 'completed' }]);
    // Coherencia: la foto no sabe nada de lo que viene después de su `seq`…
    const seen = live.states().filter((e) => e.seq <= during.seq);
    expect(seen.at(-1)).toMatchObject({ type: 'tool.completed', seq: during.seq });
    // …y un cliente que la adopta sigue exactamente por `seq + 1`.
    const late = await t.connect(['observer'], 'late');
    const joined = watch(late, sessionId);
    const adopted = await joined.untilSnapshot();
    hold.open();
    await joined.until(idleAgain);
    expect(joined.seqs()[0]).toBe(adopted.seq + 1);
    expect(joined.seqs()).toEqual(joined.seqs().map((_, i) => adopted.seq + 1 + i));

    const after = (await operator.request('sessions.get', { sessionId })).snapshot;
    expect(after.seq).toBe(joined.seqs().at(-1));
    expect(after.run).toMatchObject({ id: run.id, status: 'completed' });
    expect(after.session.state).toBe('idle');
    expect(after.partial).toEqual({ text: '', reasoning: '' });
  });

  it('reconectar con sinceSeq reenvía lo perdido sin duplicar; con un hueco mayor que el buffer, snapshot', async () => {
    t = await startTestDaemon({ eventBuffer: 16 });
    const rounds = [];
    for (let i = 0; i < 12; i++) {
      rounds.push(makeToolCallRound(`c${i}`, 'write_file', { path: `f${i}.txt`, content: 'x' }));
    }
    rounds.push(makeTextRound('listo'));
    const cwd = t.project('p', rounds);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const full = watch(operator, session.id);
    await full.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'doce ficheros' });
    await full.until(idleAgain, 30_000);
    const last = full.seqs().at(-1)!;

    // Se «cayó» cuando iba por last - 5: dentro del buffer → reenvío exacto.
    const back = await t.connect(['observer'], 'back');
    const replay = watch(back, session.id, { sinceSeq: last - 5 });
    await replay.until((e) => 'seq' in e && e.seq === last);
    expect(replay.snapshots).toEqual([]);
    expect(replay.seqs()).toEqual([last - 4, last - 3, last - 2, last - 1, last]);
    expect(replay.states()).toEqual(full.states().slice(-5));

    // Se «cayó» al principio: ese hueco ya no cabe en el buffer → foto que sustituye.
    const lost = watch(back, session.id, { sinceSeq: 2 });
    const snapshot = await lost.untilSnapshot();
    expect(snapshot.seq).toBe(last);
    expect(lost.seqs()).toEqual([]);
  }, 60_000);
});

describe('stratumd — operationId', () => {
  it('un reenvío deliberado no lanza otro run; el mismo id con otra petición es un error', async () => {
    t = await startTestDaemon();
    const hold = gate();
    const cwd = t.project('p', [{ wait: hold.wait, then: makeTextRound('hecho') }]);
    const operator = await t.connect(['operator'], 'same-client');
    const { session } = await operator.request('sessions.open', { cwd, operationId: 'open-1' });
    // Reenviar la apertura no abre otra sesión.
    const again = await operator.request('sessions.open', { cwd, operationId: 'open-1' });
    expect(again.session.id).toBe(session.id);
    expect(t.daemon.liveSessions).toBe(1);

    const start = { sessionId: session.id, input: 'una vez', operationId: 'run-1' };
    const first = await operator.request('runs.start', start);
    // El mismo cliente, tras reconectar, reenvía: recibe el run ya conocido (y no BUSY).
    const reconnected = await t.connect(['operator'], 'same-client');
    const second = await reconnected.request('runs.start', start);
    expect(second.run.id).toBe(first.run.id);
    expect(t.provider(cwd).calls).toBe(1);

    // Mismo id, otra petición.
    const conflict = operator.request('runs.start', { ...start, input: 'otra cosa' });
    await expect(conflict).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    // Sin operationId no hay memoria: es una petición nueva, y hay un turno en curso.
    expect(
      await code(operator.request('runs.start', { sessionId: session.id, input: 'una vez' })),
    ).toBe('BUSY');
    hold.open();
    const done = watch(operator, session.id);
    await done.untilSnapshot();
    expect((await operator.request('runs.list', { sessionId: session.id })).runs).toHaveLength(1);
  });
});

describe('stratumd — control de un run', () => {
  it('cancelar con un runId que ya no es el actual es STALE_STATE; el actual se cancela', async () => {
    t = await startTestDaemon();
    const cwd = t.project('p', [
      { wait: new Promise(() => undefined), then: [] },
      makeTextRound('segundo'),
    ]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();
    const { run } = await operator.request('runs.start', {
      sessionId: session.id,
      input: 'no acaba',
    });

    expect(
      await code(operator.request('runs.cancel', { sessionId: session.id, runId: 'run_otro' })),
    ).toBe('STALE_STATE');
    expect(await code(operator.request('runs.cancel', { sessionId: 'sess_nope' }))).toBe(
      'NOT_FOUND',
    );
    await operator.request('runs.cancel', { sessionId: session.id, runId: run.id });
    const ended = (await live.until(runEnded)) as Extract<ProtocolEvent, { type: 'run.cancelled' }>;
    expect(ended).toMatchObject({
      type: 'run.cancelled',
      data: { run: { id: run.id, status: 'cancelled' } },
    });
    await live.until(idleAgain);
    // La sesión sigue viva y admite otro turno.
    const next = await operator.request('runs.start', { sessionId: session.id, input: 'otro' });
    expect(next.run.id).not.toBe(run.id);
    await live.until((e) => e.type === 'run.completed');
  });
});

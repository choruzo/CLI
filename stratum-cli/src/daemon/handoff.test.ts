import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileDiscovery } from '../client/discovery.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  HANDOFF_FORMAT,
  applySessionEvent,
  splitHandoff,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
} from '../protocol/index.js';
import type { ConfirmRequest, DestructiveDecision } from '../agent/types.js';
import {
  cuttableConnector,
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
 * M10 — traspaso de una sesión viva de su anfitrión par (la CLI) a `stratumd`.
 * Misma sesión (id, `seq`, conversación, contexto del agente), un solo
 * anfitrión en cada momento, y nada a medias.
 */

let t: TestDaemon | undefined;
const peers: TestPeer[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
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

/** Tres turnos en el par; el primero deja algo que solo está en el contexto del agente. */
const peerScript = (): Round[] => [
  textRound(['Entendido', ', lo recordaré.']),
  textRound(['Turno dos.']),
  textRound(['Turno tres.']),
];

async function threeTurns(p: TestPeer): Promise<void> {
  await p.run('Mi código secreto de prueba es kiwi');
  await p.run('Segundo turno');
  await p.run('Tercer turno');
}

const SECRET = 'Mi código secreto de prueba es kiwi';

describe('M10 — traspaso de una sesión par en reposo', () => {
  it('par → detach → misma sesión en el daemon; el par se va; Dot la ve; un turno nuevo funciona con el mismo contexto', async () => {
    t = await startTestDaemon();
    const cwd = t.project('proj', [textRound(['Me dijiste: kiwi.'])]);
    const p = await peer(t, 'proj', peerScript());
    expect(p.host.env.cwd).toBe(cwd);
    await threeTurns(p);

    // Un cliente como Dot: sigue la sesión y el conjunto desde antes del traspaso.
    const dot = await t.connect(['operator'], 'dot');
    const w = watch(dot, p.sessionId);
    const before = await w.untilSnapshot();
    expect(before.session.host.kind).toBe('peer');
    expect(before.messages.filter((m) => m.kind === 'user').map((m) => m.text)).toEqual([
      SECRET,
      'Segundo turno',
      'Tercer turno',
    ]);
    const overview: ProtocolEvent[] = [];
    dot.subscribeOverview({ onOverview: () => undefined, onEvent: (e) => overview.push(e) });

    const outcome = await p.detach();
    expect(outcome).toEqual({ status: 'detached' });
    expect(p.handedOff()).toBe(1);
    expect(p.ownership.state).toBe('handed-off');
    expect(p.bridge.handedOff).toBe(true);

    // La misma sesión: un solo `session.updated` con el anfitrión nuevo, sin cerrar ni abrir.
    const changed = (await w.until(
      (e) => e.type === 'session.updated' && e.data.session.host.kind === 'daemon',
    )) as Extract<ProtocolStateEvent, { type: 'session.updated' }>;
    expect(changed.seq).toBe(before.seq + 1);
    expect(w.types()).not.toContain('session.closed');
    expect(w.types()).not.toContain('session.opened');
    const { snapshot: after } = await dot.request('sessions.get', { sessionId: p.sessionId });
    expect(after.session.id).toBe(p.sessionId);
    expect(after.session.host).toEqual({ kind: 'daemon', client: 'daemon', connected: true });
    expect(after.session.state).toBe('idle');
    expect(after.seq).toBe(before.seq + 1);
    // Transcript idéntico.
    expect(after.messages).toEqual(before.messages);
    expect(after.messagesTruncated).toBe(before.messagesTruncated);
    expect(after.run?.id).toBe(before.run?.id);
    expect(after.session.createdAt).toBe(before.session.createdAt);
    expect(after.session.title).toBe(before.session.title);
    // Quien reduce eventos (Dot) llega a lo mismo que la foto del daemon.
    expect(applySessionEvent(before, changed).session.host.kind).toBe('daemon');
    expect(applySessionEvent(before, changed).messages).toEqual(after.messages);
    await until(() =>
      overview.some(
        (e) =>
          e.type === 'session.updated' &&
          e.sessionId === p.sessionId &&
          e.data.session.host.kind === 'daemon',
      ),
    );
    expect(overview.some((e) => e.type === 'session.closed')).toBe(false);

    // El par se va (Ctrl+C, cerrar la terminal): la sesión sigue en el daemon.
    peers.splice(peers.indexOf(p), 1);
    await p.stop();
    await new Promise((r) => setTimeout(r, 300));
    const { sessions } = await dot.request('sessions.list', { live: true });
    expect(sessions.map((s) => s.id)).toEqual([p.sessionId]);
    expect(sessions[0]!.host.kind).toBe('daemon');
    expect(w.types()).not.toContain('session.closed');

    // Un turno nuevo, ya en el daemon: el modelo recibe el contexto de antes.
    const { run } = await dot.request('runs.start', {
      sessionId: p.sessionId,
      input: '¿Qué te dije antes?',
    });
    await w.until((e) => runEnded(e) && e.runId === run.id);
    const seen = t.provider(cwd).userInputs.at(-1)!;
    expect(seen).toContain(SECRET);
    expect(seen).toContain('¿Qué te dije antes?');
    const { snapshot: last } = await dot.request('sessions.get', { sessionId: p.sessionId });
    expect(last.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(last.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'Me dijiste: kiwi.' });
    // Los `seq` siguen sin huecos de punta a punta.
    const seqs = w.seqs();
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  });

  it('sessions.detach desde otro cliente: lo hace el anfitrión; repetirlo no cambia nada', async () => {
    t = await startTestDaemon();
    t.project('remoto', [textRound(['sigo'])]);
    const p = await peer(t, 'remoto', peerScript());
    await p.run('hola');
    const operator = await t.connect(['operator'], 'dot');

    const first = await operator.request('sessions.detach', { sessionId: p.sessionId });
    expect(first.status).toBe('detached');
    expect(first.session.id).toBe(p.sessionId);
    expect(first.session.host.kind).toBe('daemon');
    expect(p.handedOff()).toBe(1);
    expect(p.ownership.state).toBe('handed-off');

    const again = await operator.request('sessions.detach', { sessionId: p.sessionId });
    expect(again.status).toBe('already-daemon');
    expect(again.session.id).toBe(p.sessionId);

    // Solo quien tiene `control`, y solo sobre una sesión que existe.
    const observer = await t.connect(['observer'], 'mira');
    expect(await failure(observer.request('sessions.detach', { sessionId: p.sessionId }))).toEqual(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(await failure(operator.request('sessions.detach', { sessionId: 'sess_nope' }))).toEqual({
      code: 'NOT_FOUND',
    });
  });

  it('una sesión del daemon no se traspasa: ya lo es', async () => {
    t = await startTestDaemon();
    const cwd = t.project('d', []);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const result = await operator.request('sessions.detach', { sessionId: session.id });
    expect(result.status).toBe('already-daemon');
  });
});

describe('M10 — un solo anfitrión (fencing)', () => {
  it('tras el traspaso, el anfitrión anterior no puede publicar, registrarla ni empezar turnos', async () => {
    t = await startTestDaemon();
    t.project('f', []);
    const p = await peer(t, 'f', peerScript());
    await p.run('uno');
    const observer = await t.connect(['observer']);
    const w = watch(observer, p.sessionId);
    const before = await w.untilSnapshot();
    expect((await p.detach()).status).toBe('detached');
    await w.until((e) => e.type === 'session.updated' && e.data.session.host.kind === 'daemon');

    // Otra conexión de anfitrión con lo que sabía el par: rechazada por rancia.
    const stale = await t.connect(['host'], 'viejo-par');
    const snapshot: ProtocolSessionSnapshot = {
      ...before,
      session: { ...before.session, host: { kind: 'peer', client: 'cli', connected: true } },
    };
    expect(await failure(stale.request('host.register', { snapshot }))).toEqual({
      code: 'STALE_STATE',
      reason: 'handed-off',
    });
    const warning: ProtocolStateEvent = {
      type: 'warning',
      sessionId: p.sessionId,
      at: Date.now(),
      seq: before.seq + 1,
      data: { message: 'sigo aquí' },
    };
    expect(
      await failure(
        stale.request('host.publish', { sessionId: p.sessionId, epoch: 1, events: [warning] }),
      ),
    ).toEqual({ code: 'STALE_STATE', reason: 'stale-epoch' });
    expect(
      await failure(
        stale.request('host.handoffBegin', {
          sessionId: p.sessionId,
          epoch: 1,
          seq: before.seq,
          format: HANDOFF_FORMAT,
          chunks: 1,
          chars: 2,
        }),
      ),
    ).toEqual({ code: 'STALE_STATE', reason: 'handed-off' });

    // El runtime del par ya no empieza nada, y lo que hiciera no sale publicado.
    await expect(p.run('¿sigues?')).rejects.toThrow(/handed-off/);
    for await (const ev of p.host.run('a escondidas')) void ev;
    await new Promise((r) => setTimeout(r, 200));
    const { snapshot: now } = await observer.request('sessions.get', { sessionId: p.sessionId });
    expect(now.seq).toBe(before.seq + 1);
    expect(now.messages.some((m) => m.kind === 'user' && m.text === 'a escondidas')).toBe(false);
    expect(w.states().every((e) => e.type !== 'warning')).toBe(true);
  });
});

describe('M10 — fallos: o del par o del daemon, nunca de los dos', () => {
  it('el daemon no puede montarla: el par sigue siendo su anfitrión y sigue trabajando', async () => {
    t = await startTestDaemon();
    // Sin guion para ese directorio: el arranque de la sesión en el daemon falla.
    const p = await peer(t, 'sin-config', [textRound(['uno']), textRound(['dos'])]);
    await p.run('uno');
    const observer = await t.connect(['observer']);
    const w = watch(observer, p.sessionId);
    await w.untilSnapshot();

    const outcome = await p.detach();
    expect(outcome).toMatchObject({ status: 'kept', code: 'NOT_TRANSFERABLE', reason: 'startup' });
    expect(p.ownership.state).toBe('owner');
    expect(p.bridge.handedOff).toBe(false);
    expect(p.handedOff()).toBe(0);
    const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
    expect(snapshot.session.host).toEqual({ kind: 'peer', client: 'cli', connected: true });

    // Y sigue publicando como siempre.
    await p.run('dos');
    await w.until((e) => e.type === 'run.completed' && e.data.run.input === 'dos');
    expect(t.daemon.liveSessions).toBe(0);
  });

  it('un commit que el daemon rechaza de entrada no deja el traspaso a medias: el siguiente funciona', async () => {
    t = await startTestDaemon({ maxSessions: 1 });
    const busyCwd = t.project('ocupa', []);
    t.project('lleno', []);
    const operator = await t.connect(['operator']);
    const { session: occupant } = await operator.request('sessions.open', { cwd: busyCwd });
    const p = await peer(t, 'lleno', [textRound(['uno'])]);
    await p.run('uno');

    expect(await p.detach()).toMatchObject({ status: 'kept', code: 'UNAVAILABLE' });
    expect(p.ownership.state).toBe('owner');
    await operator.request('sessions.close', { sessionId: occupant.id });
    expect((await p.detach()).status).toBe('detached');
  });

  it('el par muere antes de confirmar: no se monta nada y la sesión se descarta como cualquier otra', async () => {
    t = await startTestDaemon({ isAlive: () => false, peerWatchIntervalMs: 50 });
    const cwd = t.project('muere', []);
    const host = await t.connect(['host'], 'par-que-muere');
    const observer = await t.connect(['observer']);
    const snapshot: ProtocolSessionSnapshot = {
      session: {
        id: 'sess_muere',
        title: '',
        cwd,
        host: { kind: 'peer', client: 'cli', connected: true },
        state: 'idle',
        agent: 'general',
        provider: 'test',
        model: 'test-model',
        sessionProfile: 'auto',
        readOnly: false,
        activeTarget: 'local',
        context: { used: 0, max: 0, pct: 0, estimated: true },
        tokens: { total: null, status: 'unavailable' },
        currentRunId: null,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      seq: 1,
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
    const { epoch } = await host.request('host.register', { snapshot, pid: 424242 });
    const text = JSON.stringify(context('sess_muere', cwd));
    const parts = splitHandoff(text, Math.ceil(text.length / 2) + 1);
    expect(parts).toHaveLength(2);
    const { handoffId } = await host.request('host.handoffBegin', {
      sessionId: 'sess_muere',
      epoch,
      seq: 1,
      format: HANDOFF_FORMAT,
      chunks: parts.length,
      chars: text.length,
    });
    await host.request('host.handoffChunk', {
      sessionId: 'sess_muere',
      handoffId,
      index: 0,
      data: parts[0]!,
    });
    host.close();
    await until(
      async () =>
        (await failure(observer.request('sessions.get', { sessionId: 'sess_muere' }))).code ===
        'NOT_FOUND',
    );
    expect(t.daemon.liveSessions).toBe(0);
  });

  it('el par muere con el commit en marcha: el montaje decide, y la sesión queda en el daemon', async () => {
    const hold = gate();
    let held = false;
    t = await startTestDaemon({
      holdStartup: async () => {
        held = true;
        await hold.wait;
      },
    });
    const cwd = t.project('commit', [textRound(['aquí sigo'])]);
    const cut = cuttableConnector();
    const p = await peer(t, 'commit', peerScript(), {
      connector: cut.connector,
      resolveTimeoutMs: 20_000,
    });
    await p.run(SECRET);

    cut.cutAfter('host.handoffCommit');
    const outcome = p.detach();
    await until(() => held);
    // La conexión del par ya cayó; el daemon sigue montando y nadie más puede reclamarla.
    await new Promise((r) => setTimeout(r, 150));
    const other = await t.connect(['host'], 'intruso');
    const { snapshot } = await (
      await t.connect(['observer'])
    ).request('sessions.get', {
      sessionId: p.sessionId,
    });
    expect(snapshot.session.host.kind).toBe('peer');
    expect(await failure(other.request('host.register', { snapshot }))).toEqual({
      code: 'BUSY',
      reason: 'handoff-in-progress',
    });
    hold.open();

    // Resultado desconocido para el par: no reintenta, pregunta, y el daemon dice que es suya.
    expect(await outcome).toEqual({ status: 'detached' });
    expect(p.ownership.state).toBe('handed-off');
    const operator = await t.connect(['operator']);
    const w = watch(operator, p.sessionId);
    await w.untilSnapshot();
    const { run } = await operator.request('runs.start', {
      sessionId: p.sessionId,
      input: '¿Qué te dije antes?',
    });
    await w.until((e) => runEnded(e) && e.runId === run.id);
    expect(t.provider(cwd).userInputs.at(-1)).toContain(SECRET);
  });

  it('resultado desconocido y el daemon no la montó: al reconectar, el par sigue siendo su anfitrión', async () => {
    const hold = gate();
    let held = false;
    t = await startTestDaemon({
      holdStartup: async () => {
        held = true;
        await hold.wait;
      },
    });
    // Sin guion: el arranque fallará al soltarlo.
    const cut = cuttableConnector();
    const p = await peer(t, 'aborta', [textRound(['uno']), textRound(['dos'])], {
      connector: cut.connector,
      resolveTimeoutMs: 20_000,
    });
    await p.run('uno');
    cut.cutAfter('host.handoffCommit');
    const outcome = p.detach();
    await until(() => held);
    await new Promise((r) => setTimeout(r, 150));
    hold.open();

    expect(await outcome).toMatchObject({ status: 'kept' });
    expect(p.ownership.state).toBe('owner');
    const observer = await t.connect(['observer']);
    await until(async () => {
      const { snapshot } = await observer.request('sessions.get', { sessionId: p.sessionId });
      return snapshot.session.host.kind === 'peer' && snapshot.session.host.connected;
    });
    expect(t.daemon.liveSessions).toBe(0);
    // Y vuelve a trabajar, publicado.
    const w = watch(observer, p.sessionId);
    await w.untilSnapshot();
    await p.run('dos');
    await w.until((e) => e.type === 'run.completed' && e.data.run.input === 'dos');
  });

  it('el daemon que la recibió desaparece antes de contestar: nadie más puede alojarla, sigue en el par', async () => {
    const hold = gate();
    let held = false;
    t = await startTestDaemon({
      holdStartup: async () => {
        held = true;
        await hold.wait;
      },
    });
    t.project('cae', []);
    // El daemon de pruebas vive en este proceso: tras `crash()` su pid se da por muerto,
    // como el de un `stratumd` real que se cae.
    let daemonAlive = true;
    const p = await peer(t, 'cae', [textRound(['uno'])], {
      resolveTimeoutMs: 20_000,
      discovery: fileDiscovery({ dir: t.dir, isAlive: () => daemonAlive }),
    });
    await p.run('uno');
    const outcome = p.detach();
    await until(() => held);
    daemonAlive = false;
    await t.daemon.crash();
    expect(await outcome).toMatchObject({ status: 'kept', code: 'UNAVAILABLE' });
    expect(p.ownership.state).toBe('owner');
    hold.open();
  });
});

describe('M10 — qué bloquea un traspaso', () => {
  it('con un run en curso: BUSY (run-active), desde el par y desde otro cliente', async () => {
    t = await startTestDaemon();
    t.project('ocupada', []);
    const release = gate();
    const p = await peer(t, 'ocupada', [{ wait: release.wait, then: makeTextRound('listo') }]);
    const operator = await t.connect(['operator']);
    const turn = p.run('largo');
    await until(() => p.host.agent.pause.state !== 'idle');

    expect(await p.detach()).toMatchObject({ status: 'kept', code: 'BUSY', reason: 'run-active' });
    expect(await failure(operator.request('sessions.detach', { sessionId: p.sessionId }))).toEqual({
      code: 'BUSY',
      reason: 'run-active',
    });
    expect(p.ownership.state).toBe('owner');
    release.open();
    await turn;
    expect((await p.detach()).status).toBe('detached');
  });

  it('con una aprobación pendiente: se rechaza; la solicitud sigue siendo la misma y se resuelve en el par', async () => {
    t = await startTestDaemon();
    t.project('aprob', []);
    let answer: ((d: DestructiveDecision) => void) | null = null;
    const p = await peer(
      t,
      'aprob',
      [makeToolCallRound('c1', 'exec', { command: 'rm victim.txt' }), makeTextRound('hecho')],
      {},
      {
        destructivePolicy: 'ask',
        gates: {
          confirm: (_req: ConfirmRequest) =>
            new Promise<DestructiveDecision>((resolve) => (answer = resolve)),
        },
      },
    );
    writeFileSync(join(p.host.env.cwd, 'victim.txt'), 'x\n');
    const observer = await t.connect(['observer']);
    const w = watch(observer, p.sessionId);
    await w.untilSnapshot();
    const turn = p.run('borra');
    const requested = (await w.until((e) => e.type === 'approval.requested')) as Extract<
      ProtocolStateEvent,
      { type: 'approval.requested' }
    >;

    const operator = await t.connect(['operator']);
    expect(await failure(operator.request('sessions.detach', { sessionId: p.sessionId }))).toEqual({
      code: 'BUSY',
      reason: 'run-active',
    });
    expect(await p.detach()).toMatchObject({ status: 'kept', reason: 'run-active' });
    const { approvals } = await observer.request('approvals.list', { sessionId: p.sessionId });
    expect(approvals.map((a) => a.id)).toEqual([requested.data.approval.id]);

    answer!('deny');
    await turn;
    expect((await p.detach()).status).toBe('detached');
    const after = await observer.request('approvals.list', { sessionId: p.sessionId });
    expect(after.approvals).toEqual([]);
  });

  it('con un job vivo: NOT_TRANSFERABLE (jobs-running); con su final sin ver: inbox-pending', async () => {
    t = await startTestDaemon();
    t.project('job', []);
    const STAY = 'node -e "setInterval(() => {}, 1000)"';
    const p = await peer(t, 'job', [
      makeToolCallRound('c1', 'exec', { command: STAY, background: true }),
      makeTextRound('lanzado'),
      makeTextRound('visto'),
    ]);
    await p.run('lanza un job');
    const jobs = p.host.agent.jobs!;
    expect(jobs.runningCount).toBe(1);
    expect(await p.detach()).toMatchObject({
      status: 'kept',
      code: 'NOT_TRANSFERABLE',
      reason: 'jobs-running',
    });

    await jobs.cancel(jobs.list()[0]!.id);
    expect(await p.detach()).toMatchObject({
      status: 'kept',
      code: 'NOT_TRANSFERABLE',
      reason: 'inbox-pending',
    });
    // Un turno le cuenta al agente cómo acabó: ya se puede.
    await p.run('¿qué pasó?');
    expect((await p.detach()).status).toBe('detached');
  });

  it('un anfitrión que no sabe traspasar (stratum run): NOT_TRANSFERABLE (unsupported-host)', async () => {
    t = await startTestDaemon();
    t.project('run', []);
    const p = await peer(t, 'run', [textRound(['uno'])], {}, { noHandoff: true });
    await p.run('uno');
    expect(await p.detach()).toMatchObject({
      status: 'kept',
      code: 'NOT_TRANSFERABLE',
      reason: 'unsupported-host',
    });
    const operator = await t.connect(['operator']);
    expect(await failure(operator.request('sessions.detach', { sessionId: p.sessionId }))).toEqual({
      code: 'NOT_TRANSFERABLE',
      reason: 'unsupported-host',
    });
  });

  it('sin daemon no hay a quién traspasar', async () => {
    t = await startTestDaemon();
    const p = await peer({ base: t.base, dir: join(t.base, 'otro-daemon') }, 'solo', []);
    expect(await p.detach()).toMatchObject({ status: 'kept', code: 'UNAVAILABLE' });
    expect(p.ownership.state).toBe('owner');
  });
});

describe('M10 — varias sesiones', () => {
  it('traspasar A no toca B', async () => {
    t = await startTestDaemon();
    t.project('a', [textRound(['A en el daemon'])]);
    t.project('b', []);
    const a = await peer(t, 'a', [textRound(['A1'])]);
    const b = await peer(t, 'b', [textRound(['B1']), textRound(['B2'])]);
    await a.run('a uno');
    await b.run('b uno');
    const observer = await t.connect(['observer']);
    const wb = watch(observer, b.sessionId);
    const bBefore = await wb.untilSnapshot();

    expect((await a.detach()).status).toBe('detached');
    expect(b.ownership.state).toBe('owner');
    expect(b.bridge.handedOff).toBe(false);
    await b.run('b dos');
    await wb.until((e) => e.type === 'run.completed' && e.data.run.input === 'b dos');
    const { sessions } = await observer.request('sessions.list', { live: true });
    const kinds = Object.fromEntries(sessions.map((s) => [s.id, s.host.kind]));
    expect(kinds).toEqual({ [a.sessionId]: 'daemon', [b.sessionId]: 'peer' });
    // B no vio nada de A ni ningún cambio de anfitrión.
    expect(wb.states().every((e) => e.sessionId === b.sessionId)).toBe(true);
    expect(
      wb
        .states()
        .some((e) => e.type === 'session.updated' && e.data.session.host.kind === 'daemon'),
    ).toBe(false);
    expect(wb.seqs()[0]).toBe(bBefore.seq + 1);
    void idleAgain;
  });
});

describe('M10 — lo que el daemon valida de un traspaso', () => {
  async function registered(daemon: TestDaemon, id: string, cwd: string) {
    const host = await daemon.connect(['host'], 'par');
    const snapshot = sessionSnapshot(id, cwd);
    const { epoch } = await host.request('host.register', { snapshot, pid: process.pid });
    return { host, epoch, snapshot };
  }

  it('seq, época, orden de los trozos, contexto y dueño', async () => {
    t = await startTestDaemon();
    const cwd = t.project('v', []);
    const { host, epoch } = await registered(t, 'sess_v', cwd);
    const begin = (over: Record<string, unknown> = {}) =>
      host.request('host.handoffBegin', {
        sessionId: 'sess_v',
        epoch,
        seq: 1,
        format: HANDOFF_FORMAT,
        chunks: 1,
        chars: 10,
        ...over,
      });

    expect(await failure(begin({ seq: 0 }))).toEqual({ code: 'STALE_STATE', reason: 'changed' });
    expect(await failure(begin({ epoch: epoch + 1 }))).toEqual({
      code: 'STALE_STATE',
      reason: 'stale-epoch',
    });
    const intruder = await t.connect(['host'], 'otro');
    expect(
      (
        await failure(
          intruder.request('host.handoffBegin', {
            sessionId: 'sess_v',
            epoch,
            seq: 1,
            format: HANDOFF_FORMAT,
            chunks: 1,
            chars: 10,
          }),
        )
      ).code,
    ).toBe('FORBIDDEN');

    // Fuera de orden: invalida el traspaso.
    let { handoffId } = await begin({ chunks: 2 });
    expect(await failure(begin())).toEqual({ code: 'BUSY', reason: 'handoff-in-progress' });
    expect(
      (
        await failure(
          host.request('host.handoffChunk', {
            sessionId: 'sess_v',
            handoffId,
            index: 1,
            data: 'x',
          }),
        )
      ).code,
    ).toBe('INVALID_PARAMS');

    // Un contexto que no es JSON, o que no es el de esa sesión: no transferible.
    ({ handoffId } = await begin({ chars: 10 }));
    await host.request('host.handoffChunk', {
      sessionId: 'sess_v',
      handoffId,
      index: 0,
      data: '{no-json}!',
    });
    expect(
      await failure(host.request('host.handoffCommit', { sessionId: 'sess_v', handoffId })),
    ).toEqual({ code: 'NOT_TRANSFERABLE', reason: 'context' });

    const foreign = JSON.stringify(context('sess_otra', cwd));
    ({ handoffId } = await begin({ chars: foreign.length }));
    await host.request('host.handoffChunk', {
      sessionId: 'sess_v',
      handoffId,
      index: 0,
      data: foreign,
    });
    expect(
      await failure(host.request('host.handoffCommit', { sessionId: 'sess_v', handoffId })),
    ).toEqual({ code: 'NOT_TRANSFERABLE', reason: 'context' });

    // Abortar lo suyo deja empezar otro; el bueno se monta.
    const good = JSON.stringify(context('sess_v', cwd));
    ({ handoffId } = await begin({ chars: good.length }));
    await host.request('host.handoffAbort', { sessionId: 'sess_v', handoffId });
    ({ handoffId } = await begin({ chars: good.length }));
    await host.request('host.handoffChunk', {
      sessionId: 'sess_v',
      handoffId,
      index: 0,
      data: good,
    });
    const committed = await host.request('host.handoffCommit', { sessionId: 'sess_v', handoffId });
    expect(committed.session.host.kind).toBe('daemon');
    expect(committed.epoch).toBe(epoch + 1);
    expect(t.daemon.liveSessions).toBe(1);
  });
});

function sessionSnapshot(id: string, cwd: string): ProtocolSessionSnapshot {
  return {
    session: {
      id,
      title: '',
      cwd,
      host: { kind: 'peer', client: 'cli', connected: true },
      state: 'idle',
      agent: 'general',
      provider: 'test',
      model: 'test-model',
      sessionProfile: 'auto',
      readOnly: false,
      activeTarget: 'local',
      context: { used: 0, max: 0, pct: 0, estimated: true },
      tokens: { total: null, status: 'unavailable' },
      currentRunId: null,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    seq: 1,
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
}

function context(sessionId: string, cwd: string) {
  return {
    format: HANDOFF_FORMAT,
    sessionId,
    cwd,
    provider: 'test',
    model: 'test-model',
    agent: null,
    readOnly: false,
    sessionProfile: 'auto',
    planRef: null,
    usage: { toolCalls: 0, tokens: null, tokenStatus: 'unavailable' },
    messages: [
      { role: 'system', content: 'eres un agente' },
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hola' },
    ],
  };
}

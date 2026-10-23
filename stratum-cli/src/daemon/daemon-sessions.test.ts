import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { ProtocolEvent } from '../protocol/index.js';
import {
  gate,
  idleAgain,
  startTestDaemon,
  watch,
  type Round,
  type TestDaemon,
} from './daemon.fixtures.js';

/**
 * La versión daemon de AC-0: varias sesiones alojadas a la vez, cada una dueña
 * de lo suyo, y un ciclo de vida en el que cerrar una sesión no es cerrar el
 * proceso.
 */

let t: TestDaemon;
afterEach(async () => {
  await t?.stop();
});

const node = (script: string): string => `node -e "${script}"`;
const PRINT_CWD = node('console.log(process.cwd())');
const PRINT_ENV = node('console.log(process.env.STRATUMD_TEST, process.env.CLIENT_SECRET)');
const STAY_ALIVE = node('setInterval(() => {}, 1000)');

const samePath = (text: string, path: string): boolean =>
  text.replace(/\\/g, '/').toLowerCase().includes(path.replace(/\\/g, '/').toLowerCase());

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

function outputs(events: ProtocolEvent[]): string[] {
  expect(events.filter((e) => e.type === 'tool.failed').map((e) => e.data.call.error)).toEqual([]);
  return events.flatMap((e) => (e.type === 'tool.completed' ? [e.data.call.output ?? ''] : []));
}

/** Mira dónde está, lee el entorno, escribe un fichero y deja un job corriendo. */
function script(name: string, hold: Promise<unknown>): Round[] {
  return [
    makeToolCallRound('c1', 'exec', { command: PRINT_CWD }),
    makeToolCallRound('c2', 'exec', { command: PRINT_ENV }),
    makeToolCallRound('c3', 'write_file', { path: 'nota.txt', content: `soy ${name}` }),
    makeToolCallRound('c4', 'exec', { command: STAY_ALIVE, background: true }),
    { wait: hold, then: makeTextRound(`listo ${name}`) },
    // Segundo turno.
    makeToolCallRound('c5', 'exec', { command: PRINT_CWD }),
    makeTextRound('sigo aquí'),
  ];
}

describe('stratumd — varias sesiones', () => {
  it('dos sesiones a la vez: seq, estado, tools, snapshots y cierre independientes', async () => {
    t = await startTestDaemon();
    const holdA = gate();
    const holdB = gate();
    const cwdA = t.project('a', script('a', holdA.wait));
    const cwdB = t.project('b', script('b', holdB.wait));
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);

    // `env` está reservado: se acepta, no se usa y no vuelve por ningún camino.
    const openA = await operator.request('sessions.open', {
      cwd: cwdA,
      env: { CLIENT_SECRET: 'no-debe-verse' },
    });
    const openB = await operator.request('sessions.open', { cwd: cwdB });
    const a = openA.session.id;
    const b = openB.session.id;
    expect(a).not.toBe(b);
    expect(JSON.stringify(openA)).not.toContain('no-debe-verse');

    const onA = watch(observer, a);
    const onB = watch(observer, b);
    await Promise.all([onA.untilSnapshot(), onB.untilSnapshot()]);
    const overview: string[] = [];
    observer.subscribeOverview({
      onOverview: () => undefined,
      onEvent: (e) => overview.push(`${e.sessionId === a ? 'a' : 'b'}:${e.type}`),
    });

    // --- Los dos turnos a la vez. ---
    const [runA, runB] = await Promise.all([
      operator.request('runs.start', { sessionId: a, input: 'trabaja' }),
      operator.request('runs.start', { sessionId: b, input: 'trabaja' }),
    ]);
    expect(runA.run.id).not.toBe(runB.run.id);
    await Promise.all([
      onA.until((e) => e.type === 'job.started'),
      onB.until((e) => e.type === 'job.started'),
    ]);

    // `seq` independiente: cada sesión cuenta lo suyo desde 1, sin huecos.
    expect(onA.seqs()).toEqual(onA.seqs().map((_, i) => 2 + i));
    expect(onB.seqs()).toEqual(onB.seqs().map((_, i) => 2 + i));
    // Ningún evento de A termina en B, ni al revés.
    expect(onA.events.every((e) => e.sessionId === a)).toBe(true);
    expect(onB.events.every((e) => e.sessionId === b)).toBe(true);
    expect(onA.events.every((e) => !e.runId || e.runId === runA.run.id)).toBe(true);

    // Tools independientes: cada una en su directorio, con el entorno del daemon.
    const outA = outputs(onA.events);
    const outB = outputs(onB.events);
    expect(samePath(outA[0]!, cwdA)).toBe(true);
    expect(samePath(outB[0]!, cwdB)).toBe(true);
    expect(samePath(outA[0]!, cwdB)).toBe(false);
    expect(outA[1]).toContain('daemon-env undefined');
    expect(readFileSync(join(cwdA, 'nota.txt'), 'utf-8')).toBe('soy a');
    expect(readFileSync(join(cwdB, 'nota.txt'), 'utf-8')).toBe('soy b');
    expect(JSON.stringify(onA.events)).not.toContain('no-debe-verse');

    // Estados y snapshots independientes.
    const [snapA, snapB] = await Promise.all([
      observer.request('sessions.get', { sessionId: a }),
      observer.request('sessions.get', { sessionId: b }),
    ]);
    expect(snapA.snapshot.session).toMatchObject({ id: a, cwd: cwdA, state: 'running' });
    expect(snapB.snapshot.session).toMatchObject({ id: b, cwd: cwdB, state: 'running' });
    expect(snapA.snapshot.run?.id).toBe(runA.run.id);
    expect(snapB.snapshot.run?.id).toBe(runB.run.id);
    expect(snapA.snapshot.jobs).toMatchObject([{ status: 'running', sessionId: a }]);
    expect(samePath(snapB.snapshot.jobs[0]!.cwd, cwdB)).toBe(true);
    expect((await observer.request('sessions.list', {})).sessions.map((s) => s.id).sort()).toEqual(
      [a, b].sort(),
    );
    expect((await observer.request('core.status', {})).activeRuns).toBe(2);

    // --- Cerrar A, con su turno y su job en marcha. ---
    await operator.request('sessions.close', { sessionId: a });
    // A terminó por su propio camino: su run cancelado, su job cancelado, y
    // `session.closed` como último evento.
    await onA.until((e) => e.type === 'session.closed');
    expect(onA.types().at(-1)).toBe('session.closed');
    expect(onA.types()).toContain('run.cancelled');
    expect(onA.states().find((e) => e.type === 'job.ended')).toMatchObject({
      data: { job: { status: 'cancelled' } },
    });
    expect(await code(observer.request('sessions.get', { sessionId: a }))).toBe('NOT_FOUND');
    // El cierre de una sesión no es el del proceso.
    expect(t.teardowns()).toBe(0);

    // B ni se ha enterado: su job sigue vivo, su turno termina y admite otro.
    expect((await observer.request('jobs.list', { sessionId: b })).jobs).toMatchObject([
      { status: 'running' },
    ]);
    holdB.open();
    await onB.until(idleAgain);
    const before = onB.events.length;
    await operator.request('runs.start', { sessionId: b, input: '¿sigues ahí?' });
    await onB.until((e) => e.type === 'run.completed' && onB.events.indexOf(e) >= before);
    expect(samePath(outputs(onB.events.slice(before))[0]!, cwdB)).toBe(true);
    expect(onB.types()).not.toContain('session.closed');
    expect(onB.events.every((e) => e.sessionId === b)).toBe(true);
    expect((await observer.request('sessions.list', {})).sessions.map((s) => s.id)).toEqual([b]);
    expect(overview).toContain('a:session.closed');
    expect(overview.filter((e) => e.startsWith('b:')).every((e) => e !== 'b:session.closed')).toBe(
      true,
    );

    // --- Apagar el daemon: ahora sí, limpieza global, una vez. ---
    await t.daemon.shutdown();
    expect(t.teardowns()).toBe(1);
    expect(onB.states().at(-1)).toMatchObject({
      type: 'session.closed',
      data: { reason: 'server-shutdown' },
    });
    expect(onB.states().find((e) => e.type === 'job.ended')).toBeDefined();
    expect(existsSync(join(t.dir, 'endpoint.json'))).toBe(false);
    // Lanza y cancela procesos reales (en Windows cada cancelación barre el árbol).
  }, 90_000);

  it('que el cliente que la abrió se vaya no toca la sesión ni su run', async () => {
    t = await startTestDaemon();
    const hold = gate();
    const cwd = t.project('p', [{ wait: hold.wait, then: makeTextRound('acabé sin ti') }]);
    const opener = await t.connect(['operator'], 'opener');
    const { session } = await opener.request('sessions.open', { cwd });
    const { run } = await opener.request('runs.start', { sessionId: session.id, input: 'sigue' });
    opener.close();
    await new Promise((r) => setTimeout(r, 50));
    // Sin ningún cliente conectado, la sesión y el run siguen vivos.
    expect(t.daemon.clients).toHaveLength(0);
    expect(t.daemon.liveSessions).toBe(1);

    const later = await t.connect(['observer'], 'later');
    expect((await later.request('sessions.list', { live: true })).sessions).toMatchObject([
      { id: session.id, state: 'running', currentRunId: run.id },
    ]);
    const live = watch(later, session.id);
    await live.untilSnapshot();
    hold.open();
    await live.until(idleAgain);
    expect((await later.request('runs.get', { runId: run.id })).run.status).toBe('completed');
    expect(live.events.find((e) => e.type === 'message.completed')).toMatchObject({
      data: { text: 'acabé sin ti' },
    });
  });

  it('sessions.open valida sin montar nada', async () => {
    t = await startTestDaemon();
    const cwd = t.project('p', [makeTextRound('hola')]);
    const operator = await t.connect(['operator']);
    expect(await code(operator.request('sessions.open', { cwd: 'relativo/dir' }))).toBe(
      'INVALID_PARAMS',
    );
    expect(await code(operator.request('sessions.open', { cwd: join(t.base, 'no-existe') }))).toBe(
      'INVALID_PARAMS',
    );
    expect(await code(operator.request('sessions.open', { cwd, resume: 'sess_x' }))).toBe(
      'INVALID_PARAMS',
    );
    expect(await code(operator.request('sessions.open', { resume: 'sess_x' }))).toBe('NOT_FOUND');
    expect(await code(operator.request('sessions.open', { cwd, agent: 'no-existe' }))).toBe(
      'INVALID_PARAMS',
    );
    expect(t.daemon.liveSessions).toBe(0);
    expect((await operator.request('sessions.list', {})).sessions).toEqual([]);
  });

  it('cambiar de provider con el modelo; un alias desconocido no toca la sesión', async () => {
    t = await startTestDaemon();
    const provider = {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
        },
        otro: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:2/v1',
          apiKey: '',
          model: 'otro-base',
        },
      },
    };
    const cwd = t.project('p', [], { provider });
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    expect(session.provider).toBe('test');

    const changed = await operator.request('sessions.setModel', {
      sessionId: session.id,
      provider: 'otro',
      model: 'otro-grande',
    });
    expect(changed.session).toMatchObject({ provider: 'otro', model: 'otro-grande' });

    const unknown = operator.request('sessions.setModel', {
      sessionId: session.id,
      provider: 'no-existe',
      model: 'x',
    });
    expect(await code(unknown)).toBe('INVALID_PARAMS');
    const { snapshot } = await operator.request('sessions.get', { sessionId: session.id });
    expect(snapshot.session).toMatchObject({ provider: 'otro', model: 'otro-grande' });
  });

  it('cambiar modelo y read-only se publica, y no se puede con un turno en curso', async () => {
    t = await startTestDaemon();
    const cwd = t.project('p', [{ wait: new Promise(() => undefined), then: [] }]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();

    const changed = await operator.request('sessions.setModel', {
      sessionId: session.id,
      model: 'otro-modelo',
    });
    expect(changed.session.model).toBe('otro-modelo');
    const ro = await operator.request('sessions.setReadOnly', {
      sessionId: session.id,
      readOnly: true,
    });
    expect(ro.session.readOnly).toBe(true);
    await live.until(
      (e) =>
        e.type === 'session.updated' &&
        e.data.session.readOnly &&
        e.data.session.model === 'otro-modelo',
    );

    await operator.request('runs.start', { sessionId: session.id, input: 'no acaba' });
    const busy = operator.request('sessions.setModel', { sessionId: session.id, model: 'x' });
    expect(await code(busy)).toBe('BUSY');
    expect(await operator.request('runs.pause', { sessionId: session.id })).toEqual({
      status: 'requested',
    });
  });
});

describe('stratumd — servers MCP', () => {
  it('cada sesión lanza sus servers MCP en su propio cwd, no en el del daemon', async () => {
    t = await startTestDaemon();
    const server = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'tools',
      'mcp',
      'fixtures',
      'test-mcp-server.mjs',
    );
    const mcp = {
      mcp: { servers: [{ name: 'probe', command: process.execPath, args: [server] }] },
    };
    const rounds = (): Round[] => [
      makeToolCallRound('c1', 'mcp__probe__cwd', {}),
      makeTextRound('visto'),
    ];
    const cwdA = t.project('mcp-a', rounds(), mcp);
    const cwdB = t.project('mcp-b', rounds(), mcp);
    const operator = await t.connect(['operator']);
    const [a, b] = await Promise.all([
      operator.request('sessions.open', { cwd: cwdA }),
      operator.request('sessions.open', { cwd: cwdB }),
    ]);
    const onA = watch(operator, a.session.id);
    const onB = watch(operator, b.session.id);
    await Promise.all([onA.untilSnapshot(), onB.untilSnapshot()]);
    await Promise.all([
      operator.request('runs.start', { sessionId: a.session.id, input: 'dónde estás' }),
      operator.request('runs.start', { sessionId: b.session.id, input: 'dónde estás' }),
    ]);
    await Promise.all([onA.until(idleAgain), onB.until(idleAgain)]);

    const [whereA] = outputs(onA.events);
    const [whereB] = outputs(onB.events);
    expect(samePath(whereA!, cwdA)).toBe(true);
    expect(samePath(whereB!, cwdB)).toBe(true);
    expect(samePath(whereA!, process.cwd())).toBe(false);
  }, 60_000);
});

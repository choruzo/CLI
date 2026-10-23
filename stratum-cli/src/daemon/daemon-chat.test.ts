import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  EMPTY_TRANSCRIPT,
  applySessionEvent,
  applyTranscriptEvent,
  type ProtocolSessionSnapshot,
} from '../protocol/index.js';
import { RESULTS } from '../protocol/schemas.js';
import {
  gate,
  idleAgain,
  startTestDaemon,
  testConfig,
  watch,
  type TestDaemon,
} from './daemon.fixtures.js';

/**
 * M7: una conversación de varios turnos con una sesión del daemon, conducida
 * solo por el protocolo —`sessions.open`, `runs.start`— y reconstruida desde
 * lo que publica su anfitrión: la conversación va en la foto.
 */

let t: TestDaemon;
afterEach(async () => {
  await t?.stop();
});

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

const kinds = (s: ProtocolSessionSnapshot): string[] => s.messages.map((m) => m.kind);
const texts = (s: ProtocolSessionSnapshot): string[] =>
  s.messages.flatMap((m) => (m.kind === 'user' || m.kind === 'assistant' ? [m.text] : []));

describe('stratumd — chat sobre una sesión del daemon', () => {
  it('varios turnos en la misma sesión: la conversación está en la foto y sale igual de los eventos', async () => {
    t = await startTestDaemon();
    const cwd = t.project('chat', [
      makeToolCallRound('c1', 'write_file', { path: 'hello.txt', content: 'hola' }),
      makeTextRound('Creado hello.txt.'),
      makeTextRound('Dice «hola».'),
    ]);
    const operator = await t.connect(['operator'], 'dot');
    const { session } = await operator.request('sessions.open', { cwd });
    expect(session).toMatchObject({ cwd, state: 'idle', host: { kind: 'daemon' } });

    const live = watch(operator, session.id, { volatile: true });
    const first = await live.untilSnapshot();
    expect(first.messages).toEqual([]);
    expect(first.messagesTruncated).toBe(false);

    const one = await operator.request('runs.start', {
      sessionId: session.id,
      input: 'crea hello.txt con hola',
    });
    expect(one.run.status).toBe('running');
    await live.until(idleAgain);
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf-8')).toBe('hola');

    // Segundo mensaje: otro run de la **misma** sesión, con el contexto del primero.
    const idleSeq = live.states().at(-1)!.seq;
    const two = await operator.request('runs.start', {
      sessionId: session.id,
      input: '¿qué dice el fichero?',
    });
    expect(two.run.id).not.toBe(one.run.id);
    expect(two.run.sessionId).toBe(session.id);
    await live.until((e) => idleAgain(e) && 'seq' in e && e.seq > idleSeq);
    const provider = t.provider(cwd);
    expect(provider.userInputs.at(-1)).toEqual(
      expect.arrayContaining(['crea hello.txt con hola', '¿qué dice el fichero?']),
    );

    // Un cliente que llega ahora (Dot recién abierto) lo ve todo en la foto.
    const late = await t.connect(['observer'], 'late');
    const { snapshot } = await late.request('sessions.get', { sessionId: session.id });
    expect(kinds(snapshot)).toEqual(['user', 'tool', 'assistant', 'user', 'assistant']);
    expect(texts(snapshot)).toEqual([
      'crea hello.txt con hola',
      'Creado hello.txt.',
      '¿qué dice el fichero?',
      'Dice «hola».',
    ]);
    expect(snapshot.messages[1]).toMatchObject({
      kind: 'tool',
      name: 'write_file',
      state: 'completed',
      runId: one.run.id,
    });
    expect(snapshot.messages[4]).toMatchObject({ runId: two.run.id });
    // De la tool viaja su resumen (el mismo que en `tool.started`), acotado; su salida, no.
    const tool = snapshot.messages[1]!;
    expect(Object.keys(tool).sort()).toEqual(
      ['at', 'callId', 'description', 'id', 'kind', 'name', 'runId', 'state'].sort(),
    );
    const started = live.events.find((e) => e.type === 'tool.started');
    expect(tool.kind === 'tool' && tool.description).toBe(
      started?.type === 'tool.started' && started.data.call.description,
    );
    const done = live.events.find((e) => e.type === 'tool.completed');
    const output = done?.type === 'tool.completed' ? (done.data.call.output ?? '') : '';
    expect(output.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.messages)).not.toContain(JSON.stringify(output).slice(1, -1));

    // Quien siguió los eventos llega a lo mismo, sin pedir la foto.
    const reduced = live.events.reduce(applySessionEvent, first);
    expect(reduced.messages).toEqual(snapshot.messages);
    expect(live.states().reduce(applyTranscriptEvent, EMPTY_TRANSCRIPT).messages).toEqual(
      snapshot.messages,
    );
    // Y el texto llegó también por fragmentos, que no son la autoridad.
    expect(live.events.some((e) => e.type === 'message.delta')).toBe(true);
  });

  it('un run a la vez por sesión, también en pausa; y contra una sesión que no existe, NOT_FOUND', async () => {
    t = await startTestDaemon();
    const hold = gate();
    const cwd = t.project('busy', [
      makeToolCallRound('c1', 'exec', { command: 'node -e "0"' }),
      { wait: hold.wait, then: makeTextRound('fin') },
    ]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();

    await operator.request('runs.start', { sessionId: session.id, input: 'uno' });
    const second = operator.request('runs.start', { sessionId: session.id, input: 'dos' });
    expect(await failure(second)).toBe('BUSY');

    await operator.request('runs.pause', { sessionId: session.id });
    await live.until((e) => e.type === 'run.updated' && e.data.run.status === 'paused');
    // En pausa hay un run: un mensaje nuevo no abre otro. Para eso está el steering.
    const paused = operator.request('runs.start', { sessionId: session.id, input: 'tres' });
    expect(await failure(paused)).toBe('BUSY');
    expect(
      await operator.request('runs.steer', { sessionId: session.id, text: 'mejor así' }),
    ).toEqual({ status: 'accepted' });
    await operator.request('runs.resume', { sessionId: session.id });
    hold.open();
    await live.until(idleAgain);

    const { snapshot } = await operator.request('sessions.get', { sessionId: session.id });
    // Un solo turno de usuario: ni «dos» ni «tres» existieron.
    expect(snapshot.messages.filter((m) => m.kind === 'user')).toHaveLength(1);

    const ghost = operator.request('runs.start', { sessionId: 'ses_no_existe', input: 'hola' });
    expect(await failure(ghost)).toBe('NOT_FOUND');
  });

  it('dos chats a la vez no se cruzan, y cerrar uno no toca al otro', async () => {
    t = await startTestDaemon();
    const holdB = gate();
    const cwdA = t.project('a', [makeTextRound('soy A'), makeTextRound('sigo siendo A')]);
    const cwdB = t.project('b', [{ wait: holdB.wait, then: makeTextRound('soy B') }]);
    const operator = await t.connect(['operator']);
    const [a, b] = await Promise.all([
      operator.request('sessions.open', { cwd: cwdA }),
      operator.request('sessions.open', { cwd: cwdB }),
    ]);
    const onA = watch(operator, a.session.id);
    const onB = watch(operator, b.session.id);
    await Promise.all([onA.untilSnapshot(), onB.untilSnapshot()]);

    await Promise.all([
      operator.request('runs.start', { sessionId: a.session.id, input: 'hola A' }),
      operator.request('runs.start', { sessionId: b.session.id, input: 'hola B' }),
    ]);
    await onA.until(idleAgain);
    // A terminó y B sigue en su turno: se cierra A.
    await operator.request('sessions.close', { sessionId: a.session.id });
    holdB.open();
    await onB.until(idleAgain);

    const snapB = (await operator.request('sessions.get', { sessionId: b.session.id })).snapshot;
    expect(texts(snapB)).toEqual(['hola B', 'soy B']);
    expect(snapB.session.cwd).toBe(cwdB);
    const reducedA = onA.events.reduce(applySessionEvent, onA.snapshots[0]!);
    expect(texts(reducedA)).toEqual(['hola A', 'soy A']);
    expect(t.teardowns()).toBe(0);
    expect((await operator.request('sessions.list', {})).sessions.map((s) => s.id)).toEqual([
      b.session.id,
    ]);
  });

  it('un turno cancelado queda en la conversación como lo que es', async () => {
    t = await startTestDaemon();
    const cwd = t.project('stop', [{ wait: new Promise(() => undefined), then: [] }]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'no acabes' });
    await operator.request('runs.cancel', { sessionId: session.id });
    await live.until(idleAgain);
    const { snapshot } = await operator.request('sessions.get', { sessionId: session.id });
    expect(kinds(snapshot)).toEqual(['user', 'outcome']);
    expect(snapshot.messages[1]).toMatchObject({ kind: 'outcome', status: 'cancelled' });
  });
});

describe('stratumd — abrir una sesión desde un cliente', () => {
  it('sin cwd usa el directorio por defecto del daemon; lo que pide el cliente se valida aquí', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-chat-')));
    try {
      const home = join(base, 'home');
      t = await startTestDaemon({ base, defaultCwd: home });
      const operator = await t.connect(['operator']);
      // El directorio por defecto tampoco se da por bueno sin comprobarlo.
      expect(await failure(operator.request('sessions.open', {}))).toBe('INVALID_PARAMS');

      t.project('home', [makeTextRound('hola')]);
      const { session } = await operator.request('sessions.open', {});
      expect(session.cwd).toBe(home);

      // Un fichero no es un directorio, y una ruta relativa no dice dónde.
      writeFileSync(join(home, 'nota.txt'), 'x');
      for (const cwd of [join(home, 'nota.txt'), 'home', join(base, 'no-existe')]) {
        expect(await failure(operator.request('sessions.open', { cwd })), cwd).toBe(
          'INVALID_PARAMS',
        );
      }
      expect(t.daemon.liveSessions).toBe(1);
    } finally {
      await t?.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('respeta daemon.maxSessions y no deja una sesión a medias', async () => {
    t = await startTestDaemon({ maxSessions: 1 });
    const cwdA = t.project('a', [makeTextRound('a')]);
    const cwdB = t.project('b', [makeTextRound('b')]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd: cwdA });
    const over = operator.request('sessions.open', { cwd: cwdB });
    await expect(over).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(t.daemon.liveSessions).toBe(1);
    // Al cerrar una, cabe otra.
    await operator.request('sessions.close', { sessionId: session.id });
    expect((await operator.request('sessions.open', { cwd: cwdB })).session.cwd).toBe(cwdB);
  });

  it('abrir e iniciar un run exigen `control`: ni observar, ni alojar, ni aprobar bastan', async () => {
    t = await startTestDaemon();
    const cwd = t.project('p', [makeTextRound('hola')]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    for (const roles of [['observer'], ['host'], ['approver'], ['host', 'operator']] as const) {
      const client = await t.connect([...roles], `intruso-${roles.join('+')}`);
      const open = client.request('sessions.open', { cwd });
      const start = client.request('runs.start', { sessionId: session.id, input: 'hola' });
      expect(await failure(open), roles.join('+')).toBe('FORBIDDEN');
      expect(await failure(start), roles.join('+')).toBe('FORBIDDEN');
    }
    expect(t.daemon.liveSessions).toBe(1);
    expect(t.provider(cwd).calls).toBe(0);
  });

  it('`env` del cliente no llega a la sesión, y un campo desconocido invalida la petición', async () => {
    t = await startTestDaemon();
    const cwd = t.project('env', [
      makeToolCallRound('c1', 'exec', {
        command: 'node -e "console.log(process.env.STRATUMD_TEST, process.env.FROM_CLIENT)"',
      }),
      makeTextRound('visto'),
    ]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', {
      cwd,
      env: { FROM_CLIENT: 'webview' },
    });
    expect(JSON.stringify(session)).not.toContain('webview');
    const live = watch(operator, session.id);
    await live.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'mira el entorno' });
    await live.until(idleAgain);
    const done = live.events.find((e) => e.type === 'tool.completed');
    expect(done?.type === 'tool.completed' && done.data.call.output).toContain(
      'daemon-env undefined',
    );
    const unknown = operator.request('sessions.open', { cwd, secrets: { a: 'b' } } as never);
    expect(await failure(unknown)).toBe('INVALID_PARAMS');
  });
});

describe('stratumd — agentes y modelos para quien abre una sesión', () => {
  it('models.list da alias e ids, marca el default y no lleva nada del provider', async () => {
    t = await startTestDaemon();
    const observer = await t.connect(['observer']);
    const result = await observer.request('models.list', {});
    // El backend de pruebas no contesta: el modelo configurado se ofrece igual.
    expect(result.models).toEqual([
      { provider: 'test', id: 'test-model', contextWindow: null, default: true },
    ]);
    expect(result.error).toContain('test');
    const wire = JSON.stringify(result);
    for (const secret of ['127.0.0.1', 'baseUrl', 'apiKey', 'http']) {
      expect(wire, secret).not.toContain(secret);
    }
    expect(RESULTS['models.list'].safeParse(result).success).toBe(true);
    await expect(observer.request('models.list', { provider: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('agents.list da los perfiles de un directorio sin su prompt', async () => {
    t = await startTestDaemon();
    const cwd = t.project('agents', []);
    const observer = await t.connect(['observer']);
    await expect(observer.request('agents.list', { cwd: 'relativo' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    const { agents } = await observer.request('agents.list', { cwd });
    expect(agents.map((a) => a.name)).toContain('general');
    for (const agent of agents) {
      expect(Object.keys(agent).sort()).toEqual(
        expect.not.arrayContaining(['prompt', 'body', 'source', 'path']),
      );
    }
  });

  it('skills.list da las skills de un agente sin ruta ni cuerpo', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-skills-')));
    t = await startTestDaemon({ base, config: testConfig(base, { skills: { enabled: true } }) });
    const cwd = t.project('skills', []);
    mkdirSync(join(cwd, '.stratum', 'skills', 'deploy'), { recursive: true });
    writeFileSync(
      join(cwd, '.stratum', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Publicar una release\n---\nCUERPO',
    );
    writeFileSync(join(cwd, '.stratumrc.json'), JSON.stringify({ skills: { enabled: true } }));
    const observer = await t.connect(['observer']);

    // Las de código dependen del proyecto: sin `cwd`, o relativo, no hay lista.
    for (const params of [{}, { cwd: 'relativo' }, { agent: 'general' }]) {
      await expect(observer.request('skills.list', params)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }

    const coding = await observer.request('skills.list', { cwd });
    expect(RESULTS['skills.list'].safeParse(coding).success).toBe(true);
    const names = coding.skills.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['deploy', 'stratum-project-memory']));
    expect(names).not.toContain('stratum-global-memory');
    expect(coding.skills.find((s) => s.name === 'deploy')).toMatchObject({
      scope: 'project',
      presets: ['coding'],
    });
    const wire = JSON.stringify(coding);
    for (const leak of ['CUERPO', 'SKILL.md', cwd]) expect(wire, leak).not.toContain(leak);

    // El asistente: solo las de serie que declaran `assistant`, nunca las del proyecto.
    const assistant = await observer.request('skills.list', { agent: 'assistant', cwd });
    const own = assistant.skills.map((s) => s.name);
    expect(own).toEqual(expect.arrayContaining(['stratum-global-memory']));
    expect(own).not.toContain('deploy');
    expect(own).not.toContain('stratum-project-memory');
    expect(assistant.skills.every((s) => s.scope === 'builtin')).toBe(true);
  });
});

/**
 * M12 — CLI, Desktop y Dot son clientes hermanos de `stratumd`
 * (`docs/STRATUM_CLIENT_ARCHITECTURE.md`). Lo que aquí se fija, sobre un daemon
 * real con clientes reales:
 *
 *  - una sesión abierta desde Desktop es una sesión Stratum normal: la ven
 *    los demás clientes con el mismo id, y su `origin` dice de dónde vino sin
 *    dar autoridad a nadie (observar no habilita conducir);
 *  - el agente embebido `assistant` (el modo Chat de Desktop) es una sesión
 *    del daemon como cualquier otra: sus tools, sus ficheros confinados, y no
 *    se cambia una vez abierta;
 *  - una sesión de Desktop sobrevive al cierre de Desktop y a un reinicio del
 *    daemon (M11), y se continúa desde otro cliente;
 *  - una sesión de la terminal traspasada (M10) conserva su origen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, parse } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  EMPTY_OVERVIEW,
  applyOverviewEvent,
  type ProtocolEvent,
  type ProtocolOverviewSnapshot,
} from '../protocol/index.js';
import {
  idleAgain,
  startPeer,
  startTestDaemon,
  watch,
  type TestDaemon,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m12-')));
  bases.push(base);
  return base;
}

async function daemonAt(base?: string, persist = false): Promise<TestDaemon> {
  const t = await startTestDaemon({
    ...(base ? { base } : {}),
    ...(base && persist ? { sessionsDir: join(base, 'daemon', 'sessions') } : {}),
  });
  daemons.push(t);
  return t;
}

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

/** Lo que una tool devolvió a la sesión, por nombre (de la foto). */
async function toolOutcomes(
  client: Awaited<ReturnType<TestDaemon['connect']>>,
  sessionId: string,
): Promise<Array<{ name: string; status: string }>> {
  const { snapshot } = await client.request('sessions.get', { sessionId });
  return snapshot.messages.flatMap((m) =>
    m.kind === 'tool' ? [{ name: m.name, status: m.state }] : [],
  );
}

describe('M12 — sesiones de Desktop, sesiones Stratum normales', () => {
  it('Desktop abre una sesión: Dot y la CLI la ven con el mismo id y su origen; observar no conduce', async () => {
    const t = await daemonAt();
    const cwd = t.project('desk', [makeTextRound('Hola desde el daemon.')]);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const cli = await t.connect(['observer'], 'stratum-ps', { kind: 'cli' });

    // Dot sigue el conjunto desde antes de que exista la sesión.
    let overview: ProtocolOverviewSnapshot = EMPTY_OVERVIEW;
    dot.subscribeOverview({
      onOverview: (o) => (overview = o),
      onEvent: (e: ProtocolEvent) => (overview = applyOverviewEvent(overview, e)),
    });

    const { session } = await desktop.request('sessions.open', { cwd });
    expect(session).toMatchObject({
      cwd,
      origin: 'desktop',
      host: { kind: 'daemon', client: 'daemon' },
    });

    const live = watch(desktop, session.id);
    await live.untilSnapshot();
    await desktop.request('runs.start', { sessionId: session.id, input: 'hola' });
    await live.until(idleAgain);

    // La misma sesión para todos: mismo id, mismo origen, misma conversación.
    const listed = (await cli.request('sessions.list', {})).sessions.find(
      (s) => s.id === session.id,
    );
    expect(listed?.origin).toBe('desktop');
    const fromDot = (await dot.request('sessions.get', { sessionId: session.id })).snapshot;
    const fromCli = (await cli.request('sessions.get', { sessionId: session.id })).snapshot;
    expect(fromDot.messages).toEqual(fromCli.messages);
    expect(fromDot.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    // El conjunto de Dot, solo con estado operativo, ya la tiene.
    await expect.poll(() => overview.sessions.find((s) => s.id === session.id)?.state).toBe('idle');
    expect(overview.sessions.find((s) => s.id === session.id)?.origin).toBe('desktop');

    // Ver no es conducir: un observador no inicia ni cancela nada, venga de donde venga la sesión.
    expect(await failure(cli.request('runs.start', { sessionId: session.id, input: 'x' }))).toBe(
      'FORBIDDEN',
    );
    expect(await failure(cli.request('runs.cancel', { sessionId: session.id }))).toBe('FORBIDDEN');
    // Y el origen no es propiedad: Dot, que no la abrió, la conduce con su propia capacidad.
    const { history } = {
      history: await dot.request('sessions.history', { sessionId: session.id }),
    };
    expect(history.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
  });

  it('cerrar Desktop (su conexión) no cierra la sesión ni el run que tenga en marcha', async () => {
    const t = await daemonAt();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const cwd = t.project('desk', [{ wait: held, then: makeTextRound('Terminado.') }]);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const dot = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    const { session } = await desktop.request('sessions.open', { cwd });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    const { run } = await desktop.request('runs.start', { sessionId: session.id, input: 'largo' });

    desktop.close();
    release();
    await live.until(
      (e) => e.type === 'run.completed' && (e.data as { run: { id: string } }).run.id === run.id,
    );
    const { snapshot } = await dot.request('sessions.get', { sessionId: session.id });
    expect(snapshot.session.state).toBe('idle');
    expect(snapshot.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'Terminado.' });
  });
});

describe('M12 — el agente embebido `assistant`', () => {
  it('necesita su propio directorio: sin cwd, el home, un ancestro suyo o la raíz de una unidad no valen', async () => {
    const base = newBase();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const t = await startTestDaemon({ base, home });
    daemons.push(t);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const open = (cwd?: string) =>
      failure(desktop.request('sessions.open', { agent: 'assistant', ...(cwd ? { cwd } : {}) }));
    expect(await open()).toBe('INVALID_PARAMS');
    expect(await open(home)).toBe('INVALID_PARAMS');
    expect(await open(base)).toBe('INVALID_PARAMS');
    expect(await open(parse(base).root)).toBe('INVALID_PARAMS');
    // Su carpeta, dentro del home, sí.
    const own = t.project('home/.stratum/desktop/workspaces/x', [makeTextRound('Hola.')]);
    expect(await open(own)).toBe('OK');
    // Una sesión de código sigue pudiendo abrirse donde se pida.
    const code = t.project('code', []);
    expect(await failure(desktop.request('sessions.open', { cwd: code }))).toBe('OK');
  });

  it('aparece el primero en agents.list y se abre como una sesión del daemon con sus tools y ficheros confinados', async () => {
    const t = await daemonAt();
    const cwd = t.project('chat', [
      makeToolCallRound('c1', 'write_file', { path: 'outputs/nota.md', content: 'hecho' }),
      makeToolCallRound('c2', 'write_file', { path: 'fuera.md', content: 'no' }),
      makeToolCallRound('c3', 'read_file', { path: 'inputs/dato.txt' }),
      makeToolCallRound('c4', 'exec', { command: 'echo hola' }),
      makeTextRound('Listo.'),
    ]);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });

    const { agents } = await desktop.request('agents.list', { cwd });
    expect(agents[0]).toMatchObject({ name: 'assistant', mode: 'primary', origin: 'builtin' });
    expect(agents[0]!.allowedTools).not.toContain('exec');

    // Desktop pone sus subidas en `inputs/` antes de pedir el turno.
    const { session } = await desktop.request('sessions.open', { cwd, agent: 'assistant' });
    expect(session).toMatchObject({ agent: 'assistant', origin: 'desktop' });
    expect(existsSync(join(cwd, 'outputs'))).toBe(true);
    expect(existsSync(join(cwd, 'scratch'))).toBe(true);
    const inputs = join(cwd, 'inputs');
    mkdirSync(inputs, { recursive: true });
    writeFileSync(join(inputs, 'dato.txt'), 'cuarenta y dos');

    const live = watch(desktop, session.id);
    await live.untilSnapshot();
    await desktop.request('runs.start', { sessionId: session.id, input: 'escribe una nota' });
    await live.until(idleAgain);

    expect(readFileSync(join(cwd, 'outputs', 'nota.md'), 'utf-8')).toBe('hecho');
    // Fuera de `outputs/`/`scratch/` no escribe, y `exec` no existe para él.
    expect(existsSync(join(cwd, 'fuera.md'))).toBe(false);
    const outcomes = await toolOutcomes(desktop, session.id);
    expect(outcomes.map((o) => o.name)).toEqual(['write_file', 'write_file', 'read_file', 'exec']);
    expect(outcomes.map((o) => o.status)).toEqual(['completed', 'error', 'completed', 'error']);
    // Las tools que recibió el modelo son las del asistente.
    const offered = t.provider(cwd).toolNames.at(0) ?? [];
    expect(offered).not.toContain('exec');
    expect(offered).toEqual(
      expect.arrayContaining(['write_file', 'web_search', 'recall_decisions']),
    );

    // Elegido al abrir: no se cambia, ni a otro perfil ni desde otra sesión hacia él.
    expect(
      await failure(desktop.request('sessions.setAgent', { sessionId: session.id, agent: null })),
    ).toBe('INVALID_PARAMS');
    const code = t.project('code', []);
    const other = (await desktop.request('sessions.open', { cwd: code })).session;
    expect(other.agent).toBe('general');
    expect(
      await failure(
        desktop.request('sessions.setAgent', { sessionId: other.id, agent: 'assistant' }),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('su memoria de decisiones es suya, no la del proyecto, y se migra una vez desde la de Desktop', async () => {
    const base = newBase();
    const legacy = join(base, 'legacy-desktop-memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'decisions.json'), '{"decisions":[]}\n');
    const t = await startTestDaemon({
      base,
      assistantData: { dir: join(base, 'assistant-data'), legacyMemoryDir: legacy },
    });
    daemons.push(t);
    const cwd = t.project('chat', [makeTextRound('Vale.')]);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    await desktop.request('sessions.open', { cwd, agent: 'assistant' });

    const migrated = join(base, 'assistant-data', 'memory');
    expect(readFileSync(join(migrated, 'decisions.json'), 'utf-8')).toBe('{"decisions":[]}\n');
    expect(
      JSON.parse(readFileSync(join(migrated, '.migrated-from-desktop'), 'utf-8')),
    ).toMatchObject({
      version: 1,
      copied: 1,
    });
    // Una sola vez: lo que cambie después en la carpeta de Desktop ya no se lee.
    writeFileSync(join(legacy, 'decisions.json'), '{"decisions":[{"x":1}]}\n');
    await desktop.request('sessions.open', { cwd, agent: 'assistant' });
    expect(readFileSync(join(migrated, 'decisions.json'), 'utf-8')).toBe('{"decisions":[]}\n');
  });
});

describe('M12 — continuidad entre clientes', () => {
  it('sesión de Desktop → se cierra Desktop → reinicio del daemon → vuelve la misma y se continúa (también desde otro cliente)', async () => {
    const base = newBase();
    const first = await daemonAt(base, true);
    const cwd = first.project('chat', [makeTextRound('Apuntado: kiwi.')]);
    const desktop = await first.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const { session } = await desktop.request('sessions.open', { cwd, agent: 'assistant' });
    const live = watch(desktop, session.id);
    await live.untilSnapshot();
    await desktop.request('runs.start', { sessionId: session.id, input: 'recuerda kiwi' });
    await live.until(idleAgain);
    const before = (await desktop.request('sessions.get', { sessionId: session.id })).snapshot;
    desktop.close();

    // Reinicio del daemon: lo que vuelve sale de su archivo (M11), no de Desktop.
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const second = await daemonAt(base, true);
    second.project('chat', [makeTextRound('Dijiste kiwi.')]);

    const reopened = await second.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const listed = (await reopened.request('sessions.list', {})).sessions;
    expect(listed.map((s) => s.id)).toEqual([session.id]);
    expect(listed[0]).toMatchObject({ origin: 'desktop', agent: 'assistant', cwd });
    const history = await reopened.request('sessions.history', { sessionId: session.id });
    expect(history.messages).toEqual(before.messages);

    // Se continúa desde Dot: mismo id, el contexto anterior llega al modelo.
    const dot = await second.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const w = watch(dot, session.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: '¿qué te dije?' });
    await w.until(idleAgain);
    expect(second.provider(cwd).userInputs.at(-1)).toEqual(
      expect.arrayContaining(['recuerda kiwi', '¿qué te dije?']),
    );
    const after = (await reopened.request('sessions.get', { sessionId: session.id })).snapshot;
    expect(after.session).toMatchObject({ id: session.id, origin: 'desktop', agent: 'assistant' });
    expect(after.messages.filter((m) => m.kind === 'user').map((m) => m.text)).toEqual([
      'recuerda kiwi',
      '¿qué te dije?',
    ]);
  });

  it('una sesión de la terminal traspasada al daemon (M10) conserva su origen y Desktop la continúa', async () => {
    const t = await daemonAt();
    const cwd = t.project('term', [makeTextRound('Sigo aquí.')]);
    const p = await startPeer({ base: t.base, dir: t.dir }, 'term', [makeTextRound('Hola.')]);
    expect(p.host.env.cwd).toBe(cwd);
    await p.run('primer turno en la terminal');
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const peerView = (await desktop.request('sessions.get', { sessionId: p.sessionId })).snapshot;
    expect(peerView.session).toMatchObject({ origin: 'cli', host: { kind: 'peer' } });
    // Desktop no puede iniciar turnos en una sesión par: la aloja la terminal.
    expect(
      await failure(desktop.request('runs.start', { sessionId: p.sessionId, input: 'x' })),
    ).toBe('UNAVAILABLE');

    expect(await p.detach()).toEqual({ status: 'detached' });
    const live = watch(desktop, p.sessionId);
    await live.untilSnapshot();
    const handed = (await desktop.request('sessions.get', { sessionId: p.sessionId })).snapshot;
    expect(handed.session).toMatchObject({
      id: p.sessionId,
      origin: 'cli',
      host: { kind: 'daemon' },
    });

    await desktop.request('runs.start', { sessionId: p.sessionId, input: 'desde Desktop' });
    await live.until(idleAgain);
    const after = (await desktop.request('sessions.get', { sessionId: p.sessionId })).snapshot;
    expect(after.messages.filter((m) => m.kind === 'user').map((m) => m.text)).toEqual([
      'primer turno en la terminal',
      'desde Desktop',
    ]);
    await p.stop();
  });
});

/**
 * Stratum Dot conversa con un `stratumd` real (criterio rey de M7).
 *
 * Como `smoke-real.mjs`, no automatiza la ventana: usa `dot-probe`, **el mismo
 * enlace nativo** de la app. Todo lo demás es de verdad: la CLI compilada, su
 * daemon, las sesiones que el daemon aloja (`SessionHost`), un `stratum run` en
 * su propio proceso y un modelo de guion.
 *
 *   Dot → sessions.open → runs.start → streaming → tool → message.completed
 *       → segundo mensaje, misma sesión → cerrar Dot → abrir Dot → el chat vuelve
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link && node scripts/smoke-chat.mjs
 *
 * HOME y proyectos son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm, mockConfig, text, toolCall, SLOW_WORDS } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { checker, sleep, startProbe, until } from './probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'stratum-cli', 'dist', 'index.js');
const PROBE = join(here, '..', 'target', 'debug', process.platform === 'win32' ? 'dot-probe.exe' : 'dot-probe');
for (const [what, path] of [['la CLI compilada', CLI], ['dot-probe', PROBE]]) {
  if (!existsSync(path)) {
    console.error(`Falta ${what}: ${path}`);
    process.exit(2);
  }
}

const runner = checker();
const check = runner.check;

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-chat-home-'));
const projectA = mkdtempSync(join(tmpdir(), 'dot-chat-a-'));
const projectB = mkdtempSync(join(tmpdir(), 'dot-chat-b-'));
writeFileSync(join(projectA, 'README.md'), '# proyecto A\n');
writeFileSync(join(projectB, 'README.md'), '# proyecto B\n');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  STRATUM_DOT_CLI: CLI,
  // Una variable del entorno en el que arranca el daemon: las sesiones la heredan de él.
  DOT_CHAT_MARK: 'entorno-del-daemon',
  NO_COLOR: '1',
};
delete env.STRATUM_NO_DAEMON;

const mock = await startMockLlm(({ said, last }) => {
  if (last.role === 'tool') {
    return text(said.includes('crea hello') ? 'Hecho: creado `hello.txt` con hola.' : 'Estoy en mi directorio.', 30);
  }
  if (said.includes('crea hello')) {
    return [...text('Voy a crear el fichero.', 30), ...toolCall('write_file', { path: 'hello.txt', content: 'hola' })];
  }
  if (said.includes('qué dice')) return text('Dice **hola**.', 30);
  if (said.includes('despacio')) return text(SLOW_WORDS, 450);
  if (said.includes('dónde estás')) return toolCall('list_directory', { path: '.' });
  return text('Vale.', 30);
});
mkdirSync(join(home, '.stratum'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));

const endpointFile = join(home, '.stratum', 'daemon', 'endpoint.json');
const endpoint = () => JSON.parse(readFileSync(endpointFile, 'utf-8'));
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', ...opts });
const daemonRunning = () => cli(['daemon', 'status']).status === 0;
const dot = () => startProbe({ binary: PROBE, env, logDir: join(home, 'dot-logs') });

const kinds = (snapshot) => snapshot.messages.map((m) => m.kind);
const said = (snapshot, kind) => snapshot.messages.filter((m) => m.kind === kind).map((m) => m.text);
const runIs = (probe, id, status) => probe.sessions.get(id)?.run?.status === status;
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

let probe;
let run;
let chat;
try {
  // --- qué se puede elegir lo dice el daemon ----------------------------------
  await check('Dot arranca el daemon y le pregunta qué perfiles y modelos hay', async () => {
    assert.equal(daemonRunning(), false);
    probe = dot();
    await until('conectado', () => probe.connection?.kind === 'connected');
    assert.deepEqual(probe.connection.capabilities, ['observe', 'control']);

    const models = await probe.order('models');
    assert.equal(models.ok, true, JSON.stringify(models));
    const ids = models.result.models.map((m) => `${m.provider}/${m.id}${m.default ? '*' : ''}`);
    assert.ok(ids.some((id) => id.endsWith('/mock-model*')), ids.join(' '));
    const agents = await probe.order('agents', { cwd: projectA });
    assert.equal(agents.ok, true);
    assert.ok(agents.result.agents.some((a) => a.name === 'general'));
    // Alias e ids: ni la URL del backend, ni una clave.
    const wire = JSON.stringify([models, agents]);
    assert.ok(!wire.includes(mock.baseUrl) && !/127\.0\.0\.1|apiKey|baseUrl/.test(wire), wire);
  });

  // --- New Chat ---------------------------------------------------------------
  await check('New Chat: sessions.open crea una sesión alojada en el daemon; el directorio lo valida él', async () => {
    const bad = await probe.order('open', { cwd: join(projectA, 'no-existe') });
    assert.deepEqual([bad.ok, bad.error.kind, bad.error.code], [false, 'rejected', 'INVALID_PARAMS']);
    assert.deepEqual(probe.sessionIds, [], 'un directorio que no vale no deja una sesión a medias');

    const opened = await probe.order('open', { cwd: projectA });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    chat = opened.result.session.id;
    assert.equal(opened.result.session.host.kind, 'daemon');
    assert.ok(same(opened.result.session.cwd, projectA));
    // La sesión llega a la interfaz porque el daemon la publica.
    await until('la sesión en la lista, con su foto', () => probe.sessionIds.includes(chat) && probe.sessions.has(chat));
    const { snapshot } = probe.sessions.get(chat);
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.messagesTruncated, false);
    assert.equal(snapshot.session.state, 'idle');
    // Enfocarla reabre su suscripción con foto: se espera a esa foto antes de escribirle.
    const seen = probe.sessions.get(chat).snapshots;
    probe.send({ cmd: 'focus', sessionId: chat });
    await until('la foto con foco', () => probe.sessions.get(chat).snapshots > seen);
  });

  await check('primer mensaje: runs.start, texto en streaming, una tool y el fichero creado', async () => {
    const from = probe.seen.length;
    const sent = await probe.order('send', { sessionId: chat, input: 'crea hello.txt con hola' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.result.run.sessionId, chat);
    await until('el run termina', () => runIs(probe, chat, 'completed'));
    assert.equal(readFileSync(join(projectA, 'hello.txt'), 'utf-8'), 'hola');

    const events = probe.seen.slice(from).flatMap((m) => (m.type === 'events' && m.sessionId === chat ? m.events : []));
    const types = events.map((e) => e.type);
    for (const expected of ['run.started', 'message.delta', 'tool.started', 'tool.completed', 'message.completed', 'run.completed']) {
      assert.ok(types.includes(expected), `falta ${expected}: ${types.join(' ')}`);
    }
    assert.ok(types.indexOf('run.started') < types.indexOf('message.completed'));

    // La conversación sale de la foto del anfitrión, no de lo que Dot haya visto pasar.
    const snapshot = await probe.photo(chat);
    assert.deepEqual(kinds(snapshot), ['user', 'assistant', 'tool', 'assistant']);
    assert.deepEqual(said(snapshot, 'user'), ['crea hello.txt con hola']);
    assert.deepEqual(said(snapshot, 'assistant'), ['Voy a crear el fichero.', 'Hecho: creado `hello.txt` con hola.']);
    assert.deepEqual([snapshot.messages[2].name, snapshot.messages[2].state], ['write_file', 'completed']);
    assert.deepEqual(snapshot.partial, { text: '', reasoning: '' });
  });

  let firstRun;
  await check('segundo mensaje: otro run de la misma sesión, con el contexto del primero', async () => {
    firstRun = probe.sessions.get(chat).run.id;
    const sent = await probe.order('send', { sessionId: chat, input: '¿qué dice el fichero?' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.notEqual(sent.result.run.id, firstRun);
    await until('el segundo run termina', () => probe.sessions.get(chat).run.id !== firstRun && runIs(probe, chat, 'completed'));
    // El modelo recibió la conversación anterior: es la misma sesión, no una nueva.
    const context = JSON.stringify(mock.requests.at(-1).messages);
    assert.match(context, /crea hello\.txt con hola/);
    assert.match(context, /qué dice el fichero/);
    assert.deepEqual(probe.sessionIds, [chat]);
    const snapshot = await probe.photo(chat);
    assert.deepEqual(said(snapshot, 'user'), ['crea hello.txt con hola', '¿qué dice el fichero?']);
    assert.equal(said(snapshot, 'assistant').at(-1), 'Dice **hola**.');
  });

  await check('con un run en curso, otro mensaje no abre otro run: BUSY, y el steering sí se acepta', async () => {
    const sent = await probe.order('send', { sessionId: chat, input: 'cuenta despacio hasta doce' });
    assert.equal(sent.ok, true);
    await until('en marcha', () => runIs(probe, chat, 'running'));
    const second = await probe.order('send', { sessionId: chat, input: 'otra cosa' });
    assert.deepEqual([second.ok, second.error.kind, second.error.code], [false, 'rejected', 'BUSY']);
    const steer = await probe.order('steer', { sessionId: chat, text: 'y al terminar di vale' });
    assert.deepEqual([steer.ok, steer.status], [true, 'accepted']);
  });

  // --- Dot se cierra y vuelve --------------------------------------------------
  await check('cerrar Dot a mitad de un run: no cierra la sesión ni cancela nada', async () => {
    assert.equal(runIs(probe, chat, 'running'), true);
    const before = mock.requests.length;
    await probe.close();
    probe = null;
    assert.equal(daemonRunning(), true);
    // Sin ningún cliente mirando, el run sigue y el steering se entrega.
    await until('el modelo recibe el steering', () => mock.requests.length > before, 30_000);
    assert.match(JSON.stringify(mock.requests.at(-1).messages), /y al terminar di vale/);
  });

  await check('abrir Dot otra vez: la sesión está, y el chat se reconstruye entero desde su foto', async () => {
    probe = dot();
    await until('conectado', () => probe.connection?.kind === 'connected');
    await until('la sesión reaparece', () => probe.sessionIds.includes(chat) && probe.sessions.has(chat));
    await until('el run que seguía solo termina', () => runIs(probe, chat, 'completed'), 40_000);
    const snapshot = await probe.photo(chat);
    assert.deepEqual(said(snapshot, 'user'), [
      'crea hello.txt con hola',
      '¿qué dice el fichero?',
      'cuenta despacio hasta doce',
    ]);
    const replies = said(snapshot, 'assistant');
    assert.ok(replies.includes('Dice **hola**.'));
    assert.ok(replies.includes(SLOW_WORDS), replies.join(' | '));
    assert.equal(replies.at(-1), 'Vale.');
    assert.equal(snapshot.messagesTruncated, false);

    // Y se sigue hablando con ella.
    const sent = await probe.order('send', { sessionId: chat, input: 'gracias' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const runId = sent.result.run.id;
    await until('otro turno', () => probe.sessions.get(chat).run.id === runId && runIs(probe, chat, 'completed'));
    assert.match(JSON.stringify(mock.requests.at(-1).messages), /crea hello\.txt con hola/);
  });

  // --- varias sesiones ---------------------------------------------------------
  let other;
  await check('dos chats: cada uno en su directorio, y sus conversaciones no se cruzan', async () => {
    const opened = await probe.order('open', { cwd: projectB });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    other = opened.result.session.id;
    assert.notEqual(other, chat);
    await until('dos sesiones', () => probe.sessionIds.length === 2 && probe.sessions.has(other));
    const seenOther = probe.sessions.get(other).snapshots;
    probe.send({ cmd: 'focus', sessionId: other });
    await until('la foto con foco de B', () => probe.sessions.get(other).snapshots > seenOther);
    const sent = await probe.order('send', { sessionId: other, input: '¿dónde estás?' });
    assert.equal(sent.ok, true);
    await until('B termina', () => runIs(probe, other, 'completed'));

    const b = await probe.photo(other);
    const a = await probe.photo(chat);
    assert.ok(same(b.session.cwd, projectB) && same(a.session.cwd, projectA));
    assert.deepEqual(said(b, 'user'), ['¿dónde estás?']);
    assert.ok(!JSON.stringify(a.messages).includes('dónde estás'));
    assert.ok(!JSON.stringify(b.messages).includes('hello.txt'));
    // La tool de B corrió en el directorio de B: lo que vio el modelo es su README, no el fichero de A.
    const toolResult = JSON.stringify(mock.requests.findLast((r) => r.messages.at(-1).role === 'tool').messages.at(-1));
    assert.ok(toolResult.includes('README.md') && !toolResult.includes('hello.txt'), toolResult);
    assert.equal(existsSync(join(projectB, 'hello.txt')), false);
  });

  await check('una sesión de terminal convive con las del daemon, y New Chat no la convierte', async () => {
    run = spawn(process.execPath, [CLI, 'run', 'tarea de terminal: cuenta despacio'], {
      env,
      cwd: projectA,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await until('tres sesiones', () => probe.sessionIds.length === 3);
    const peer = probe.sessionIds.find((id) => id !== chat && id !== other);
    await until('la foto de la par', () => probe.sessions.has(peer));
    assert.equal(probe.sessions.get(peer).session.host.kind, 'peer');
    assert.equal(probe.sessions.get(chat).session.host.kind, 'daemon');
    // Un mensaje nuevo a una sesión de terminal no es cosa de Dot.
    const sent = await probe.order('send', { sessionId: peer, input: 'hola' });
    assert.deepEqual([sent.ok, sent.error.code, sent.error.reason], [false, 'UNAVAILABLE', 'peer-hosted']);
    // Pero su conversación se lee igual.
    await until('la par en marcha', () => runIs(probe, peer, 'running'));
    assert.deepEqual(said(await probe.photo(peer), 'user'), ['tarea de terminal: cuenta despacio']);
  });

  // --- el daemon muere --------------------------------------------------------
  await check('el daemon muere: sus chats vuelven con su conversación (M11); nada se encola sin conexión', async () => {
    const pid = endpoint().pid;
    const seenBefore = probe.sessions.get(chat).snapshot.messages.map((m) => m.id);
    process.kill(pid, 'SIGKILL');
    await until('reconnecting', () => probe.connection?.kind === 'reconnecting');
    // Sin conexión no sale nada: ni se encola un mensaje para después.
    const offline = await probe.order('send', { sessionId: chat, input: '¿sigues ahí?' });
    assert.deepEqual([offline.ok, offline.error.kind], [false, 'not-sent']);

    const requests = mock.requests.length;
    assert.equal(cli(['daemon', 'start']).status, 0);
    await until('conectado otra vez', () => probe.connection?.kind === 'connected');
    // M11: las sesiones del daemon se guardaron y vuelven con él, con su conversación.
    await until('los chats vuelven', () => probe.sessionIds.includes(chat) && probe.sessionIds.includes(other), 40_000);
    const back = probe.sessions.get(chat).snapshot;
    assert.equal(back.session.host.kind, 'daemon');
    assert.deepEqual(back.messages.map((m) => m.id), seenBefore);
    // Lo que se intentó sin conexión no se envió entonces ni ahora.
    assert.ok(!JSON.stringify(mock.requests.slice(requests)).includes('sigues ahí'));
    // Un mensaje nuevo continúa la misma sesión, con el contexto de antes.
    const resumed = await probe.order('send', { sessionId: chat, input: '¿sigues ahí, de vuelta?' });
    assert.equal(resumed.ok, true);
    await until('el modelo recibe el mensaje', () => JSON.stringify(mock.requests.slice(requests)).includes('de vuelta'), 40_000);
    assert.match(JSON.stringify(mock.requests.at(-1).messages), /crea hello\.txt/);
  });

  await check('ni el token, ni el endpoint, ni nada del provider llegan a la interfaz o al log', async () => {
    const log = readFileSync(join(home, 'dot-logs', 'dot.log'), 'utf-8');
    for (const expected of ['call: open-session', 'call: start-run', 'call: list-models', 'the daemon keeps running']) {
      assert.ok(log.includes(expected), `falta «${expected}» en el log`);
    }
    const ui = JSON.stringify(probe.seen);
    for (const secret of [endpoint().token, 'endpoint.json', mock.baseUrl, 'entorno-del-daemon', 'apiKey']) {
      assert.ok(!ui.includes(secret), `la interfaz recibió ${secret}`);
      assert.ok(!log.includes(secret), `el log contiene ${secret}`);
    }
    // El contenido de la conversación tampoco se registra.
    assert.ok(!log.includes('crea hello.txt') && !log.includes(projectA));
  });
} finally {
  await probe?.close().catch(() => undefined);
  if (run && run.exitCode === null) run.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(300);
  for (const dir of [home, projectA, projectB]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(runner.failed === 0 ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 ? 0 : 1);

/**
 * Stratum Dot contra un `stratumd` real (criterio rey de M6).
 *
 * No automatiza la ventana: lanza `dot-probe`, que es **el mismo enlace nativo**
 * que usa la app (`dot_link::spawn`) con la interfaz cambiada por líneas JSON.
 * Todo lo demás es de verdad: la CLI compilada, su daemon, un `stratum run` en
 * su propio proceso y un modelo de guion.
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link && node scripts/smoke-real.mjs
 *
 * HOME y proyecto son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm, mockConfig, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { checker, sleep, startProbe as launchProbe, until } from './probe.mjs';

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

const home = mkdtempSync(join(tmpdir(), 'dot-smoke-home-'));
const project = mkdtempSync(join(tmpdir(), 'dot-smoke-proj-'));
writeFileSync(join(project, 'README.md'), '# proyecto de prueba\n');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  STRATUM_DOT_CLI: CLI,
  NO_COLOR: '1',
};
delete env.STRATUM_NO_DAEMON;

const WORDS = Array.from({ length: 80 }, (_, i) => `palabra${i + 1}`).join(' ');
// Las dos sesiones hacen lo mismo: hablan, proponen una tool y, tras ella, siguen
// hablando. La tool da un punto seguro donde la pausa se alcanza: pausar durante
// la última respuesta de un turno no lo detiene (termina, y la pausa con él).
const mock = await startMockLlm(({ said, last }) => {
  const who = said.includes('daemon') ? 'Sesión del daemon.' : 'De acuerdo.';
  if (last.role === 'tool') return text(`${who} ${WORDS} fin-del-run`, 500);
  return [
    ...text('Voy a listar el directorio. uno dos tres cuatro cinco seis siete ocho', 500),
    ...toolCall('list_directory', { path: '.' }),
  ];
});
mkdirSync(join(home, '.stratum'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));

const endpointFile = join(home, '.stratum', 'daemon', 'endpoint.json');
const endpoint = () => JSON.parse(readFileSync(endpointFile, 'utf-8'));
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', ...opts });
const daemonRunning = () => cli(['daemon', 'status']).status === 0;

/** `dot-probe`: lo que vería y haría la interfaz de Dot. */
const startProbe = () => launchProbe({ binary: PROBE, env, logDir: join(home, 'dot-logs') });

/** Cliente mínimo del protocolo, para abrir una sesión alojada en el daemon. */
async function rawClient(roles) {
  const ep = endpoint();
  const socket = createConnection(ep.ipcPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  socket.on('error', () => undefined);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  await request('core.hello', {
    protocol: ep.protocol,
    token: ep.token,
    client: { kind: 'other', name: 'dot-smoke', version: '0' },
    roles,
  });
  return { request, close: () => socket.destroy() };
}

let probe;
let run;
let runOutput = '';
try {
  // --- Dot arranca el daemon y, al cerrarse, no lo apaga ----------------------
  await check('sin daemon, Dot lo arranca con `stratum daemon start` y conecta', async () => {
    assert.equal(daemonRunning(), false);
    probe = startProbe();
    await until('conectado', () => probe.connection?.kind === 'connected');
    const kinds = probe.seen.filter((m) => m.type === 'connection').map((m) => m.state.kind);
    assert.ok(kinds.includes('daemon-starting'), kinds.join(' → '));
    assert.equal(probe.connection.protocol, 1);
    assert.deepEqual(probe.connection.capabilities, ['observe', 'control']);
    assert.deepEqual(probe.sessionIds, []);
  });

  await check('cerrar Dot no apaga el daemon', async () => {
    const pid = endpoint().pid;
    await probe.close();
    await sleep(800);
    assert.equal(daemonRunning(), true);
    assert.equal(endpoint().pid, pid);
  });

  // --- el flujo del criterio rey ---------------------------------------------
  let peer;
  await check('`stratum run` en su proceso: Dot lo ve como sesión par, en marcha', async () => {
    run = spawn(process.execPath, [CLI, 'run', 'tarea larga: lista el directorio'], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    run.stdout.on('data', (c) => (runOutput += c.toString('utf-8')));
    run.stderr.on('data', (c) => (runOutput += c.toString('utf-8')));
    probe = startProbe();
    await until('una sesión', () => probe.sessionIds.length === 1 && probe.sessions.has(probe.sessionIds[0]));
    peer = probe.sessionIds[0];
    // La sesión se registra antes de abrir su turno: la primera foto puede no traer run.
    await until('el run en marcha', () => probe.sessions.get(peer).run?.status === 'running');
    const { session, run: current } = probe.sessions.get(peer);
    assert.equal(session.host.kind, 'peer');
    assert.equal(session.host.connected, true);
    assert.equal(session.model, 'mock-model');
    assert.equal(session.cwd.toLowerCase(), project.toLowerCase());
    assert.equal(current.status, 'running');
    probe.send({ cmd: 'focus', sessionId: peer });
  });

  await check('pausa: la orden se acepta y el estado cambia cuando el runtime lo alcanza', async () => {
    const runId = probe.sessions.get(peer).run.id;
    const answer = await probe.order('pause', { sessionId: peer, runId });
    assert.deepEqual([answer.ok, answer.status], [true, 'requested']);
    // Pedida no es alcanzada: el modelo aún está hablando.
    assert.equal(probe.sessions.get(peer).run.status, 'running');
    await until('paused', () => probe.sessions.get(peer).run.status === 'paused');
    assert.equal(probe.sessions.get(peer).session.state, 'paused');
    await sleep(1500);
    assert.equal(mock.requests.length, 1, 'en pausa no se llama al modelo');
    assert.equal(run.exitCode, null);
  });

  await check('steer con el run en pausa: aceptado, y sigue en pausa', async () => {
    const answer = await probe.order('steer', { sessionId: peer, text: 'mejor no listes nada, resume el README' });
    assert.deepEqual([answer.ok, answer.status], [true, 'accepted']);
    await sleep(1000);
    assert.equal(probe.sessions.get(peer).run.status, 'paused');
    assert.equal(mock.requests.length, 1);
  });

  await check('resume: el mismo run continúa y el modelo recibe el mensaje', async () => {
    const runId = probe.sessions.get(peer).run.id;
    const answer = await probe.order('resume', { sessionId: peer, runId });
    assert.deepEqual([answer.ok, answer.status], [true, 'resumed']);
    await until('running', () => probe.sessions.get(peer).run.status === 'running');
    await until('segunda petición al modelo', () => mock.requests.length >= 2);
    assert.match(JSON.stringify(mock.requests[1].messages), /mejor no listes nada/);
    assert.equal(probe.sessions.get(peer).run.id, runId);
  });

  // --- una sesión del daemon y una par, bajo la misma interfaz ----------------
  let hosted;
  await check('una sesión alojada en el daemon aparece junto a la par', async () => {
    const operator = await rawClient(['operator']);
    try {
      const { session } = await operator.request('sessions.open', { cwd: project });
      hosted = session.id;
      await operator.request('runs.start', { sessionId: hosted, input: 'sesión del daemon, despacio' });
    } finally {
      operator.close();
    }
    await until('dos sesiones', () => probe.sessionIds.length === 2 && probe.sessions.has(hosted));
    assert.equal(probe.sessions.get(hosted).session.host.kind, 'daemon');
    assert.equal(probe.sessions.get(peer).session.host.kind, 'peer');
    await until('la del daemon en marcha', () => probe.sessions.get(hosted).run?.status === 'running');
    // Las mismas órdenes valen para las dos.
    const answer = await probe.order('pause', { sessionId: hosted });
    assert.deepEqual([answer.ok, answer.status], [true, 'requested']);
    await until('la del daemon en pausa', () => probe.sessions.get(hosted).run.status === 'paused');
    assert.equal(probe.sessions.get(peer).run.status, 'running');
  });

  // --- el daemon muere y vuelve ------------------------------------------------
  await check('el daemon muere: Dot reconecta sola y el run de la CLI sigue', async () => {
    const pid = endpoint().pid;
    const before = probe.sessions.get(peer).snapshots;
    process.kill(pid, 'SIGKILL');
    await until('reconnecting', () => probe.connection?.kind === 'reconnecting');
    await sleep(1200);
    assert.equal(run.exitCode, null, 'el run no depende del daemon');
    assert.equal(probe.connection.kind, 'reconnecting', 'Dot no arranca el daemon al reconectar');

    assert.equal(cli(['daemon', 'start']).status, 0);
    await until('conectado otra vez', () => probe.connection?.kind === 'connected');
    // El anfitrión par se vuelve a registrar: la sesión reaparece con una foto nueva.
    await until('la sesión par reaparece', () => probe.sessionIds.includes(peer) && probe.sessions.get(peer).snapshots > before, 40_000);
    assert.equal(probe.sessions.get(peer).session.host.kind, 'peer');
    assert.notEqual(endpoint().pid, pid);
    // La sesión del daemon murió con él: ya no está.
    assert.ok(!probe.sessionIds.includes(hosted));
  });

  // --- Dot desaparece ---------------------------------------------------------
  await check('cerrar Dot: el run sigue hasta el final y el daemon sigue', async () => {
    assert.equal(run.exitCode, null);
    await probe.close();
    const code = await until('fin del run', () => (run.exitCode !== null ? { code: run.exitCode } : null), 60_000);
    assert.equal(code.code, 0, runOutput);
    assert.match(runOutput, /fin-del-run/);
    assert.equal(daemonRunning(), true);
  });

  await check('el log de Dot cuenta la conexión y no lleva el token', async () => {
    const log = readFileSync(join(home, 'dot-logs', 'dot.log'), 'utf-8');
    for (const expected of ['daemon start: running', 'connection: connected', 'connection: reconnecting', 'control: pause', 'the daemon keeps running']) {
      assert.ok(log.includes(expected), `falta «${expected}» en el log`);
    }
    assert.ok(!log.includes(endpoint().token));
    const ui = JSON.stringify(probe.seen);
    assert.ok(!ui.includes(endpoint().token));
    assert.ok(!ui.includes('endpoint.json'));
  });
} finally {
  await probe?.close().catch(() => undefined);
  if (run && run.exitCode === null) run.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(300);
  for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(runner.failed === 0 ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 ? 0 : 1);

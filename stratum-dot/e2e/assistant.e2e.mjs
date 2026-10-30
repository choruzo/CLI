/**
 * La vista *Asistente* de Dot (M14), de verdad y en su ventana: la app compilada
 * contra un `stratumd` real que aloja al `companion`.
 *
 *   Assistant → sessions.open { agent: companion } (sin directorio) → conversar
 *             → un exec fuera de la caja se veta sin pedir aprobación
 *             → panel de la caja con lo que contesta el daemon
 *             → Quit Dot → reiniciar el daemon → abrir Dot → la misma conversación
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/assistant.e2e.mjs [--shots <carpeta>]
 *
 * Mismos requisitos que `dot.e2e.mjs` (`tauri-driver` + driver nativo). HOME es
 * temporal: no toca `~/.stratum` ni el daemon del usuario. La caja se habilita con
 * un nombre propio y nunca se arranca: el panel solo consulta su estado.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../stratum-desktop/e2e/webdriver.mjs';
import { startMockLlm, mockConfig, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === 'win32';
const CLI = join(here, '..', '..', 'stratum-cli', 'dist', 'index.js');
const APP = process.env.STRATUM_DOT_E2E_APP ?? join(here, '..', 'target', 'debug', WINDOWS ? 'stratum-dot.exe' : 'stratum-dot');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
for (const [what, path] of [['la CLI compilada', CLI], ['la app', APP]]) {
  if (!existsSync(path)) {
    console.error(`Falta ${what}: ${path}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

async function until(what, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no se cumplió a tiempo: ${what}`);
    await sleep(150);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-assistant-e2e-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, STRATUM_DOT_CLI: CLI, NO_COLOR: '1' };
if (WINDOWS) {
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
} else {
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_CACHE_HOME = join(home, '.cache');
}
delete env.STRATUM_NO_DAEMON;

const mock = await startMockLlm(({ said, last }) => {
  if (last.role === 'tool') return text('No puedo salir de mi caja.', 60);
  if (said.includes('mira mis ficheros')) return toolCall('exec', { command: 'dir C:\\Users', target: 'local' });
  if (said.includes('quién eres')) return text('Soy tu asistente.', 60);
  return text('Vale.', 60);
});
mkdirSync(join(home, '.stratum'), { recursive: true });
// Caja habilitada con un nombre que no existe: el `companion` tiene `exec` y el
// panel enseña `absent`. Nada en este test la arranca.
const BOX = `e2e-${process.pid}`;
writeFileSync(
  join(home, '.stratum', '.stratumrc.json'),
  JSON.stringify(mockConfig(mock.baseUrl, { box: { enabled: true, name: BOX } }), null, 2),
);

const endpointFile = join(home, '.stratum', 'daemon', 'endpoint.json');
const endpoint = () => JSON.parse(readFileSync(endpointFile, 'utf-8'));
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
const daemonRunning = () => cli(['daemon', 'status']).status === 0;

// --- la app, con tauri-driver --------------------------------------------------

const driverBin = join(homedir(), '.cargo', 'bin', WINDOWS ? 'tauri-driver.exe' : 'tauri-driver');
let driver;
let driverUrl;
let driverLog = '';
async function startDriver() {
  const port = await freePort();
  const nativePort = await freePort();
  const args = ['--port', String(port), '--native-port', String(nativePort)];
  if (process.env.STRATUM_E2E_NATIVE_DRIVER) args.push('--native-driver', process.env.STRATUM_E2E_NATIVE_DRIVER);
  driver = spawn(existsSync(driverBin) ? driverBin : 'tauri-driver', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  driver.stdout.on('data', (d) => (driverLog += d));
  driver.stderr.on('data', (d) => (driverLog += d));
  driverUrl = `http://127.0.0.1:${port}`;
}

let session;
let shotNumber = 0;
async function shot(name) {
  if (!SHOTS || !session) return;
  mkdirSync(SHOTS, { recursive: true });
  const png = await session.screenshot().catch(() => null);
  if (png) writeFileSync(join(SHOTS, `${String(++shotNumber).padStart(2, '0')}-${name}.png`), Buffer.from(png, 'base64'));
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${String(err?.stack ?? err).split('\n').join('\n  ')}`);
    const body = await session?.bodyText().catch(() => '(sin ventana)');
    console.log(`  --- ventana ---\n  ${String(body).split('\n').join('\n  ')}`);
    await shot(`fallo-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`);
  }
}

async function openDot() {
  await startDriver();
  session = await Session.create(driverUrl, APP);
  await session.waitForElement('.top', { timeout: 30_000 });
  await until('conectado', async () => (await connection()) === 'connected', 40_000);
}

async function closeDot() {
  await session.clickButton('Quit Dot', { contains: true }).catch(() => undefined);
  await sleep(1500);
  await session.close().catch(() => undefined);
  session = null;
  driver.kill();
}

const connection = () => session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`);
const statuses = () => session.execute(`return [...document.querySelectorAll('.detail [data-status]')].map((e) => e.getAttribute('data-status'))`);
const transcript = () =>
  session.execute(`return [...document.querySelectorAll('.messages > li')].map((li) => [li.getAttribute('data-kind'), li.innerText.trim()])`);
const idle = async () => (await statuses()).includes('idle');
const boxState = () => session.execute(`return document.querySelector('.box-panel')?.getAttribute('data-box-state')`);
const sessionIds = () => {
  const r = cli(['ps', '--json']);
  return JSON.parse(r.stdout || '{}').sessions ?? [];
};

async function openAssistant() {
  await session.clickButton('Assistant');
  await session.waitForElement('.box-panel');
  await session.waitForElement('.assistant .messages', { timeout: 40_000 });
}

async function say(textToSend) {
  const field = await session.find('.assistant .composer textarea');
  await session.type(field, textToSend);
  await session.clickButton('Send message');
}

/** Lo que el modelo recibió en la última petición de la sesión. */
const lastRequest = () => mock.requests.at(-1);

let companionPs;

try {
  await check('la vista Asistente abre la sesión del companion en el daemon, sin directorio del cliente', async () => {
    assert.equal(daemonRunning(), false);
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    await openAssistant();
    assert.equal(await session.execute(`return document.querySelector('.assistant .detail.session')?.getAttribute('data-host')`), 'daemon');
    const listed = await until('el daemon publica la sesión', async () => {
      const all = sessionIds();
      return all.length === 1 ? all : null;
    });
    companionPs = listed[0];
    assert.match(JSON.stringify(companionPs), /companion/);
    // Su directorio es el del companion, no uno que diga el cliente.
    assert.match(JSON.stringify(companionPs).replaceAll('\\\\', '/'), /\.stratum\/companion\/workspace/);
    await shot('asistente-abierto');
  });

  await check('el panel de la caja enseña lo que contesta el daemon', async () => {
    await until('estado de la caja', async () => (await boxState()) !== 'unknown', 30_000);
    const state = await boxState();
    // Con Docker o Podman, la caja no existe aún; sin runtime, no está disponible.
    assert.ok(['absent', 'unavailable'].includes(state), state);
    const panel = await session.execute(`return document.querySelector('.box-panel').innerText`);
    assert.match(panel, state === 'absent' ? /Not created yet/ : /Unavailable/);
    assert.match(panel, /exchange/i);
    if (state === 'absent') {
      assert.equal(await session.execute(`return [...document.querySelectorAll('.box-panel button')].some((b) => b.textContent === 'Start box' && !b.disabled)`), true);
    }
    await shot('caja');
  });

  await check('conversar: responde, con el prompt y las tools del companion', async () => {
    await say('¿quién eres?');
    await until('la respuesta', async () => (await idle()) && (await transcript()).at(-1)?.[1] === 'Soy tu asistente.', 30_000);
    const body = lastRequest();
    const system = JSON.stringify(body.messages.filter((m) => m.role === 'system'));
    assert.match(system, /not shared with Stratum Desktop/);
    const tools = (body.tools ?? []).map((t) => t.function?.name);
    assert.ok(tools.includes('exec'), tools.join(','));
    for (const banned of ['write_file', 'read_file', 'edit_file', 'delegate_task', 'ssh_exec']) {
      assert.ok(!tools.includes(banned), `${banned} no es del companion: ${tools.join(',')}`);
    }
    await shot('conversacion');
  });

  await check('un exec fuera de su caja se veta sin pedir aprobación', async () => {
    await say('mira mis ficheros');
    await until('fin del turno', async () => (await idle()) && (await transcript()).at(-1)?.[1] === 'No puedo salir de mi caja.', 30_000);
    const shown = await transcript();
    const tool = shown.find(([kind, t]) => kind === 'tool' && /exec/.test(t));
    assert.ok(tool, JSON.stringify(shown));
    // Lo que el modelo recibió como resultado: el veto, no una salida.
    const result = JSON.stringify(lastRequest().messages.filter((m) => m.role === 'tool').at(-1));
    assert.match(result, /can only run commands in its box/);
    // Ninguna aprobación quedó pendiente en el centro.
    assert.equal(await session.execute(`return document.querySelector('[data-waiting]')?.getAttribute('data-waiting')`), '0');
    await shot('veto');
  });

  await check('volver a la cabina y al asistente: la misma conversación', async () => {
    await session.clickButton('Assistant');
    await session.waitForElement('.row[aria-label^="Session"]');
    await openAssistant();
    assert.equal((await transcript()).filter(([kind]) => kind === 'user').length, 2);
    assert.equal(sessionIds().length, 1);
  });

  await check('Quit Dot y reiniciar el daemon: al abrir el asistente vuelve la misma sesión', async () => {
    await closeDot();
    assert.equal(cli(['daemon', 'stop']).status, 0);
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    const before = mock.requests.length;
    await openAssistant();
    await until('la conversación anterior', async () => (await transcript()).filter(([kind]) => kind === 'user').length === 2, 30_000);
    const now = sessionIds();
    assert.equal(now.length, 1);
    assert.equal(now[0].id, companionPs.id, 'es la misma sesión');
    // Despertar no le pide nada al modelo.
    assert.equal(mock.requests.length, before);
    await say('gracias');
    await until('otro turno', async () => (await transcript()).at(-1)?.[1] === 'Vale.', 30_000);
    assert.match(JSON.stringify(lastRequest().messages), /quién eres/);
    await shot('reabierto');
  });

  await check('la memoria del companion es la suya, aparte de la global', async () => {
    assert.ok(existsSync(join(home, '.stratum', 'companion')));
    const dom = await session.execute(`return document.documentElement.outerHTML + JSON.stringify({ ...localStorage })`);
    for (const secret of [endpoint().token, 'endpoint.json', mock.baseUrl, 'apiKey']) {
      assert.ok(!dom.includes(secret), `la ventana contiene ${secret}`);
    }
  });
} finally {
  await session?.close().catch(() => undefined);
  driver?.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed > 0 && process.env.STRATUM_E2E_DEBUG) console.log(`--- tauri-driver ---\n${driverLog}`);
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

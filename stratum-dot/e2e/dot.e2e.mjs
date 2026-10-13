/**
 * Stratum Dot de verdad: la app compilada, en su ventana, contra un `stratumd`
 * real y un `stratum run` en su propio proceso. Es el criterio rey de M6 visto
 * desde la interfaz: Dot arranca el daemon, ve la sesión, pausa, redirige,
 * reanuda, aguanta la caída del daemon y, al cerrarse, no se lleva nada.
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/dot.e2e.mjs [--shots <carpeta>]
 *
 * Requisitos, los mismos que la suite de Desktop: `tauri-driver` y el driver
 * nativo (`msedgedriver` de la versión de WebView2 en Windows, vía
 * `STRATUM_E2E_NATIVE_DRIVER`; `WebKitWebDriver` en Linux). El cliente
 * WebDriver es el de `stratum-desktop/e2e/` (herramienta de pruebas, no código
 * de la app).
 *
 * HOME y proyecto son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const home = mkdtempSync(join(tmpdir(), 'dot-e2e-home-'));
const project = mkdtempSync(join(tmpdir(), 'dot-e2e-proj-'));
writeFileSync(join(project, 'README.md'), '# proyecto de prueba\n');
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

const WORDS = Array.from({ length: 90 }, (_, i) => `palabra${i + 1}`).join(' ');
const mock = await startMockLlm(({ last }) => {
  if (last.role === 'tool') return text(`De acuerdo. ${WORDS} fin-del-run`, 500);
  return [
    ...text('Voy a listar el directorio. uno dos tres cuatro cinco seis siete ocho', 500),
    ...toolCall('list_directory', { path: '.' }),
  ];
});
mkdirSync(join(home, '.stratum'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));

const endpointFile = join(home, '.stratum', 'daemon', 'endpoint.json');
const endpoint = () => JSON.parse(readFileSync(endpointFile, 'utf-8'));
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
const daemonRunning = () => cli(['daemon', 'status']).status === 0;

// --- la app, con tauri-driver --------------------------------------------------

const port = await freePort();
const nativePort = await freePort();
const driverBin = join(homedir(), '.cargo', 'bin', WINDOWS ? 'tauri-driver.exe' : 'tauri-driver');
const driverArgs = ['--port', String(port), '--native-port', String(nativePort)];
if (process.env.STRATUM_E2E_NATIVE_DRIVER) driverArgs.push('--native-driver', process.env.STRATUM_E2E_NATIVE_DRIVER);
const driver = spawn(existsSync(driverBin) ? driverBin : 'tauri-driver', driverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let driverLog = '';
driver.stdout.on('data', (d) => (driverLog += d));
driver.stderr.on('data', (d) => (driverLog += d));

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

/** Estado que enseña la cabecera (`data-connection`). */
const connection = () => session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`);
/** Estados (`data-status`) que hay en pantalla. */
const statuses = () => session.execute(`return [...document.querySelectorAll('[data-status]')].map((e) => e.getAttribute('data-status'))`);
const hasText = async (t) => (await session.bodyText()).includes(t);

let run;
let runOutput = '';
try {
  await check('la ventana abre y, sin daemon, Dot lo arranca y conecta', async () => {
    assert.equal(daemonRunning(), false);
    session = await Session.create(`http://127.0.0.1:${port}`, APP);
    await session.waitForElement('.top', { timeout: 30_000 });
    await until('conectado', async () => (await connection()) === 'connected', 40_000);
    assert.equal(daemonRunning(), true);
    assert.ok(await hasText('No live sessions'));
    // El pie dice con qué habla.
    const body = await session.bodyText();
    assert.match(body, /Dot 0\.1\.0 · daemon \d+\.\d+\.\d+.* · protocol 1/);
    await shot('conectado-sin-sesiones');
  });

  await check('un `stratum run` aparece como sesión par en marcha', async () => {
    run = spawn(process.execPath, [CLI, 'run', 'tarea larga: lista el directorio'], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    run.stdout.on('data', (c) => (runOutput += c.toString('utf-8')));
    run.stderr.on('data', (c) => (runOutput += c.toString('utf-8')));
    await session.waitForElement('.row[aria-label^="Session"]', { timeout: 30_000 });
    await until('running', async () => (await statuses()).includes('running'));
    const row = await session.execute(`return document.querySelector('.row').innerText`);
    assert.match(row, /mock-model/);
    assert.match(row, /cli \(peer\)/);
    assert.ok(row.toLowerCase().includes(project.toLowerCase()), row);
    assert.ok(await hasText('1 session'));
    await shot('sesion-en-marcha');
  });

  await check('Pause: «Pause requested» primero, «Paused» cuando el runtime lo alcanza', async () => {
    await session.click(await session.find('.row'));
    await session.waitForElement('.controls');
    await session.clickButton('Pause run');
    await session.waitForText('Pause requested…');
    // La interfaz no se adelanta: el modelo aún está hablando.
    assert.ok(!(await statuses()).includes('paused'));
    await shot('pausa-pedida');
    await until('paused', async () => (await statuses()).includes('paused'));
    assert.ok(!(await hasText('Pause requested…')));
    await session.waitFor(() => session.button('Resume run'), { message: 'botón Resume' });
    await sleep(1500);
    assert.equal(mock.requests.length, 1, 'en pausa no se llama al modelo');
    assert.equal(run.exitCode, null);
    await shot('en-pausa');
  });

  await check('Steer en pausa: en cola, y el run sigue en pausa', async () => {
    const input = await session.find('.steer input');
    await session.type(input, 'mejor no listes nada, resume el README');
    await session.clickButton('Send steering message');
    await session.waitForText('still paused');
    await sleep(800);
    assert.ok((await statuses()).includes('paused'));
    assert.equal(mock.requests.length, 1);
    assert.equal(await session.execute(`return document.querySelector('.steer input').value`), '');
    await shot('steer-en-pausa');
  });

  await check('Resume: el run continúa y el modelo recibe el mensaje', async () => {
    await session.clickButton('Resume run');
    await until('running', async () => (await statuses()).includes('running') && !(await statuses()).includes('paused'));
    await until('segunda petición', () => mock.requests.length >= 2);
    assert.match(JSON.stringify(mock.requests[1].messages), /mejor no listes nada/);
    await session.waitForText('Steering delivered to the agent');
    // El texto que el modelo va generando llega a la sesión enfocada.
    await until('texto parcial', async () =>
      /De acuerdo\. palabra1/.test((await session.execute(`return document.querySelector('.partial')?.innerText ?? ''`)) ?? ''),
    );
    await shot('reanudado');
  });

  await check('el daemon muere: la ventana sigue, enseña lo último y reconecta sola', async () => {
    const pid = endpoint().pid;
    process.kill(pid, 'SIGKILL');
    await until('reconnecting', async () => (await connection()) === 'reconnecting');
    await session.waitForText('Reconnecting');
    // No se vació: la sesión sigue en pantalla, y sus controles no se pueden pulsar.
    assert.ok(await session.execute(`return document.querySelectorAll('.row').length === 1`));
    assert.ok(await hasText('last known'));
    assert.equal(await session.execute(`return document.querySelector('[aria-label="Pause run"]')?.disabled`), true);
    await shot('reconectando');
    assert.equal(run.exitCode, null, 'el run no depende del daemon');

    assert.equal(cli(['daemon', 'start']).status, 0);
    await until('conectado otra vez', async () => (await connection()) === 'connected');
    await until(
      'la sesión vuelve, en marcha',
      async () => (await statuses()).includes('running') && !(await hasText('last known')),
      40_000,
    );
    assert.notEqual(endpoint().pid, pid);
    assert.equal(await session.execute(`return document.querySelector('[aria-label="Pause run"]')?.disabled`), false);
    await shot('reconectado');
  });

  await check('Quit Dot: la app sale, el run termina solo y el daemon sigue', async () => {
    assert.equal(run.exitCode, null);
    await session.clickButton('Quit Dot', { contains: true }).catch(() => undefined);
    await sleep(1500);
    assert.equal(daemonRunning(), true);
    const done = await until('fin del run', () => (run.exitCode !== null ? { code: run.exitCode } : null), 90_000);
    assert.equal(done.code, 0, runOutput);
    assert.match(runOutput, /fin-del-run/);
    assert.equal(daemonRunning(), true);
  });

  await check('el log de Dot cuenta lo ocurrido y no lleva el token', async () => {
    const candidates = [
      join(home, 'AppData', 'Local', 'dev.stratum.dot', 'logs'),
      join(home, '.local', 'share', 'dev.stratum.dot', 'logs'),
    ];
    const dir = candidates.find((d) => existsSync(d));
    assert.ok(dir, `no hay carpeta de logs en ${candidates.join(' ni ')}`);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('dot.log')), ['dot.log']);
    const log = readFileSync(join(dir, 'dot.log'), 'utf-8');
    for (const expected of ['dot startup', 'daemon start: running', 'connection: connected', 'control: pause', 'control: steer', 'control: resume', 'connection: reconnecting', 'quit requested', 'the daemon keeps running']) {
      assert.ok(log.includes(expected), `falta «${expected}» en el log:\n${log}`);
    }
    assert.ok(!log.includes(endpoint().token));
  });
} finally {
  await session?.close().catch(() => undefined);
  driver.kill();
  if (run && run.exitCode === null) run.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(500);
  for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed > 0 && process.env.STRATUM_E2E_DEBUG) console.log(`--- tauri-driver ---\n${driverLog}`);
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

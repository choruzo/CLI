/**
 * Stratum Dot conversa, de verdad y en su ventana (criterio rey de M7): la app
 * compilada contra un `stratumd` real, con sesiones que aloja el daemon.
 *
 *   New chat → sessions.open → runs.start → streaming → tool → respuesta
 *            → segundo mensaje, misma sesión
 *            → Quit Dot → el runtime sigue → abrir Dot → el chat vuelve
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/chat.e2e.mjs [--shots <carpeta>]
 *
 * Mismos requisitos que `dot.e2e.mjs` (`tauri-driver` + driver nativo). HOME y
 * proyecto son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../stratum-desktop/e2e/webdriver.mjs';
import { startMockLlm, mockConfig, text, toolCall, SLOW_WORDS } from '../../stratum-cli/scripts/tui/mock-llm.mjs';

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

const home = mkdtempSync(join(tmpdir(), 'dot-chat-e2e-home-'));
const project = mkdtempSync(join(tmpdir(), 'dot-chat-e2e-proj-'));
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

const mock = await startMockLlm(({ said, last }) => {
  if (last.role === 'tool') return text('Hecho: creado `hello.txt` con **hola**.', 60);
  if (said.includes('crea hello')) {
    return [...text('Voy a crear el fichero. Un momento.', 250), ...toolCall('write_file', { path: 'hello.txt', content: 'hola' })];
  }
  if (said.includes('qué dice')) return text('Dice hola.', 60);
  if (said.includes('despacio')) return text(SLOW_WORDS, 600);
  return text('Vale.', 60);
});
mkdirSync(join(home, '.stratum'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));

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

/** Abre la app (otra vez, tras cerrarla): un driver nuevo, la misma carpeta de datos. */
async function openDot() {
  await startDriver();
  session = await Session.create(driverUrl, APP);
  await session.waitForElement('.top', { timeout: 30_000 });
  await until('conectado', async () => (await connection()) === 'connected', 40_000);
}

const connection = () => session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`);
const statuses = () => session.execute(`return [...document.querySelectorAll('.detail [data-status]')].map((e) => e.getAttribute('data-status'))`);
/** La conversación que se ve: `[tipo, texto]` de cada entrada. */
const transcript = () =>
  session.execute(`return [...document.querySelectorAll('.messages > li')].map((li) => [li.getAttribute('data-kind'), li.innerText.trim()])`);
const composer = () => session.execute(`const t = document.querySelector('.composer textarea'); return t ? { label: t.getAttribute('aria-label'), disabled: t.disabled, value: t.value } : null`);
const idle = async () => (await statuses()).includes('idle');

async function say(textToSend, label) {
  const field = await session.find('.composer textarea');
  await session.type(field, textToSend);
  await session.clickButton(label);
}

try {
  await check('la ventana abre, conecta con el daemon y no hay sesiones', async () => {
    // El daemon lo arranca el test, no Dot (eso lo prueba `dot.e2e.mjs`): aquí
    // la app se cierra y se vuelve a abrir, y el driver nativo se lleva consigo
    // todo lo que cuelga de él. Un daemon arrancado por Dot colgaría del driver.
    assert.equal(daemonRunning(), false);
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    assert.equal(daemonRunning(), true);
    assert.equal(await session.execute(`return document.querySelectorAll('.row').length`), 0);
    await shot('sin-sesiones');
  });

  await check('New chat: el formulario ofrece lo que dice el daemon, y abre una sesión suya', async () => {
    await session.clickButton('New chat');
    await session.waitForElement('.newchat-form');
    // Modelos y perfiles vienen del daemon (models.list / agents.list).
    await until('modelos', async () =>
      (await session.execute(`return [...document.querySelectorAll('select[aria-label="Model"] option')].map((o) => o.textContent)`)).some((o) => o.includes('mock-model')),
    );
    await session.type(await session.find('input[aria-label="Working directory"]'), project);
    await session.type(await session.find('textarea[aria-label="First message"]'), 'crea hello.txt con hola');
    await shot('chat-nuevo');
    await session.clickButton('Start chat');

    // La sesión aparece en la lista porque el daemon la publica: alojada en el daemon.
    await session.waitForElement('.row[aria-label^="Session"]', { timeout: 40_000 });
    const row = await session.execute(`return document.querySelector('.row').innerText`);
    assert.match(row, /daemon/);
    assert.ok(row.toLowerCase().includes(project.toLowerCase()), row);
    assert.equal(await session.execute(`return document.querySelector('.detail.session')?.getAttribute('data-host')`), 'daemon');
  });

  await check('primer mensaje: se ve escribir, se ve la tool, llega la respuesta y el fichero existe', async () => {
    await until('el mensaje del usuario', async () => (await transcript()).some(([kind, t]) => kind === 'user' && t === 'crea hello.txt con hola'));
    // Mientras hay un run, el campo es de steering y lo dice.
    await until('texto en curso', async () => (await transcript()).some(([kind]) => kind === 'partial'), 20_000);
    assert.match((await composer()).label, /^Steer this run/);
    assert.ok((await session.bodyText()).includes('Steering the current run'));
    await shot('escribiendo');

    await until('fin del turno', async () => (await idle()) && (await transcript()).at(-1)?.[0] === 'assistant', 40_000);
    const shown = await transcript();
    assert.deepEqual(shown.map(([kind]) => kind), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(shown[1][1], 'Voy a crear el fichero. Un momento.');
    assert.match(shown[2][1], /write_file/);
    assert.match(shown[2][1], /Done/);
    // Markdown pintado, no en crudo.
    assert.equal(shown[3][1], 'Hecho: creado hello.txt con hola.');
    assert.equal(readFileSync(join(project, 'hello.txt'), 'utf-8'), 'hola');
    // Parada otra vez: el campo vuelve a ser para preguntar.
    assert.deepEqual(await composer(), { label: 'Ask Stratum', disabled: false, value: '' });
    await shot('primer-turno');
  });

  await check('segundo mensaje: misma sesión, mismo contexto', async () => {
    await say('¿qué dice el fichero?', 'Send message');
    await until('la respuesta', async () => (await transcript()).at(-1)?.[1] === 'Dice hola.', 30_000);
    assert.equal(await session.execute(`return document.querySelectorAll('.row').length`), 1);
    const context = JSON.stringify(mock.requests.at(-1).messages);
    assert.match(context, /crea hello\.txt con hola/);
    assert.match(context, /qué dice el fichero/);
    assert.equal((await transcript()).filter(([kind]) => kind === 'user').length, 2);
    await shot('segundo-turno');
  });

  await check('la pestaña Activity sigue ahí, con el run y sus tools', async () => {
    await session.clickButton('Activity');
    await session.waitForElement('.fields');
    assert.ok((await session.bodyText()).includes('Run completed'));
    await shot('activity');
    await session.clickButton('Chat');
    await session.waitForElement('.messages');
  });

  await check('Quit Dot a mitad de un run: la sesión y el run siguen en el daemon', async () => {
    await say('cuenta despacio hasta doce', 'Send message');
    await until('en marcha', async () => (await statuses()).includes('running'));
    await until('escribiendo', async () => (await transcript()).some(([kind]) => kind === 'partial'), 20_000);
    const before = mock.requests.length;
    const pid = endpoint().pid;
    await session.clickButton('Quit Dot', { contains: true }).catch(() => undefined);
    await sleep(1500);
    await session.close().catch(() => undefined);
    session = null;
    driver.kill();
    assert.equal(daemonRunning(), true);
    assert.equal(endpoint().pid, pid, 'es el mismo daemon');
    // Nadie canceló la petición al modelo: sigue en vuelo, sin Dot.
    assert.equal(mock.requests.length, before);
    // Sin ningún Dot abierto, el daemon sigue teniendo la sesión con su run en marcha.
    const status = cli(['ps', '--json']);
    assert.match(status.stdout, /running/, status.stdout + status.stderr);
  });

  await check('abrir Dot otra vez: la sesión aparece y el chat se reconstruye entero', async () => {
    await openDot();
    await session.waitForElement('.row[aria-label^="Session"]', { timeout: 40_000 });
    // La última sesión seleccionada se recuerda; si no, se elige.
    if (!(await session.execute(`return !!document.querySelector('.detail.session')`))) {
      await session.click(await session.find('.row'));
    }
    await session.waitForElement('.messages');
    await until('el run que seguía solo termina', async () => (await idle()) && (await transcript()).at(-1)?.[1] === SLOW_WORDS, 60_000);
    const shown = await transcript();
    assert.deepEqual(
      shown.filter(([kind]) => kind === 'user').map(([, t]) => t),
      ['crea hello.txt con hola', '¿qué dice el fichero?', 'cuenta despacio hasta doce'],
    );
    assert.ok(shown.some(([kind, t]) => kind === 'assistant' && t === 'Dice hola.'));
    assert.ok(shown.some(([kind, t]) => kind === 'tool' && /write_file/.test(t)));
    await shot('reabierto');

    // Y la conversación continúa donde estaba.
    await say('gracias', 'Send message');
    await until('otro turno', async () => (await transcript()).at(-1)?.[1] === 'Vale.', 30_000);
    assert.match(JSON.stringify(mock.requests.at(-1).messages), /crea hello\.txt con hola/);
    assert.equal(await session.execute(`return document.querySelectorAll('.row').length`), 1);
  });

  await check('el daemon se reinicia: su chat desaparece y Dot lo dice, sin dejar escribir', async () => {
    const pid = endpoint().pid;
    process.kill(pid, 'SIGKILL');
    await until('reconnecting', async () => (await connection()) === 'reconnecting');
    // Lo último conocido sigue en pantalla, pero no se le puede escribir.
    assert.equal((await composer()).disabled, true);
    assert.ok((await transcript()).length > 0);
    await shot('sin-daemon');

    assert.equal(cli(['daemon', 'start']).status, 0);
    await until('conectado otra vez', async () => (await connection()) === 'connected');
    await session.waitForText('Session ended or unavailable', { timeout: 40_000 });
    assert.equal(await composer(), null);
    assert.equal(await session.execute(`return document.querySelectorAll('.row').length`), 0);
    assert.notEqual(endpoint().pid, pid);
    await shot('sesion-terminada');
  });

  await check('ni el token ni nada del provider están en la ventana', async () => {
    const dom = await session.execute(`return document.documentElement.outerHTML + JSON.stringify({ ...localStorage })`);
    for (const secret of [endpoint().token, 'endpoint.json', mock.baseUrl, 'apiKey']) {
      assert.ok(!dom.includes(secret), `la ventana contiene ${secret}`);
    }
    // Lo que Dot guarda entre arranques son preferencias, no la conversación.
    const stored = await session.execute(`return JSON.stringify({ ...localStorage })`);
    assert.ok(!/crea hello|Dice hola|gracias/.test(stored), stored);
  });
} finally {
  await session?.close().catch(() => undefined);
  driver?.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(500);
  for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed > 0 && process.env.STRATUM_E2E_DEBUG) console.log(`--- tauri-driver ---\n${driverLog}`);
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

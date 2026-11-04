/**
 * El Dot compacto (PRD de Dot §8.2), de verdad y en su ventana: la app compilada
 * contra un `stratumd` real que aloja al `companion`.
 *
 *   Ctrl+Alt+Space (pulsado en el sistema) → ventana compacta, en su origen y sin IPC
 *             → Enter: el texto va al asistente (un run, o steering) y sale la principal
 *             → Esc, o el atajo otra vez, la cierra sin enviar nada
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/ask.e2e.mjs [--shots <carpeta>]
 *
 * Solo en Windows: el atajo se pulsa con `keybd_event`. Mismos requisitos que
 * `assistant.e2e.mjs`; HOME es temporal. Mientras corre, no toques el teclado.
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

const home = mkdtempSync(join(tmpdir(), 'dot-ask-e2e-home-'));
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
  // El modelo de memoria de sesión (M11), al compactar para archivar (`said` va en minúsculas).
  if (said.startsWith('you maintain the structured memory')) {
    const id = /\[(e\d+) user\]\n¿quién eres\?/.exec(said)?.[1];
    return text(
      JSON.stringify({ items: id ? [{ kind: 'fact', key: 'asked-identity', text: 'The user asked who the assistant is.', sources: [id] }] : [] }),
      400,
    );
  }
  if (said.startsWith('you keep the running summary')) return text('The user met the assistant and asked it to look at their files.', 400);
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

/** A 440 px la vista va en pestañas: enseña la que se pide (sin pestañas, ya se ve todo). */
async function showTab(label) {
  const tabbed = await session.execute(`return !!document.querySelector('.assistant-tabs')`);
  if (tabbed) await session.clickButton(label);
}

async function openAssistant() {
  await session.clickButton('Assistant');
  await showTab('Conversation');
  await session.waitForElement('.assistant .messages', { timeout: 40_000 });
}

async function say(textToSend) {
  const field = await session.find('.assistant .composer textarea');
  await session.type(field, textToSend);
  await session.clickButton('Send message');
}

/** Lo que el modelo recibió en la última petición de la sesión. */
const lastRequest = () => mock.requests.at(-1);

// --- el Dot compacto --------------------------------------------------------------

async function wd(method, path, body) {
  const res = await fetch(`${session.base}/session/${session.id}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (json?.value?.error) throw new Error(`${method} ${path}: ${json.value.error} ${json.value.message ?? ''}`);
  return json.value;
}
const handles = () => wd('GET', '/window/handles');
const windowTo = (handle) => wd('POST', '/window', { handle });

/**
 * El atajo global, pulsado de verdad: un evento de teclado del sistema
 * (`keybd_event`), no de WebDriver, que solo llega a la página enfocada.
 */
function pressShortcut() {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class K { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }'",
    '[K]::keybd_event(0x11,0,0,[UIntPtr]::Zero)',
    '[K]::keybd_event(0x12,0,0,[UIntPtr]::Zero)',
    '[K]::keybd_event(0x20,0,0,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 60',
    '[K]::keybd_event(0x20,0,2,[UIntPtr]::Zero)',
    '[K]::keybd_event(0x12,0,2,[UIntPtr]::Zero)',
    '[K]::keybd_event(0x11,0,2,[UIntPtr]::Zero)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
}

let mainHandle;

/** Pulsa el atajo y pasa a la ventana compacta que se abre. */
async function openCompact() {
  const before = await handles();
  pressShortcut();
  const handle = await until('la ventana compacta', async () => (await handles()).find((h) => !before.includes(h)) ?? null, 20_000);
  await windowTo(handle);
  await session.waitForElement('#text', { timeout: 20_000 });
  return handle;
}

async function backToMain() {
  await until('la compacta se cierra', async () => (await handles()).length === 1, 20_000);
  await windowTo(mainHandle);
}

const userMessages = async () => (await transcript()).filter(([kind]) => kind === 'user').map(([, t]) => t);

try {
  await check('Dot abre en el asistente, con su sesión', async () => {
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    mainHandle = await wd('GET', '/window');
    await session.waitForElement('.assistant .messages', { timeout: 40_000 });
  });

  await check('Ctrl+Alt+Space abre el Dot compacto: otra ventana, en su origen y sin IPC', async () => {
    await openCompact();
    assert.match(await session.execute('return location.origin'), /dot-ask/);
    const invoked = await session.execute(`
      const ipc = window.__TAURI_INTERNALS__;
      if (!ipc) return 'no-ipc';
      return ipc.invoke('dot_start_run', { sessionId: 'x', input: 'y' }).then(() => 'ok', () => 'denied');
    `);
    assert.ok(invoked === 'no-ipc' || invoked === 'denied', invoked);
    await shot('compacto');
  });

  await check('Enter: el mensaje va al asistente y la ventana principal sale al frente', async () => {
    await session.type(await session.find('#text'), 'recuérdame comprar pan');
    await backToMain();
    await until('el mensaje en la conversación del asistente', async () => (await userMessages()).includes('recuérdame comprar pan'), 30_000);
    await until('la respuesta', async () => (await idle()) && (await transcript()).at(-1)?.[1] === 'Vale.', 30_000);
    assert.equal((await userMessages()).filter((t) => t === 'recuérdame comprar pan').length, 1, 'una sola vez');
    assert.equal(await session.execute(`return document.querySelector('.top button[aria-pressed="true"]')?.textContent`), 'Assistant');
    await shot('enviado');
  });

  await check('desde la cabina, también va al asistente', async () => {
    await session.clickButton('Sessions');
    await openCompact();
    await session.type(await session.find('#text'), 'y leche');
    await backToMain();
    await until('en el asistente', async () => (await userMessages()).includes('y leche'), 30_000);
    await until('fin del turno', async () => await idle(), 30_000);
  });

  await check('Esc lo cierra sin enviar nada; el atajo otra vez también lo cierra', async () => {
    const before = (await userMessages()).length;
    await openCompact();
    await session.type(await session.find('#text'), 'esto no se envía');
    await backToMain();
    await openCompact();
    pressShortcut();
    await backToMain();
    await sleep(1000);
    assert.equal((await userMessages()).length, before);
  });

  await check('ni el token ni el endpoint llegan a la página compacta', async () => {
    await openCompact();
    const dom = await session.execute(`return document.documentElement.outerHTML`);
    for (const secret of [endpoint().token, 'endpoint.json', mock.baseUrl]) {
      assert.ok(!dom.includes(secret), `la página compacta contiene ${secret}`);
    }
    await session.execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await backToMain();
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

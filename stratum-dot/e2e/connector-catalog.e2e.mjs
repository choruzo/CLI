/**
 * M20 — activar un conector del catálogo desde Dot: la app compilada contra un
 * `stratumd` real (catálogo de serie: Open-Meteo, Renfe, Home Assistant).
 *
 *   Asistente → Connectors → Unlock… (ventana de desbloqueo) → Enable…
 *     → confirmación nativa (otra ventana, otro origen, sin IPC) con lo que dice
 *       el daemon: tools y su marca, hosts, lo que necesita
 *     → Cancel no activa nada; Confirm activa (y lo dice `connectors.json`)
 *   + Home Assistant: «Not set up yet» y la orden de terminal; Disable solo resta.
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/connector-catalog.e2e.mjs [--shots <carpeta>]
 *
 * Sin caja ni Docker: activar solo escribe `connectors.json` (la caja de
 * conectores arranca con la caja principal). HOME temporal: no toca
 * `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../stratum-desktop/e2e/webdriver.mjs';
import { startMockLlm, mockConfig, text } from '../../stratum-cli/scripts/tui/mock-llm.mjs';

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

const KEY = `clave-e2e-${randomBytes(6).toString('hex')}`;
function approverFile(key) {
  const params = { N: 1 << 15, r: 8, p: 1 };
  const salt = randomBytes(16);
  const hash = scryptSync(key.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * params.N * 8 });
  return JSON.stringify({ version: 1, algorithm: 'scrypt', ...params, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() });
}

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-conn-e2e-home-'));
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

const mock = await startMockLlm(() => text('Vale.', 40));
mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));
writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
const connectorsFile = join(home, '.stratum', 'companion', 'connectors.json');
const enabledOnDisk = () =>
  existsSync(connectorsFile) ? JSON.parse(readFileSync(connectorsFile, 'utf-8')).enabled.map((e) => e.id) : [];

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
let mainHandle;
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
    if (mainHandle) await windowTo(mainHandle).catch(() => undefined);
    const body = await session?.bodyText().catch(() => '(sin ventana)');
    console.log(`  --- ventana ---\n  ${String(body).split('\n').join('\n  ')}`);
    await shot(`fallo-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`);
  }
}

async function wd(method, path, body) {
  const res = await fetch(`${session.base}/session/${session.id}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) throw new Error(`${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ''}`);
  return json.value;
}
const handles = () => wd('GET', '/window/handles');
const windowTo = (handle) => wd('POST', '/window', { handle });

const panelText = () => session.execute(`return document.querySelector('section[aria-label="Connectors"]')?.innerText ?? ''`);
const stateOf = (id) => session.execute(`return document.querySelector('[data-e2e="connector-state-${id}"]')?.textContent.trim() ?? null`);
const approverState = () => session.execute(`return document.querySelector('.authority')?.getAttribute('data-approver') ?? null`);

async function showConnectors() {
  if (await session.execute(`return !!document.querySelector('.assistant-tabs')`)) await session.clickButton('Connectors');
  await session.waitForElement('section[aria-label="Connectors"]', { timeout: 30_000 });
}

/** Desbloquea en la ventana nativa: la clave solo se teclea allí. */
async function unlock() {
  const before = await handles();
  await session.clickButton('Unlock…');
  const unlockHandle = await until('la ventana de desbloqueo', async () => (await handles()).find((h) => !before.includes(h)) ?? null);
  await windowTo(unlockHandle);
  await session.waitForElement('#key', { timeout: 20_000 });
  assert.match(await session.execute('return location.origin'), /dot-unlock/);
  await session.type(await session.find('#key'), KEY);
  await session.click(await session.find('#submit'));
  await until('la ventana se cierra', async () => !(await handles()).includes(unlockHandle), 20_000);
  await windowTo(mainHandle);
  await until('desbloqueado', async () => !(await panelText()).includes('Enabling needs the approval authority'), 20_000);
}

/**
 * La confirmación nativa: `label` (Enable…) se pulsa en la principal y se abre
 * otra ventana, en otro origen y sin IPC, con lo que dijo el daemon.
 */
let confirmations = 0;
async function confirmNative(label, { expect: expected = [], absent = [], cancel = false } = {}) {
  const before = await handles();
  await session.clickButton(label);
  const confirmHandle = await until('la ventana de confirmación', async () => (await handles()).find((h) => !before.includes(h)) ?? null, 20_000);
  await windowTo(confirmHandle);
  await session.waitForElement('#ok', { timeout: 20_000 });
  assert.match(await session.execute('return location.origin'), /dot-confirm/);
  const invoked = await session.execute(`
    const ipc = window.__TAURI_INTERNALS__;
    if (!ipc) return 'no-ipc';
    return ipc.invoke('dot_connectors_enable', { connectorId: 'renfe' }).then(() => 'ok', () => 'denied');
  `);
  assert.ok(invoked === 'no-ipc' || invoked === 'denied', `la ventana de confirmación no puede activar nada: ${invoked}`);
  await until('lo que dijo el daemon', async () => (await session.execute(`return document.getElementById('facts').innerText`)).length > 0, 10_000);
  const body = await session.execute(`return document.body.innerText`);
  for (const pattern of expected) assert.match(body, pattern);
  for (const pattern of absent) assert.doesNotMatch(body, pattern);
  assert.equal(await session.execute(`return document.activeElement?.id`), 'cancel', 'el foco empieza en Cancel');
  await shot(`confirmacion-${++confirmations}`);
  if (cancel) {
    await session.click(await session.find('#cancel'));
  } else {
    // Armado con retardo: al principio no deja confirmar.
    await until('deja confirmar', async () => !(await session.execute(`return document.getElementById('ok').disabled`)), 10_000);
    await session.click(await session.find('#ok'));
  }
  await until('la ventana de confirmación se cierra', async () => !(await handles()).includes(confirmHandle), 20_000);
  await windowTo(mainHandle);
  return body;
}

try {
  await check('Dot abre, conecta y el panel enseña el catálogo de serie, nada activo', async () => {
    assert.equal(cli(['daemon', 'start']).status, 0);
    await startDriver();
    session = await Session.create(driverUrl, APP);
    await session.waitForElement('.top', { timeout: 30_000 });
    mainHandle = await wd('GET', '/window');
    await until('conectado', async () => (await session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`)) === 'connected', 40_000);
    await showConnectors();
    await until('la lista', async () => (await stateOf('open-meteo')) !== null, 30_000);
    for (const id of ['open-meteo', 'renfe', 'home-assistant']) assert.equal(await stateOf(id), 'Disabled', id);
    const text = await panelText();
    assert.match(text, /Not set up yet \(HA_URL, HA_TOKEN\)/);
    assert.match(text, /stratum connectors setup home-assistant/);
    // Ni un campo donde teclear un secreto en la principal.
    assert.equal(await session.execute(`return document.querySelectorAll('section[aria-label="Connectors"] input').length`), 0);
    assert.deepEqual(enabledOnDisk(), []);
    await shot('panel');
  });

  await check('sin la autoridad de aprobar no se puede activar; se desbloquea en su ventana', async () => {
    assert.match(await panelText(), /Enabling needs the approval authority/);
    assert.equal(await session.button('Enable Open-Meteo'), null, 'Enable… apagado sin autoridad');
    await unlock();
  });

  await check('Cancel en la confirmación nativa no activa nada', async () => {
    const body = await confirmNative('Enable Open-Meteo', {
      cancel: true,
      expect: [/Enable this connector/i, /Open-Meteo/, /buscar_lugar/, /tiempo_actual/, /prevision/, /api\.open-meteo\.com/],
    });
    assert.doesNotMatch(body, /asks approval/, 'Open-Meteo solo lee');
    await sleep(500);
    assert.deepEqual(enabledOnDisk(), []);
    assert.equal(await stateOf('open-meteo'), 'Disabled');
  });

  await check('Confirm activa Open-Meteo: lo dicen connectors.json, la CLI y el panel', async () => {
    await sleep(1_200); // tras cancelar hay un cooldown antes de otra confirmación
    await confirmNative('Enable Open-Meteo', { expect: [/Open-Meteo/, /read-only/i] });
    await until('activo en disco', async () => enabledOnDisk().includes('open-meteo'), 20_000);
    await until('activo en el panel', async () => (await stateOf('open-meteo')) === 'Enabled', 20_000);
    const list = JSON.parse(cli(['connectors', 'list', '--json']).stdout);
    assert.equal(list.connectors.find((c) => c.id === 'open-meteo').enabled, true);
    // Sin caja, el panel avisa de que no se ofrece todavía.
    assert.match(await panelText(), /not offered to the assistant until the box/);
    await shot('open-meteo-activo');
  });

  await check('Home Assistant: la ventana dice qué tools actúan y qué necesita; activo, sigue «Not set up yet»', async () => {
    await sleep(1_200);
    await confirmNative('Enable Home Assistant', {
      expect: [/Home Assistant/, /ha_encender/, /asks approval/i, /HA_URL/, /HA_TOKEN/, /3 of its tools act outside/, /more setup/],
      absent: [/eyJ/],
    });
    await until('activo en el panel', async () => (await stateOf('home-assistant')) === 'Enabled', 20_000);
    assert.deepEqual(enabledOnDisk().sort(), ['home-assistant', 'open-meteo']);
    const text = await panelText();
    assert.match(text, /Not set up yet \(HA_URL, HA_TOKEN\)/);
    assert.match(text, /until then the assistant does not have it/);
    await shot('home-assistant-activo');
  });

  await check('Disable solo resta: confirmación en la página, sin ventana nativa', async () => {
    const before = (await handles()).length;
    await session.clickButton('Disable Open-Meteo');
    // El «Disable» de la confirmación en la página, dentro del grupo de Open-Meteo.
    const marked = await until('la confirmación en la página', () =>
      session.execute(`
        const b = [...document.querySelectorAll('[role="group"][aria-label="Disable Open-Meteo"] button')].find((x) => x.textContent.trim() === 'Disable');
        if (!b) return false;
        b.setAttribute('data-e2e-target', '1');
        return true;`),
    );
    assert.ok(marked);
    await session.click(await session.find('[data-e2e-target="1"]'));
    await until('desactivado en el panel', async () => (await stateOf('open-meteo')) === 'Disabled', 20_000);
    assert.equal((await handles()).length, before, 'ninguna ventana nueva');
    assert.deepEqual(enabledOnDisk(), ['home-assistant']);
  });
} finally {
  await session?.close().catch(() => undefined);
  driver?.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close?.();
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  if (failed > 0 && driverLog) console.log(`--- tauri-driver ---\n${driverLog.slice(-3000)}`);
}

console.log(failed === 0 ? '\nTodo bien.' : `\n${failed} fallo(s).`);
process.exit(failed === 0 ? 0 : 1);

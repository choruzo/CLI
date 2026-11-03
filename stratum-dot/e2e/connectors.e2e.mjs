/**
 * Los conectores del asistente de Dot (M17), de verdad: la app compilada contra
 * un `stratumd` real, el `companion` con un conector MCP (un bloc de notas) y un
 * **modelo real** (el provider de NaN, `NAN_API_KEY`).
 *
 *   Assistant → «añade una nota» → el companion llama a mcp__notes__add_note
 *             → aprobación en Dot → «30 min» → confirmación nativa con la duración
 *             → la nota se escribe → otra nota: sin preguntar (concesión)
 *             → panel de concesiones → Revoke → la siguiente vuelve a preguntar
 *             → list_notes (declarada de solo lectura) nunca pregunta
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/connectors.e2e.mjs [--model glm5.3-flash] [--shots <carpeta>]
 *
 * Mismos requisitos que `dot.e2e.mjs` (`tauri-driver` + driver nativo), más
 * `NAN_API_KEY`. HOME es temporal: no toca `~/.stratum` ni el daemon del
 * usuario. La key solo viaja por el entorno (`${NAN_API_KEY}` en la config).
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

const here = dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === 'win32';
const CLI = join(here, '..', '..', 'stratum-cli', 'dist', 'index.js');
const NOTES_SERVER = join(here, '..', '..', 'stratum-cli', 'scripts', 'tui', 'notes-mcp-server.mjs');
const APP = process.env.STRATUM_DOT_E2E_APP ?? join(here, '..', 'target', 'debug', WINDOWS ? 'stratum-dot.exe' : 'stratum-dot');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots');
const MODEL = arg('--model') ?? 'glm5.3-flash';
for (const [what, path] of [['la CLI compilada', CLI], ['la app', APP], ['el conector de notas', NOTES_SERVER]]) {
  if (!existsSync(path)) {
    console.error(`Falta ${what}: ${path}`);
    process.exit(2);
  }
}
if (!process.env.NAN_API_KEY) {
  console.error('Falta NAN_API_KEY: este E2E habla con un modelo real.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
// Un modelo real tarda: cada turno puede llevar varias llamadas de ~10 s.
const TURN_MS = 240_000;

async function until(what, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no se cumplió a tiempo: ${what}`);
    await sleep(250);
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
const notesFile = join(home, 'notes.json');
const env = { ...process.env, HOME: home, USERPROFILE: home, STRATUM_DOT_CLI: CLI, NO_COLOR: '1' };
if (WINDOWS) {
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
delete env.STRATUM_NO_DAEMON;

mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
writeFileSync(
  join(home, '.stratum', '.stratumrc.json'),
  JSON.stringify(
    {
      provider: {
        default: 'nan',
        providers: {
          nan: {
            type: 'openai-compatible',
            baseUrl: 'https://api.nan.builders/v1',
            model: MODEL,
            apiKey: '${NAN_API_KEY}',
            contextWindow: 131072,
          },
        },
      },
      memory: { autoExtract: false },
      // Un conector en un servidor MCP de verdad, solo del companion.
      companion: {
        mcp: {
          servers: [
            {
              name: 'notes',
              command: process.execPath,
              args: [NOTES_SERVER],
              env: { NOTES_FILE: notesFile },
              readOnlyTools: ['list_notes'],
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);
writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));

const notes = () => (existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, 'utf-8')) : []);
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });

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

async function openDot() {
  await startDriver();
  session = await Session.create(driverUrl, APP);
  await session.waitForElement('.top', { timeout: 30_000 });
  mainHandle = await wd('GET', '/window');
  await until('conectado', async () => (await session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`)) === 'connected', 40_000);
}

const approverState = () => session.execute(`return document.querySelector('.authority')?.getAttribute('data-approver') ?? null`);
const approvalCards = () => session.execute(`return [...document.querySelectorAll('[data-item][data-kind="approval"]')].map((c) => c.getAttribute('data-item'))`);
const waiting = () => session.execute(`return Number(document.querySelector('.waiting-badge')?.getAttribute('data-waiting') ?? 0)`);

/** Las tarjetas viven en el Centro de aprobaciones: se abre para resolver. */
async function openCenter() {
  if (await session.execute(`return !!document.querySelector('section[aria-label="Approval Center"]')`)) return;
  await session.click(await session.find('.waiting-badge'));
  await session.waitForElement('section[aria-label="Approval Center"]');
}
const statuses = () => session.execute(`return [...document.querySelectorAll('.detail [data-status]')].map((e) => e.getAttribute('data-status'))`);
const idle = async () => (await statuses()).includes('idle');
const grantRows = () =>
  session.execute(`return [...document.querySelectorAll('[data-grants] [data-grant]')].map((li) => li.innerText.trim())`);
const transcript = () =>
  session.execute(`return [...document.querySelectorAll('.messages > li')].map((li) => [li.getAttribute('data-kind'), li.innerText.trim()])`);

async function clickIn(selector, label) {
  const ok = await session.execute(
    `const [sel, label] = arguments;
     const b = [...document.querySelectorAll(sel + ' button')].find((x) => x.textContent.trim() === label);
     if (!b || b.disabled) return false;
     b.setAttribute('data-e2e-target', '1');
     return true;`,
    selector,
    label,
  );
  assert.ok(ok, `botón «${label}» en ${selector}`);
  await session.click(await session.find('[data-e2e-target="1"]'));
  await session.execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
}

async function confirmNative(trigger, expected = []) {
  const before = await handles();
  await trigger();
  const confirmHandle = await until('la ventana de confirmación', async () => (await handles()).find((h) => !before.includes(h)) ?? null, 20_000);
  await windowTo(confirmHandle);
  await session.waitForElement('#ok', { timeout: 20_000 });
  assert.match(await session.execute('return location.origin'), /dot-confirm/);
  await until('lo que dijo el daemon', async () => (await session.execute(`return document.getElementById('facts').innerText`)).length > 0, 10_000);
  const text = await session.execute(`return document.body.innerText`);
  for (const pattern of expected) assert.match(text, pattern);
  await shot('confirmacion');
  await until('deja confirmar', async () => !(await session.execute(`return document.getElementById('ok').disabled`)), 10_000);
  await session.click(await session.find('#ok'));
  await until('la ventana de confirmación se cierra', async () => !(await handles()).includes(confirmHandle), 20_000);
  await windowTo(mainHandle);
  return text;
}

async function unlock() {
  const before = await handles();
  await session.clickButton('Unlock approvals');
  const unlockHandle = await until('la ventana de desbloqueo', async () => (await handles()).find((h) => !before.includes(h)) ?? null);
  await windowTo(unlockHandle);
  await session.waitForElement('#key', { timeout: 20_000 });
  await session.type(await session.find('#key'), KEY);
  await session.click(await session.find('#submit'));
  await until('la ventana se cierra', async () => !(await handles()).includes(unlockHandle), 20_000);
  await windowTo(mainHandle);
  await until('desbloqueado', async () => (await approverState()) === 'ready');
}

/** El botón «Assistant» alterna la vista: se pulsa hasta estar en ella (y fuera del centro). */
async function openAssistant() {
  const inside = () =>
    session.execute(
      `return !!document.querySelector('.assistant .messages') && !document.querySelector('section[aria-label="Approval Center"]')`,
    );
  await until(
    'la vista Asistente',
    async () => {
      if (await inside()) return true;
      await session.clickButton('Assistant');
      await sleep(1500);
      return inside();
    },
    60_000,
  );
}

const userMessages = async () => (await transcript()).filter(([kind]) => kind === 'user').length;

/** Envía y espera a que el turno haya empezado: antes, la sesión aún dice `idle`. */
async function say(textToSend) {
  const before = await userMessages();
  const field = await session.find('.assistant .composer textarea');
  await session.type(field, textToSend);
  await session.clickButton('Send message');
  await until('el turno empieza', async () => (await userMessages()) > before && !(await idle()), 60_000);
}

/** Espera a que el turno pida una aprobación (o termine sin pedirla). */
async function nextApprovalOrIdle() {
  return until(
    'una aprobación o el fin del turno',
    async () => {
      if ((await waiting()) > 0) {
        await openCenter();
        const cards = await until('la tarjeta', async () => {
          const c = await approvalCards();
          return c.length > 0 ? c : null;
        });
        return { approval: cards[0] };
      }
      return (await idle()) ? { approval: null } : null;
    },
    TURN_MS,
  );
}

/** Lo que el daemon contó de la sesión del companion (la traza no, la foto). */
function companionSnapshot() {
  const ps = JSON.parse(cli(['ps', '--json']).stdout || '{}');
  return ps.sessions?.find((s) => /companion/.test(JSON.stringify(s))) ?? null;
}

try {
  await check('el asistente abre con su conector, y el centro se desbloquea', async () => {
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    // La autoridad de aprobar se desbloquea en el centro (ventana nativa aparte).
    await openCenter();
    await until('bloqueado', async () => (await approverState()) === 'locked');
    await unlock();
    await openAssistant();
    await until('la sesión del companion', async () => companionSnapshot(), 60_000);
    await shot('asistente');
  });

  await check('añadir una nota pide aprobación; «30 min» la confirma en nativo con la duración', async () => {
    await say('Add a note with exactly this text: "buy bread". Use your notes connector (the add_note tool). Do not ask me anything, just do it.');
    const first = await nextApprovalOrIdle();
    assert.ok(first.approval, `el modelo no pidió aprobación: ${JSON.stringify(await transcript())}`);
    const card = `[data-item="${first.approval}"]`;
    const cardText = await session.execute(`return document.querySelector(arguments[0]).innerText`, card);
    assert.match(cardText, /add_note/);
    assert.match(cardText, /Allow for/);
    await shot('aprobacion');
    const shown = await confirmNative(() => clickIn(card, '30 min'), [/Allow for 30 minutes/, /next 30 minutes/, /add_note/]);
    assert.match(shown, /any target/);
    await until('resuelta', async () => (await waiting()) === 0, 30_000);
    await openAssistant();
    await until('fin del turno', async () => await idle(), TURN_MS);
    assert.deepEqual(notes(), ['buy bread']);
  });

  await check('con la concesión, otra nota se escribe sin preguntar; el panel la enseña', async () => {
    await until('el panel de concesiones', async () => (await grantRows()).length === 1, 30_000);
    const [row] = await grantRows();
    assert.match(row, /mcp__notes__add_note/);
    assert.match(row, /(29|30) min left/);
    await shot('concesion');
    await say('Add another note with exactly this text: "call Ana". Use the add_note tool again.');
    const next = await nextApprovalOrIdle();
    assert.equal(next.approval, null, 'no debía pedir aprobación');
    assert.deepEqual(notes(), ['buy bread', 'call Ana']);
  });

  await check('una tool declarada de solo lectura no pregunta', async () => {
    await say('List my notes with the list_notes tool and tell me how many there are.');
    const next = await nextApprovalOrIdle();
    assert.equal(next.approval, null, 'list_notes es de solo lectura');
    const last = (await transcript()).filter(([kind]) => kind === 'tool').map(([, t]) => t).join('\n');
    assert.match(last, /list_notes/);
  });

  await check('revocar la concesión: desaparece del panel y la siguiente vuelve a preguntar', async () => {
    await clickIn('[data-grants]', 'Revoke');
    await until('sin concesiones', async () => (await grantRows()).length === 0, 20_000);
    await shot('revocada');
    await say('Add one more note with exactly this text: "water plants". Use the add_note tool.');
    const next = await nextApprovalOrIdle();
    assert.ok(next.approval, 'tras revocar debía preguntar');
    // Se deniega: directo, sin confirmación nativa.
    await clickIn(`[data-item="${next.approval}"]`, 'Deny');
    await until('resuelta', async () => (await waiting()) === 0, 30_000);
    await openAssistant();
    await until('fin del turno', async () => await idle(), TURN_MS);
    assert.deepEqual(notes(), ['buy bread', 'call Ana']);
    await shot('denegada');
  });

  await check('ni la key ni el token están en la ventana', async () => {
    const dom = await session.execute(`return document.documentElement.outerHTML + JSON.stringify({ ...localStorage })`);
    const token = JSON.parse(readFileSync(join(home, '.stratum', 'daemon', 'endpoint.json'), 'utf-8')).token;
    for (const secret of [process.env.NAN_API_KEY, token, KEY]) assert.ok(!dom.includes(secret), 'la ventana contiene un secreto');
  });
} finally {
  await session?.close().catch(() => undefined);
  driver?.kill();
  cli(['daemon', 'stop', '--force']);
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed > 0 && process.env.STRATUM_E2E_DEBUG) console.log(`--- tauri-driver ---\n${driverLog}`);
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

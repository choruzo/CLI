/**
 * El inspector de memoria del asistente de Dot (M17), de verdad: la app
 * compilada contra un `stratumd` real y el `companion` con un **modelo real**
 * (el provider de NaN, `NAN_API_KEY`).
 *
 *   memoria sembrada (extracción automática, con un secreto) → panel Memory:
 *   procedencia y secreto tapado → «recuerda que…» → el companion guarda con
 *   store_decision → el panel se refresca al terminar el turno: «Saved by the
 *   assistant», con Open a su conversación → buscar → olvidar (confirmación en
 *   la página) → ya no está, tampoco en disco → «This conversation»
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/memory.e2e.mjs [--model glm5.3-flash] [--shots <carpeta>]
 *
 * Mismos requisitos que `connectors.e2e.mjs`. HOME es temporal: no toca
 * `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
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
const APP = process.env.STRATUM_DOT_E2E_APP ?? join(here, '..', 'target', 'debug', WINDOWS ? 'stratum-dot.exe' : 'stratum-dot');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots');
const MODEL = arg('--model') ?? 'glm5.3-flash';
for (const [what, path] of [['la CLI compilada', CLI], ['la app', APP]]) {
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

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-mem-e2e-home-'));
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
      // Lo que guarde el companion, solo con store_decision: así la procedencia es fija.
      memory: { autoExtract: false },
    },
    null,
    2,
  ),
);

// Lo que recordaba de antes: extraído en segundo plano, con un secreto dentro.
const SECRET = 'ghp_' + 'Q7'.repeat(18);
const decisionsFile = join(home, '.stratum', 'companion', 'memory', 'decisions.json');
mkdirSync(dirname(decisionsFile), { recursive: true });
writeFileSync(
  decisionsFile,
  JSON.stringify(
    [
      {
        id: 'dec_20261101_seed01',
        timestamp: '2026-11-01T09:30:00.000Z',
        type: 'user_preference',
        title: 'The user reads the news at breakfast',
        content: `Prefers a short summary of the news at breakfast. Old note with a credential: ${SECRET}`,
        tags: ['routine', 'news'],
        importance: 'medium',
        embedding_ref: 'vec_dec_20261101_seed01',
        source: 'auto',
      },
    ],
    null,
    2,
  ),
);
const onDisk = () => (existsSync(decisionsFile) ? JSON.parse(readFileSync(decisionsFile, 'utf-8')) : []);
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
  await until('conectado', async () => (await session.execute(`return document.querySelector('[data-connection]')?.getAttribute('data-connection')`)) === 'connected', 40_000);
}

const statuses = () => session.execute(`return [...document.querySelectorAll('.detail [data-status]')].map((e) => e.getAttribute('data-status'))`);
const idle = async () => (await statuses()).includes('idle');
const transcript = () =>
  session.execute(`return [...document.querySelectorAll('.messages > li')].map((li) => [li.getAttribute('data-kind'), li.innerText.trim()])`);
const userMessages = async () => (await transcript()).filter(([kind]) => kind === 'user').length;

/** Las decisiones que pinta el panel: id, título y texto de la fila. */
const rows = () =>
  session.execute(
    `return [...document.querySelectorAll('section[aria-label="Memory"] .memory-list [data-decision]')].map((li) => ({ id: li.getAttribute('data-decision'), text: li.innerText.trim() }))`,
  );

/** Pulsa un botón de la fila de esa decisión (o del panel, sin id) por su texto. */
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
const row = (id) => `section[aria-label="Memory"] [data-decision="${id}"]`;

async function openAssistant() {
  const inside = () => session.execute(`return !!document.querySelector('.assistant .messages')`);
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

async function say(textToSend) {
  const before = await userMessages();
  const field = await session.find('.assistant .composer textarea');
  await session.type(field, textToSend);
  await session.clickButton('Send message');
  await until('el turno empieza', async () => (await userMessages()) > before && !(await idle()), 60_000);
}

/** Escribe en el buscador del panel (Ctrl+A y teclear: `clear` no pasa por React) y busca. */
async function search(text) {
  const field = await session.find('section[aria-label="Memory"] input[type="search"]');
  await session.click(field);
  // Ctrl+A y, para vaciar, Retroceso.
  await session.type(field, 'a' + (text === '' ? '' : text));
  await clickIn('section[aria-label="Memory"] .memory-search', 'Search');
}

let saved = null;
try {
  await check('el panel enseña lo sembrado con su procedencia y el secreto tapado', async () => {
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    await openAssistant();
    const [seeded] = await until('la decisión sembrada', async () => {
      const r = await rows();
      return r.length === 1 ? r : null;
    });
    assert.equal(seeded.id, 'dec_20261101_seed01');
    assert.match(seeded.text, /reads the news at breakfast/);
    await clickIn(row(seeded.id), 'The user reads the news at breakfast');
    const open = (await rows())[0].text;
    assert.match(open, /Extracted automatically from a conversation/);
    assert.match(open, /short summary of the news/);
    assert.ok(!open.includes(SECRET), 'el secreto debía salir tapado');
    await shot('sembrada');
  });

  await check('lo que guarda el asistente aparece al terminar el turno, con Open a su conversación', async () => {
    await say(
      'Please remember this for the future: my favourite colour is teal. Save it to your long-term memory with the store_decision tool (type user_preference). Do not ask me anything.',
    );
    await until('fin del turno', async () => await idle(), TURN_MS);
    const tools = (await transcript()).filter(([kind]) => kind === 'tool').map(([, t]) => t).join('\n');
    assert.match(tools, /store_decision/, `el modelo no llamó a store_decision: ${JSON.stringify(await transcript())}`);
    const fresh = await until('la decisión nueva en el panel', async () => {
      const r = await rows();
      return r.find((x) => x.id !== 'dec_20261101_seed01') ?? null;
    });
    saved = fresh.id;
    assert.match(fresh.text, /teal/i);
    // Se despliega: guardada por el asistente, en esta conversación, con Open.
    const title = await session.execute(`return document.querySelector(arguments[0] + ' .memory-title').textContent.trim()`, row(saved));
    await clickIn(row(saved), title);
    const open = await session.execute(`return document.querySelector(arguments[0]).innerText`, row(saved));
    assert.match(open, /Saved by the assistant in conversation/);
    const record = onDisk().find((d) => d.id === saved);
    assert.equal(record?.source, 'agent');
    assert.ok(record?.session_id, 'debía guardar la sesión');
    assert.ok(open.includes(record.session_id.slice(-8)), 'el id corto de la conversación');
    await session.execute(`document.querySelector(arguments[0] + ' button[aria-label^="Open the conversation"]').setAttribute('data-e2e-open', '1')`, row(saved));
    assert.ok(await session.execute(`return !!document.querySelector('[data-e2e-open]')`), 'falta Open');
    await shot('guardada');
  });

  await check('buscar encuentra lo guardado; vaciar la búsqueda vuelve a las últimas', async () => {
    await search('what colour does the user like');
    const found = await until('resultado de la búsqueda', async () => {
      const r = await rows();
      return r.some((x) => x.id === saved) ? r : null;
    }, 60_000);
    assert.ok(found.length >= 1);
    await shot('busqueda');
    await search('');
    await until('las dos de nuevo', async () => (await rows()).length === 2);
  });

  await check('olvidar pide confirmación en la página; Keep no borra; Forget sí, también en disco', async () => {
    await clickIn(row(saved), 'Forget');
    const group = `section[aria-label="Memory"] [data-decision="${saved}"] [role="group"]`;
    assert.match(await session.execute(`return document.querySelector(arguments[0]).innerText`, group), /will no longer recall it/);
    await clickIn(group, 'Keep');
    assert.ok(onDisk().some((d) => d.id === saved));
    await clickIn(row(saved), 'Forget');
    await shot('confirmar-olvido');
    await clickIn(group, 'Forget');
    await until('ya no está en el panel', async () => !(await rows()).some((x) => x.id === saved), 20_000);
    assert.ok(!onDisk().some((d) => d.id === saved), 'sigue en decisions.json');
    assert.deepEqual((await rows()).map((x) => x.id), ['dec_20261101_seed01']);
    await shot('olvidada');
  });

  await check('«This conversation» enseña la memoria de sesión (aún sin compactar)', async () => {
    await clickIn('[data-e2e="memory-session"]', 'Show');
    await until('la memoria de sesión', async () => /Nothing compacted yet\.|·/.test(await session.execute(`return document.querySelector('[data-e2e="memory-session"]').innerText`)), 20_000);
    const text = await session.execute(`return document.querySelector('[data-e2e="memory-session"]').innerText`);
    assert.match(text, /Kept only for this conversation/);
    assert.doesNotMatch(text, /cannot read/);
  });

  await check('ni la key ni el token ni el secreto sembrado están en la ventana', async () => {
    const dom = await session.execute(`return document.documentElement.outerHTML + JSON.stringify({ ...localStorage })`);
    const token = JSON.parse(readFileSync(join(home, '.stratum', 'daemon', 'endpoint.json'), 'utf-8')).token;
    for (const secret of [process.env.NAN_API_KEY, token, SECRET]) assert.ok(!dom.includes(secret), 'la ventana contiene un secreto');
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

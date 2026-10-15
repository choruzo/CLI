/**
 * Stratum Dot resuelve aprobaciones, preguntas y planes en su ventana (criterio
 * rey de M8): la app compilada contra un `stratumd` real con `approver.json`.
 *
 *   New chat → «borra» → approval.requested → Approval Center
 *            → Unlock (ventana nativa aparte: la clave no pasa por la principal)
 *            → Approve → la tool se ejecuta → el asistente responde
 *   + pausa y aprobación, pregunta, plan, cerrar y reabrir Dot con algo pendiente
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  npx tauri build --debug --no-bundle
 *                     node e2e/approvals.e2e.mjs [--shots <carpeta>]
 *
 * Mismos requisitos que `dot.e2e.mjs` (`tauri-driver` + driver nativo). HOME y
 * proyectos son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const KEY = `clave-e2e-${randomBytes(6).toString('hex')}`;
const WRONG = `mala-${randomBytes(6).toString('hex')}`;

function approverFile(key) {
  const params = { N: 1 << 15, r: 8, p: 1 };
  const salt = randomBytes(16);
  const hash = scryptSync(key.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * params.N * 8 });
  return JSON.stringify({ version: 1, algorithm: 'scrypt', ...params, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() });
}

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-appr-e2e-home-'));
const project = mkdtempSync(join(tmpdir(), 'dot-appr-e2e-proj-'));
const planned = mkdtempSync(join(tmpdir(), 'dot-appr-e2e-plan-'));
const victim = join(project, 'victim.txt');
writeFileSync(victim, 'no me borres\n');
writeFileSync(
  join(planned, '.stratumrc.json'),
  JSON.stringify({ environments: { dev: { match: ['local'], tier: 'development', requirePlan: true } } }),
);
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

const lastTool = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) return m.tool_calls.at(-1).function.name;
  }
  return null;
};
const mock = await startMockLlm(({ messages, last, said }) => {
  if (last.role === 'tool') {
    const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const tool = lastTool(messages);
    if (/PLAN MODE/.test(out)) {
      return toolCall('present_plan', { summary: 'Crear planned.txt', steps: [{ title: 'Escribir planned.txt' }] });
    }
    if (tool === 'present_plan' && !/reject/i.test(out)) return toolCall('write_file', { path: 'planned.txt', content: 'plan' });
    if (tool === 'question') return text(`Anotado: ${out.includes('production') ? 'production' : 'otra'}.`, 40);
    if (tool === 'exec') return text(/denied|rejected|not approved/i.test(out) ? 'No lo he borrado.' : 'Borrado: ya no está.', 40);
    return text(`Hecho (${tool}).`, 40);
  }
  if (said.includes('planifica')) return toolCall('write_file', { path: 'planned.txt', content: 'plan' });
  if (said.includes('pregunta')) {
    return toolCall('question', { questions: [{ question: '¿Entorno?', options: ['staging', 'production'] }] });
  }
  if (said.includes('borra')) return [...text('Voy a borrarlo.', 40), ...toolCall('exec', { command: 'rm victim.txt' })];
  return text('Vale.', 40);
});
mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));
writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
const daemonRunning = () => cli(['daemon', 'status']).status === 0;
const endpoint = () => JSON.parse(readFileSync(join(home, '.stratum', 'daemon', 'endpoint.json'), 'utf-8'));

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

/** Peticiones de ventanas (W3C): el cliente mínimo no las trae. */
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
const waiting = () => session.execute(`return Number(document.querySelector('.waiting-badge')?.getAttribute('data-waiting') ?? -1)`);
const cards = (kind) => session.execute(`return [...document.querySelectorAll('[data-item]${kind ? `[data-kind="${kind}"]` : ''}')].map((c) => c.getAttribute('data-item'))`);
const transcript = () =>
  session.execute(`return [...document.querySelectorAll('.messages > li')].map((li) => [li.getAttribute('data-kind'), li.innerText.trim()])`);
const statuses = () => session.execute(`return [...document.querySelectorAll('.detail [data-status]')].map((e) => e.getAttribute('data-status'))`);

/** Pulsa de verdad (WebDriver) el botón `label` de una tarjeta. */
async function clickInCard(itemId, label) {
  const ok = await session.execute(
    `const [id, label] = arguments;
     const b = [...document.querySelectorAll('[data-item="' + id + '"] button')].find((x) => x.textContent.trim() === label);
     if (!b || b.disabled) return false;
     b.setAttribute('data-e2e-target', '1');
     return true;`,
    itemId,
    label,
  );
  assert.ok(ok, `botón «${label}» de ${itemId}`);
  await session.click(await session.find('[data-e2e-target="1"]'));
  await session.execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
}

async function openCenter() {
  if (await session.execute(`return !!document.querySelector('section[aria-label="Approval Center"]')`)) return;
  await session.click(await session.find('.waiting-badge'));
  await session.waitForElement('section[aria-label="Approval Center"]');
}

async function backToSession() {
  await session.clickButton('Back to sessions');
  if (!(await session.execute(`return !!document.querySelector('.detail.session')`))) await session.click(await session.find('.row'));
  await session.waitForElement('.messages');
}

async function say(message) {
  await session.type(await session.find('.composer textarea'), message);
  await session.clickButton('Send message');
}

/**
 * La confirmación nativa (M9): `trigger` pide algo sensible en la principal;
 * se abre **otra ventana**, en otro origen y sin IPC, que enseña lo que dijo el
 * daemon. Se comprueba, se espera a que deje confirmar y se confirma allí (o se
 * cancela). Vuelve a la principal.
 */
let confirmations = 0;
async function confirmNative(trigger, { expect: expected = [], phrase, cancel = false } = {}) {
  const before = await handles();
  await trigger();
  const confirmHandle = await until('la ventana de confirmación', async () => (await handles()).find((h) => !before.includes(h)) ?? null, 20_000);
  await windowTo(confirmHandle);
  await session.waitForElement('#ok', { timeout: 20_000 });
  assert.match(await session.execute('return location.origin'), /dot-confirm/);
  // Sin IPC: ni aprobar ni nada desde aquí.
  const invoked = await session.execute(`
    const ipc = window.__TAURI_INTERNALS__;
    if (!ipc) return 'no-ipc';
    return ipc.invoke('dot_approver_status', {}).then(() => 'ok', () => 'denied');
  `);
  assert.ok(invoked === 'no-ipc' || invoked === 'denied', invoked);
  await until('lo que dijo el daemon', async () => (await session.execute(`return document.getElementById('facts').innerText`)).length > 0, 10_000);
  const text = await session.execute(`return document.body.innerText`);
  for (const pattern of expected) assert.match(text, pattern);
  // El foco empieza en Cancel, nunca en confirmar.
  assert.equal(await session.execute(`return document.activeElement?.id`), 'cancel');
  if (phrase !== undefined) await session.type(await session.find('#phrase'), phrase);
  await shot(`confirmacion-${++confirmations}`);
  if (cancel) {
    await session.click(await session.find('#cancel'));
  } else {
    await until('deja confirmar', async () => !(await session.execute(`return document.getElementById('ok').disabled`)), 10_000);
    await session.click(await session.find('#ok'));
  }
  await until('la ventana de confirmación se cierra', async () => !(await handles()).includes(confirmHandle), 20_000);
  await windowTo(mainHandle);
}

/** Desbloquea en la ventana nativa: la clave solo se teclea allí. */
async function unlockWith(key, { expectOk = true } = {}) {
  const before = await handles();
  if (!(await session.execute(`return [...document.querySelectorAll('button')].some((b) => /^(Unlock approvals|Try again)$/.test(b.textContent.trim()))`))) {
    throw new Error('no hay botón de desbloquear');
  }
  await session.clickButton((await session.button('Try again')) ? 'Try again' : 'Unlock approvals');
  const unlockHandle = await until('la ventana de desbloqueo', async () => (await handles()).find((h) => !before.includes(h)) ?? (before.length > 1 ? before.find((h) => h !== mainHandle) : null));
  await windowTo(unlockHandle);
  await session.waitForElement('#key', { timeout: 20_000 }).catch(async (err) => {
    const where = await session.execute('return location.href + " | " + document.title + " | " + (document.body?.innerText ?? "")').catch((e) => String(e));
    throw new Error(`${err.message} — en la ventana: ${where}`);
  });
  const title = await session.execute('return document.title');
  assert.equal(title, 'Unlock approvals — Stratum Dot');
  // Es otra página, en otro origen, sin el puente de la principal.
  const origin = await session.execute('return location.origin');
  assert.match(origin, /dot-unlock/);
  // Sin IPC: aquí ningún comando `dot_*` se atiende (ni el de aprobar ni el de leer el estado).
  const invoked = await session.execute(`
    const ipc = window.__TAURI_INTERNALS__;
    if (!ipc) return 'no-ipc';
    const tries = [
      ['dot_approver_status', {}],
      ['dot_approve', { sessionId: 'x', approvalId: 'y', forSession: false }],
    ];
    return Promise.all(tries.map(([cmd, args]) => ipc.invoke(cmd, args).then(() => cmd + ':ok', () => cmd + ':denied')));
  `);
  assert.ok(invoked === 'no-ipc' || invoked.every((r) => r.endsWith(':denied')), JSON.stringify(invoked));
  await session.execute(`document.getElementById('key').value = ''`);
  await session.type(await session.find('#key'), key);
  await session.click(await session.find('#submit'));
  if (expectOk) {
    await until('la ventana se cierra', async () => !(await handles()).includes(unlockHandle), 20_000);
    await windowTo(mainHandle);
    await until('desbloqueado', async () => (await approverState()) === 'ready');
    return null;
  }
  await until('el error', async () => /Could not unlock/.test(await session.execute(`return document.getElementById('status').textContent`)), 20_000);
  // El campo no conserva lo tecleado.
  assert.equal(await session.execute(`return document.getElementById('key').value`), '');
  return unlockHandle;
}

try {
  await check('la ventana abre, conecta y el centro está bloqueado (sin campo de clave en la principal)', async () => {
    assert.equal(cli(['daemon', 'start']).status, 0);
    await openDot();
    assert.equal(await waiting(), 0);
    await openCenter();
    await until('bloqueado', async () => (await approverState()) === 'locked');
    assert.equal(await session.execute(`return document.querySelectorAll('input[type="password"]').length`), 0);
    // La ventana principal no puede entregar una clave por el esquema de desbloqueo.
    const forged = await session.execute(`
      const url = navigator.userAgent.includes('Windows') ? 'http://dot-unlock.localhost/submit' : 'dot-unlock://localhost/submit';
      return fetch(url, { method: 'POST', body: 'no-es-la-clave' }).then((r) => 'status:' + r.status, () => 'blocked');
    `);
    assert.ok(forged === 'blocked' || /^status:(403|404)$/.test(forged), forged);
    assert.equal(await approverState(), 'locked');
    await shot('centro-bloqueado');
    await session.clickButton('Back to sessions');
  });

  let approvalId;
  await check('New chat → operación protegida → la solicitud aparece en el chat y en la cabecera', async () => {
    await session.clickButton('New chat');
    await session.waitForElement('.newchat-form');
    await session.type(await session.find('input[aria-label="Working directory"]'), project);
    await session.type(await session.find('textarea[aria-label="First message"]'), 'borra el fichero');
    await session.clickButton('Start chat');
    await session.waitForElement('.row[aria-label^="Session"]', { timeout: 40_000 });
    await session.waitForElement('section[aria-label="Waiting for you"]', { timeout: 40_000 });
    assert.match(await session.execute(`return document.querySelector('section[aria-label="Waiting for you"]').innerText`), /rm victim\.txt/);
    await until('la cabecera lo cuenta', async () => (await waiting()) === 1);
    assert.equal(existsSync(victim), true);
    await shot('chat-esperando');
  });

  await check('Open lleva a la tarjeta (con el foco en ella, no en Approve); bloqueado no deja aprobar', async () => {
    await session.clickButton('Open in the Approval Center: approval');
    await session.waitForElement('section[aria-label="Approval Center"]');
    [approvalId] = await cards('approval');
    assert.ok(approvalId);
    const focused = await session.execute(`return document.activeElement?.getAttribute('data-item') ?? document.activeElement?.tagName`);
    assert.equal(focused, approvalId);
    assert.equal(await session.execute(`return [...document.querySelectorAll('[data-item] button')].find((b) => b.textContent.trim() === 'Approve').disabled`), true);
    await shot('tarjeta-bloqueada');
  });

  await check('Unlock: ventana nativa aparte; una clave mala da un error genérico y la buena desbloquea', async () => {
    const left = await unlockWith(WRONG, { expectOk: false });
    await shot('desbloqueo-fallido');
    // Sin bucles: se espera un momento y se teclea otra vez, en la misma ventana.
    await sleep(2_300);
    await session.type(await session.find('#key'), KEY);
    await session.click(await session.find('#submit'));
    await until('la ventana se cierra', async () => !(await handles()).includes(left), 20_000);
    await windowTo(mainHandle);
    await until('desbloqueado', async () => (await approverState()) === 'ready');
    await shot('desbloqueado');
  });

  await check('M9: un webview que se salta la interfaz no aprueba nada; la principal ni ve ni toca la confirmación', async () => {
    await openCenter();
    const sessionId = await session.execute(`return document.querySelector('[data-item="' + arguments[0] + '"]').getAttribute('data-session')`, approvalId);
    // Desbloqueado, la principal invoca `dot_approve` por su cuenta (lo que haría un script inyectado).
    await session.execute(`
      window.__forged = 'pending';
      window.__TAURI_INTERNALS__.invoke('dot_approve', { sessionId: arguments[0], approvalId: arguments[1], forSession: false })
        .then(() => (window.__forged = 'approved'), (e) => (window.__forged = (e && e.kind) + ':' + (e && e.reason)));
    `, sessionId, approvalId);
    const confirmHandle = await until('se abre la confirmación nativa', async () => (await handles()).find((h) => h !== mainHandle) ?? null, 20_000);
    await sleep(1500);
    // Nada salió: la solicitud sigue pendiente y la tool no se ejecutó.
    assert.equal(existsSync(victim), true);
    assert.equal((await cards('approval')).length, 1);
    // La principal no puede confirmar por el esquema nativo, ni manejar ventanas.
    const forged = await session.execute(`
      const url = navigator.userAgent.includes('Windows') ? 'http://dot-confirm.localhost/confirm' : 'dot-confirm://localhost/confirm';
      return fetch(url, { method: 'POST', body: '' }).then((r) => 'status:' + r.status, () => 'blocked');
    `);
    assert.ok(forged === 'blocked' || /^status:(403|404)$/.test(forged), forged);
    const windows = await session.execute(`
      return window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows', {}).then(() => 'allowed', () => 'denied');
    `);
    assert.equal(windows, 'denied');
    // Otra petición no sustituye la ventana abierta.
    const second = await session.execute(`
      return window.__TAURI_INTERNALS__.invoke('dot_approve', { sessionId: arguments[0], approvalId: arguments[1], forSession: true })
        .then(() => 'approved', (e) => e.kind);
    `, sessionId, approvalId);
    assert.equal(second, 'not-sent');
    // La persona cancela en la ventana nativa: no se aprueba nada.
    await windowTo(confirmHandle);
    await session.waitForElement('#cancel', { timeout: 10_000 });
    await session.click(await session.find('#cancel'));
    await until('se cierra', async () => !(await handles()).includes(confirmHandle), 20_000);
    await windowTo(mainHandle);
    await until('el comando falla sin confirmar', async () => (await session.execute('return window.__forged')) === 'not-confirmed:cancelled');
    assert.equal(existsSync(victim), true);
    assert.equal((await cards('approval')).length, 1);
    await sleep(1200); // tras cancelar, un momento antes de otra confirmación
  });

  await check('Approve → confirmación nativa → approval.resolved → la tool se ejecuta → el asistente responde', async () => {
    await confirmNative(() => clickInCard(approvalId, 'Approve'), { expect: [/exec/, /rm victim\.txt/, /Approve/] });
    await until('la tarjeta desaparece', async () => (await cards('approval')).length === 0, 30_000);
    await session.waitForText('from Stratum Dot');
    await until('el fichero ya no está', async () => !existsSync(victim));
    await backToSession();
    await until('la respuesta', async () => (await transcript()).at(-1)?.[1] === 'Borrado: ya no está.', 30_000);
    const shown = await transcript();
    assert.ok(shown.some(([kind, t]) => kind === 'tool' && /exec/.test(t)));
    await shot('aprobado-y-respondido');
  });

  await check('en pausa: aprobar no reanuda; Resume ejecuta lo aprobado', async () => {
    writeFileSync(victim, 'otra vez\n');
    await say('borra el fichero otra vez');
    await until('pendiente', async () => (await waiting()) === 1, 30_000);
    await session.clickButton('Pause run');
    await openCenter();
    const [id] = await cards('approval');
    await confirmNative(() => clickInCard(id, 'Approve'));
    await session.waitForText('Approved. The run remains paused', { timeout: 30_000 });
    await sleep(800);
    assert.equal(existsSync(victim), true, 'aprobar no reanuda');
    await shot('aprobado-en-pausa');
    await backToSession();
    await until('en pausa', async () => (await statuses()).includes('paused'));
    await session.clickButton('Resume run');
    await until('se ejecuta al reanudar', async () => !existsSync(victim), 30_000);
    await until('responde', async () => (await transcript()).at(-1)?.[1] === 'Borrado: ya no está.', 30_000);
  });

  await check('pregunta: se contesta en su tarjeta y el run sigue', async () => {
    await say('pregunta algo');
    await until('pendiente', async () => (await waiting()) === 1, 30_000);
    await openCenter();
    const [id] = await cards('question');
    await session.execute(
      `const id = arguments[0]; const label = [...document.querySelectorAll('[data-item="' + id + '"] label.option')].find((l) => l.textContent.trim() === 'production'); label.setAttribute('data-e2e-target', '1');`,
      id,
    );
    await session.click(await session.find('[data-e2e-target="1"] input'));
    await session.execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
    await confirmNative(() => clickInCard(id, 'Send answers'), { expect: [/Answers you are sending/, /production/] });
    await until('respondida', async () => (await cards('question')).length === 0, 30_000);
    await backToSession();
    await until('la respuesta', async () => (await transcript()).at(-1)?.[1] === 'Anotado: production.', 30_000);
  });

  await check('plan: se aprueba el propuesto y se ejecuta', async () => {
    // Ventana compacta: la lista (con «New chat») se ve al dejar de mirar la sesión.
    await session.clickButton('Back to sessions');
    await session.clickButton('New chat');
    await session.waitForElement('.newchat-form');
    // El último directorio se recuerda (preferencia de M7): se sustituye.
    const dirField = await session.find('input[aria-label="Working directory"]');
    // Ctrl+A y teclear encima: `clear` de WebDriver no pasa por el estado de React.
    await session.type(dirField, 'a');
    await session.type(dirField, planned);
    await session.type(await session.find('textarea[aria-label="First message"]'), 'planifica el fichero');
    await session.clickButton('Start chat');
    await until('el plan', async () => (await waiting()) === 1, 40_000);
    await openCenter();
    const [id] = await cards('plan');
    assert.match(await session.execute(`return document.querySelector('[data-item="${id}"]').innerText`), /Crear planned\.txt/);
    await shot('plan');
    await confirmNative(() => clickInCard(id, 'Approve plan'), { expect: [/Crear planned\.txt/] });
    await until('se ejecuta', async () => existsSync(join(planned, 'planned.txt')), 40_000);
  });

  await check('Lock approvals: lo pendiente sigue a la vista, sin poder resolverlo', async () => {
    await openCenter();
    await session.clickButton('Lock approvals');
    await until('bloqueado', async () => (await approverState()) === 'locked');
    await session.clickButton('Back to sessions');
  });

  await check('cerrar Dot con algo pendiente no lo toca; al reabrir sigue ahí y el broker está bloqueado', async () => {
    writeFileSync(victim, 'tercera\n');
    // Ventana compacta: a la lista, y de ahí a la sesión del proyecto (la del plan también está).
    await session.clickButton('Back to sessions');
    await session.execute(
      `[...document.querySelectorAll('.row')].find((r) => r.innerText.toLowerCase().includes(arguments[0].toLowerCase()))?.setAttribute('data-e2e-target', '1')`,
      project,
    );
    await session.click(await session.find('[data-e2e-target="1"]'));
    await session.execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
    await session.waitForElement('.composer textarea');
    await say('borra el fichero de nuevo');
    await until('pendiente', async () => (await waiting()) === 1, 30_000);
    const pid = endpoint().pid;
    await session.clickButton('Quit Dot', { contains: true }).catch(() => undefined);
    await sleep(1500);
    await session.close().catch(() => undefined);
    session = null;
    driver.kill();
    assert.equal(daemonRunning(), true);
    assert.equal(endpoint().pid, pid);
    const listed = cli(['approvals', 'list', '--json']);
    assert.match(listed.stdout, /rm victim\.txt/, listed.stdout + listed.stderr);
    assert.equal(existsSync(victim), true);

    await openDot();
    await until('la cabecera lo cuenta', async () => (await waiting()) === 1, 40_000);
    await openCenter();
    await until('bloqueado', async () => (await approverState()) === 'locked');
    await unlockWith(KEY);
    const [id] = await cards('approval');
    await clickInCard(id, 'Deny');
    await until('denegada', async () => (await cards('approval')).length === 0, 30_000);
    assert.equal(existsSync(victim), true);
    await shot('reabierto-denegado');
  });

  await check('la clave no está en la ventana principal, ni en su almacenamiento, ni en el log de Dot', async () => {
    const dom = await session.execute(`return document.documentElement.outerHTML + JSON.stringify({ ...localStorage })`);
    for (const secret of [KEY, WRONG, endpoint().token]) assert.ok(!dom.includes(secret), 'la ventana la contiene');
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        // Solo ficheros: en Linux el daemon deja su unix socket aquí.
        else if (st.isFile() && st.size < 32 * 1024 * 1024) files.push(full);
      }
    };
    walk(home);
    assert.ok(files.some((f) => f.endsWith('dot.log')), 'el log de Dot');
    for (const file of files) {
      const content = readFileSync(file);
      assert.ok(!content.includes(KEY) && !content.includes(WRONG), `la clave está en ${file}`);
    }
  });
} finally {
  await session?.close().catch(() => undefined);
  driver?.kill();
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(500);
  for (const dir of [home, project, planned]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failed > 0 && process.env.STRATUM_E2E_DEBUG) console.log(`--- tauri-driver ---\n${driverLog}`);
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

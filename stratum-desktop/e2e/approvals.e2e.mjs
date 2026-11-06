import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockLlm, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { e2eConfig, launch, makeHome, send, waitForIdle, waitForReady } from './harness.mjs';

/**
 * Desktop resuelve lo que el asistente espera de una persona con las mismas
 * piezas que Stratum Dot (M8/M9): la autoridad de aprobar es otra conexión
 * (`dot_link::approver`), la clave se teclea en una ventana nativa aparte, y
 * lo sensible solo sale si se confirma en otra ventana nativa. Contra un
 * `stratumd` real con `approver.json`.
 *
 *   «guarda la clave» → write_file outputs/.env (ruta sensible: pide aprobación)
 *     → tarjeta bloqueada → Desbloquear (ventana `desktop-unlock`)
 *     → Aprobar → confirmación (ventana `desktop-confirm`) → el fichero existe
 *   + cancelar la confirmación no envía nada; denegar va directo; preguntas
 */

const KEY = `clave-e2e-${randomBytes(6).toString('hex')}`;
const WRONG = `mala-${randomBytes(6).toString('hex')}`;

/** El `approver.json` que escribe `stratum approvals set-key` (scrypt). */
function approverFile(key) {
  const params = { N: 1 << 15, r: 8, p: 1 };
  const salt = randomBytes(16);
  const hash = scryptSync(key.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * params.N * 8 });
  return JSON.stringify({
    version: 1,
    algorithm: 'scrypt',
    ...params,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: new Date().toISOString(),
  });
}

const lastTool = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) return m.tool_calls.at(-1).function.name;
  }
  return null;
};

const script = ({ messages, last, said }) => {
  if (last.role === 'tool') {
    const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    if (lastTool(messages) === 'question') return text(`Anotado: ${out.includes('producción') ? 'producción' : 'otra'}.`, 30);
    return text(/denied|rejected|not approved|denegad/i.test(out) ? 'No lo he guardado.' : 'Guardado.', 30);
  }
  if (said.includes('pregunta')) {
    return toolCall('question', { questions: [{ question: '¿Qué entorno?', options: ['pruebas', 'producción'] }] });
  }
  if (said.includes('guarda')) return [...text('Lo guardo.', 30), ...toolCall('write_file', { path: 'outputs/.env', content: 'TOKEN=1\n' })];
  return text('Vale.', 30);
};

describe('aprobar desde Desktop (E2E, broker nativo y confirmación)', () => {
  let app;
  let mock;
  let main;
  const s = () => app.session;

  /** Peticiones de ventanas (W3C): el cliente mínimo no las trae. */
  async function wd(method, path, body) {
    const res = await fetch(`${s().base}/session/${s().id}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.value?.error) throw new Error(`${method} ${path}: ${json.value?.error ?? res.status}`);
    return json.value;
  }
  const handles = () => wd('GET', '/window/handles');
  const windowTo = (handle) => wd('POST', '/window', { handle });
  const newWindow = (before) =>
    s().waitFor(async () => (await handles()).find((h) => !before.includes(h)) ?? null, {
      timeout: 20_000,
      message: 'una ventana nueva',
    });
  const gone = (handle) =>
    s().waitFor(async () => !(await handles()).includes(handle), { timeout: 20_000, message: 'la ventana se cierra' });

  /** En la ventana nativa no hay IPC: ningún `desktop_*` se atiende. */
  async function assertNoIpc() {
    const invoked = await s().execute(`
      const ipc = window.__TAURI_INTERNALS__;
      if (!ipc) return 'no-ipc';
      const tries = [['desktop_approver_status', {}], ['desktop_approve', { sessionId: 'x', approvalId: 'y', forSession: false }]];
      return Promise.all(tries.map(([cmd, args]) => ipc.invoke(cmd, args).then(() => cmd + ':ok', () => cmd + ':denied')));
    `);
    assert.ok(invoked === 'no-ipc' || invoked.every((r) => r.endsWith(':denied')), JSON.stringify(invoked));
  }

  const cardButton = (label) =>
    s().execute(
      `const b = [...document.querySelectorAll('.pending-card button')].find((x) => x.textContent.trim() === arguments[0]);
       return b ? { disabled: b.disabled } : null;`,
      label,
    );
  async function clickInCard(label) {
    const ok = await s().execute(
      `const b = [...document.querySelectorAll('.pending-card button')].find((x) => x.textContent.trim() === arguments[0]);
       if (!b || b.disabled) return false;
       b.setAttribute('data-e2e-target', '1');
       return true;`,
      label,
    );
    assert.ok(ok, `botón «${label}» habilitado en la tarjeta`);
    await s().click(await s().find('[data-e2e-target="1"]'));
    await s().execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
  }
  const authority = () => s().execute(`return document.querySelector('.pending-requests__authority')?.getAttribute('data-state') ?? null`);
  const cards = () => s().execute(`return document.querySelectorAll('.pending-card').length`);

  /** Pulsa `label` en la tarjeta; se abre la confirmación nativa; se confirma (o se cancela) allí. */
  async function confirmNative(label, { expect = [], cancel = false } = {}) {
    const before = await handles();
    await clickInCard(label);
    const confirm = await newWindow(before);
    await windowTo(confirm);
    await s().waitForElement('#ok', { timeout: 20_000 });
    assert.match(await s().execute('return location.origin'), /desktop-confirm/);
    await assertNoIpc();
    await s().waitFor(async () => (await s().execute(`return document.getElementById('facts').innerText`)).length > 0, {
      message: 'lo que dijo el daemon',
    });
    const body = await s().execute('return document.body.innerText');
    for (const pattern of expect) assert.match(body, pattern);
    // El foco empieza en Cancelar, nunca en confirmar.
    assert.equal(await s().execute('return document.activeElement?.id'), 'cancel');
    if (cancel) {
      await s().click(await s().find('#cancel'));
    } else {
      await s().waitFor(async () => !(await s().execute(`return document.getElementById('ok').disabled`)), {
        timeout: 10_000,
        message: 'deja confirmar',
      });
      await s().click(await s().find('#ok'));
    }
    await gone(confirm);
    await windowTo(main);
  }

  async function unlock(key, { expectOk = true } = {}) {
    const before = await handles();
    await s().clickButton('Desbloquear');
    const handle = await s().waitFor(
      async () => (await handles()).find((h) => !before.includes(h)) ?? (before.length > 1 ? before.find((h) => h !== main) : null),
      { timeout: 20_000, message: 'la ventana de desbloqueo' },
    );
    await windowTo(handle);
    await s().waitForElement('#key', { timeout: 20_000 });
    assert.equal(await s().execute('return document.title'), 'Desbloquear aprobaciones — Stratum Desktop');
    assert.match(await s().execute('return location.origin'), /desktop-unlock/);
    await assertNoIpc();
    await s().execute(`document.getElementById('key').value = ''`);
    await s().type(await s().find('#key'), key);
    assert.equal(await s().execute(`return document.getElementById('key').value`), key);
    await s().click(await s().find('#submit'));
    return finishUnlock(handle, { expectOk });
  }

  async function finishUnlock(handle, { expectOk }) {
    if (expectOk) {
      await gone(handle);
      await windowTo(main);
      await s().waitFor(async () => (await authority()) === 'ready', { message: 'desbloqueado' });
      return null;
    }
    await s().waitFor(
      async () => /No se pudo desbloquear/.test(await s().execute(`return document.getElementById('status').textContent`)),
      { timeout: 20_000, message: 'el error de desbloqueo' },
    );
    // El campo no conserva lo tecleado.
    assert.equal(await s().execute(`return document.getElementById('key').value`), '');
    return handle;
  }

  /** La carpeta de la conversación (la única bajo la raíz de Desktop). */
  function conversationDir() {
    const root = join(app.home, '.stratum', 'desktop', 'workspaces');
    const dirs = existsSync(root) ? readdirSync(root) : [];
    assert.equal(dirs.length, 1, `carpetas: ${dirs.join(', ')}`);
    return join(root, dirs[0]);
  }

  before(async () => {
    mock = await startMockLlm(script);
    const home = makeHome();
    mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
    writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));
    // Mismo modelo que anuncia el mock de la CLI.
    const config = (baseUrl) => {
      const value = e2eConfig(baseUrl);
      value.provider.providers.e2e.model = 'mock-model';
      return value;
    };
    app = await launch({ home, mock, config });
    await waitForReady(app.session);
    main = await wd('GET', '/window');
  });
  after(async () => {
    await app?.close();
    await mock?.close();
  });

  it('bloqueado: la tarjeta se ve y no resuelve; en la principal no hay campo de clave', async () => {
    await send(s(), 'guarda la clave en .env');
    await s().waitForText('Necesita tu aprobación', { timeout: 60_000 });
    assert.equal(await authority(), 'locked');
    assert.deepEqual(await cardButton('Aprobar'), { disabled: true });
    assert.deepEqual(await cardButton('Denegar'), { disabled: true });
    assert.equal(await s().execute(`return document.querySelectorAll('input[type="password"]').length`), 0);
  });

  it('una clave mala no desbloquea; la buena sí, en la ventana nativa', async () => {
    const window = await unlock(WRONG, { expectOk: false });
    // Sin bucles: la página deja volver a probar pasado un momento (el broker espera lo mismo).
    assert.equal(await s().execute(`return document.getElementById('submit').disabled`), true);
    await s().waitFor(async () => !(await s().execute(`return document.getElementById('submit').disabled`)), {
      timeout: 10_000,
      message: 'deja volver a probar',
    });
    await s().type(await s().find('#key'), KEY);
    await s().click(await s().find('#submit'));
    await finishUnlock(window, { expectOk: true });
  });

  it('cancelar la confirmación no envía nada; confirmar aprueba y el fichero existe', async () => {
    await confirmNative('Aprobar', { cancel: true, expect: [/write_file/, /\.env/] });
    assert.equal(await cards(), 1);
    assert.equal(await s().execute(`return document.querySelectorAll('.pending-card [role="alert"]').length`), 0);
    // Tras cancelar, la puerta espera un segundo antes de abrir otra confirmación.
    await new Promise((r) => setTimeout(r, 1500));
    await confirmNative('Aprobar', { expect: [/Aprobar/] });
    await s().waitFor(async () => (await cards()) === 0, { timeout: 30_000, message: 'la tarjeta se retira' });
    await s().waitForText('Guardado.', { timeout: 30_000 });
    await waitForIdle(s());
    assert.equal(readFileSync(join(conversationDir(), 'outputs', '.env'), 'utf-8'), 'TOKEN=1\n');
  });

  it('denegar va directo, sin ventana de confirmación', async () => {
    await send(s(), 'guarda otra vez');
    await s().waitFor(async () => (await cards()) === 1, { timeout: 60_000, message: 'otra aprobación' });
    const before = await handles();
    await clickInCard('Denegar');
    await s().waitForText('No lo he guardado.', { timeout: 30_000 });
    assert.deepEqual(await handles(), before);
    await waitForIdle(s());
  });

  it('las preguntas se contestan con su confirmación nativa', async () => {
    await send(s(), 'hazme una pregunta');
    await s().waitForText('¿Qué entorno?', { timeout: 60_000 });
    await s().execute(
      `[...document.querySelectorAll('.pending-card label')].find((l) => l.textContent.includes('producción')).querySelector('input').click()`,
    );
    await confirmNative('Enviar respuestas', { expect: [/Enviar respuestas/, /producción/] });
    await s().waitForText('Anotado: producción.', { timeout: 30_000 });
    await waitForIdle(s());
  });

  it('bloquear suelta la autoridad', async () => {
    await send(s(), 'guarda una vez más');
    await s().waitFor(async () => (await cards()) === 1, { timeout: 60_000, message: 'otra aprobación' });
    await s().clickButton('Bloquear');
    await s().waitFor(async () => (await authority()) === 'locked', { message: 'bloqueado' });
    assert.deepEqual(await cardButton('Aprobar'), { disabled: true });
  });
});

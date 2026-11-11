import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockLlm, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { cliSessions, e2eConfig, launch, makeHome, send, waitForIdle, waitForReady } from './harness.mjs';

/**
 * Modo código, paneles redimensionables y navegador de la sesión, en la app de
 * verdad contra un `stratumd` real:
 *
 *   conmutador Chat | Código centrado → carpeta de proyecto (diálogo nativo
 *   sustituido por `STRATUM_E2E_PICK`) → una sesión del agente de código en esa
 *   carpeta → cambios git y su diff → el agente abre su navegador contra un
 *   servidor local y Desktop lo enseña → deshacer el turno con desbloqueo y
 *   confirmación nativa.
 *
 * El navegador necesita un Edge/Chrome instalado; sin él esa parte se salta.
 */

const KEY = `clave-e2e-${randomBytes(6).toString('hex')}`;
const PAGE_TITLE = 'Tienda E2E';

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

function makeProject() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-e2e-proj-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'app.txt'), 'version 1\n');
  writeFileSync(join(dir, 'STRATUM.md'), '# Tienda E2E\n\nRegla del proyecto: usar pnpm.\n');
  git('init', '-q');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'add', '.');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'inicio');
  return dir;
}

function startSite() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${PAGE_TITLE}</title><h1>Catálogo</h1><button>Comprar</button>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

describe('modo código, paneles y navegador (E2E)', () => {
  let app;
  let mock;
  let site;
  let project;
  let main;
  const s = () => app.session;

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
    s().waitFor(async () => (await handles()).find((h) => !before.includes(h)) ?? null, { timeout: 20_000, message: 'una ventana nueva' });
  const gone = (handle) =>
    s().waitFor(async () => !(await handles()).includes(handle), { timeout: 20_000, message: 'la ventana se cierra' });
  const mode = () => s().execute(`return document.querySelector('.mode-switch')?.getAttribute('data-mode')`);
  const shot = async (name) => {
    const dir = process.env.STRATUM_E2E_SHOTS;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(await s().screenshot(), 'base64'));
  };

  const script = ({ last, said }) => {
    // La pregunta lateral (/btw) llega sin tools: se contesta con texto.
    if (said.includes('lateral')) return text('Respuesta lateral.', 20);
    if (last.role === 'tool') {
      const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      if (said.includes('verifica')) return text(out.includes(PAGE_TITLE) ? 'La página carga: Tienda E2E.' : `No cargó: ${out.slice(0, 200)}`, 20);
      return text('Cambiado.', 20);
    }
    if (said.includes('verifica')) return toolCall('browser_navigate', { url: site.url });
    if (said.includes('cambia')) {
      return [...text('Lo cambio.', 20), ...toolCall('write_file', { path: 'app.txt', content: 'version 2\nlinea nueva\n' })];
    }
    return text('Vale.', 20);
  };

  before(async () => {
    site = await startSite();
    project = makeProject();
    mock = await startMockLlm(script);
    const home = makeHome();
    mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
    writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));
    const config = (baseUrl) => {
      const value = e2eConfig(baseUrl);
      value.provider.providers.e2e.model = 'mock-model';
      return value;
    };
    app = await launch({ home, mock, config, env: { STRATUM_E2E_PICK: project } });
    await waitForReady(app.session);
    main = await wd('GET', '/window');
  });
  after(async () => {
    await app?.close();
    await mock?.close();
    await site?.close();
    if (project) rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  it('el conmutador Chat | Código está centrado en la barra de título', async () => {
    const box = await s().execute(`
      const r = document.querySelector('.mode-switch').getBoundingClientRect();
      const bar = document.querySelector('.titlebar').getBoundingClientRect();
      return { center: r.left + r.width / 2, bar: bar.left + bar.width / 2, inside: r.top >= bar.top && r.bottom <= bar.bottom };
    `);
    assert.ok(Math.abs(box.center - box.bar) <= 2, JSON.stringify(box));
    assert.equal(box.inside, true);
    assert.equal(await mode(), 'chat');
    await shot('01-chat');
  });

  it('el panel lateral se ensancha arrastrando su borde y lo recuerda', async () => {
    // Con el panel lateral cerrado no hay borde que arrastrar: se abre el primero del raíl.
    if (!(await s().execute(`return !!document.querySelector('.resize-handle[data-edge="right"]')`))) {
      await s().click(await s().find('.sidebar__rail .rail-button'));
    }
    await s().waitForElement('.resize-handle[data-edge="right"]');
    const width = () => s().execute(`return Math.round(document.querySelector('.resize-handle[data-edge="right"]').previousElementSibling.getBoundingClientRect().width)`);
    const before = await width();
    const id = await s().find('.resize-handle[data-edge="right"]');
    await wd('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', origin: { 'element-6066-11e4-a52e-4f735466cecf': id }, x: 0, y: 0, duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', origin: 'pointer', x: 60, y: 0, duration: 100 },
            { type: 'pointerMove', origin: 'pointer', x: 60, y: 0, duration: 100 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await wd('DELETE', '/actions');
    const after = await width();
    assert.ok(after >= before + 100 && after <= before + 125, `de ${before} a ${after}`);
    const stored = await s().execute(`return Object.entries(localStorage).filter(([k]) => /width/i.test(k)).map(([, v]) => Number(v))`);
    assert.ok(stored.includes(after), `guardado: ${JSON.stringify(stored)} (${after})`);
    await shot('02-resized');
  });

  it('Código pide la carpeta del proyecto; elegida, el primer mensaje abre una sesión del agente de código allí', async () => {
    await s().execute(`[...document.querySelectorAll('.mode-switch [role="radio"]')].find((b) => b.textContent.includes('Código')).click()`);
    await s().waitFor(async () => (await mode()) === 'code', { message: 'modo código' });
    await s().waitForText('Elige la carpeta del proyecto para empezar');
    await shot('03-code-empty');
    await s().clickButton('Elegir carpeta…');
    await s().waitForText(project, { timeout: 20_000 });
    await send(s(), 'cambia el fichero');
    await s().waitForText('Cambiado.', { timeout: 60_000 });
    await waitForIdle(s());
    const sessions = await cliSessions(app.home);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].origin, 'desktop');
    assert.notEqual(sessions[0].agent, 'assistant');
    assert.equal(realpathSync(sessions[0].cwd), project);
    assert.equal(readFileSync(join(project, 'app.txt'), 'utf8'), 'version 2\nlinea nueva\n');
  });

  it('los cambios del árbol de trabajo y su diff', async () => {
    await s().waitFor(
      () => s().execute(`return /1 fichero/.test(document.querySelector('.code-bar')?.innerText ?? '')`),
      { timeout: 30_000, message: 'el resumen de cambios en la barra' },
    );
    await s().execute(`[...document.querySelectorAll('.code-bar button')].find((b) => /1 fichero/.test(b.textContent)).click()`);
    await s().waitFor(() => s().execute(`return !!document.querySelector('.change-row__main')`), { message: 'la lista de cambios' });
    await s().execute(`document.querySelector('.change-row__main').click()`);
    await s().waitFor(
      () => s().execute(`return [...document.querySelectorAll('.diff__line[data-kind="add"]')].some((l) => l.textContent.includes('linea nueva'))`),
      { timeout: 20_000, message: 'el diff' },
    );
    assert.ok(await s().execute(`return [...document.querySelectorAll('.diff__line[data-kind="del"]')].some((l) => l.textContent.includes('version 1'))`));
    await shot('04-changes');
  });

  it('/tools abre el montaje de la sesión y el perfil de sesión se cambia desde él', async () => {
    await send(s(), '/tools');
    // El título va en mayúsculas por CSS: `innerText` lo devuelve transformado.
    await s().waitFor(
      () => s().execute(`return /Tools · \\d+/i.test(document.querySelector('.side-panel')?.innerText ?? '')`),
      { timeout: 20_000, message: 'las tools de la sesión' },
    );
    const tools = await s().execute(`return [...document.querySelectorAll('.setup-chips code')].map((c) => c.textContent)`);
    assert.ok(tools.includes('read_file') && tools.includes('exec'), JSON.stringify(tools));
    const checked = () =>
      s().execute(`return document.querySelector('.setup-option[aria-checked="true"] .setup-option__name')?.textContent ?? null`);
    const before = await checked();
    assert.ok(before, 'hay un perfil de sesión activo');
    const target = before.startsWith('full') ? 'code' : 'full';
    await s().execute(
      `[...document.querySelectorAll('.setup-option')].find((b) => b.querySelector('.setup-option__name').textContent.startsWith(${JSON.stringify(target)})).click()`,
    );
    // Sin estado optimista: cambia cuando el daemon lo publica y el panel lo relee.
    await s().waitFor(async () => ((await checked()) ?? '').startsWith(target), { timeout: 20_000, message: `el perfil ${target}` });
    const [session] = await cliSessions(app.home);
    assert.equal(session.sessionProfile, target);
    await shot('04b-setup');
    // De vuelta a los cambios, de donde se deshace.
    await send(s(), '/changes');
    await s().waitFor(() => s().execute(`return !!document.querySelector('.change-row__main')`), { message: 'la lista de cambios' });
  });

  it('/btw contesta aparte, sin entrar en la conversación', async () => {
    const [before] = await cliSessions(app.home);
    await send(s(), '/btw pregunta lateral: ¿qué cambiaste?');
    await s().waitFor(
      () => s().execute(`return (document.querySelector('.side-answer')?.innerText ?? '').includes('Respuesta lateral.')`),
      { timeout: 60_000, message: 'la respuesta lateral' },
    );
    // Ni la pregunta ni la respuesta son parte de la conversación.
    const outside = await s().execute(`
      const card = document.querySelector('.side-answer');
      const clone = document.body.cloneNode(true);
      clone.querySelector('.side-answer').remove();
      clone.querySelector('#chat-input')?.remove();
      return { inCard: card.innerText.includes('¿qué cambiaste?'), elsewhere: clone.innerText.includes('Respuesta lateral.') };
    `);
    assert.deepEqual(outside, { inCard: true, elsewhere: false });
    const [after] = await cliSessions(app.home);
    assert.equal(after.currentRunId, null);
    assert.equal(after.seq, before.seq, 'la pregunta lateral no publica nada en la sesión');
    await shot('04c-btw');
    await s().execute(`document.querySelector('.side-answer [aria-label="Cerrar la pregunta lateral"]').click()`);
    await s().waitFor(async () => !(await s().execute(`return !!document.querySelector('.side-answer')`)), { message: 'la tarjeta se cierra' });
  });

  it('/memory enseña la memoria del proyecto de la sesión y su STRATUM.md', async () => {
    await send(s(), '/memory');
    await s().waitFor(
      () => s().execute(`return !!document.querySelector('[aria-label="Memoria del proyecto"]')`),
      { timeout: 20_000, message: 'la memoria del proyecto' },
    );
    await s().waitFor(() => s().button('Ver STRATUM.md'), { timeout: 20_000, message: 'el STRATUM.md del proyecto' });
    await s().clickButton('Ver STRATUM.md');
    await s().waitFor(
      () => s().execute(`return (document.querySelector('.project-memory__text')?.textContent ?? '').includes('usar pnpm')`),
      { message: 'el contenido del STRATUM.md' },
    );
    await shot('04d-memory');
  });

  it('/rewind ofrece los turnos que cambiaron ficheros', async () => {
    await send(s(), '/rewind');
    const options = () =>
      s().execute(`return [...(document.querySelector('[aria-label="Cuántos turnos deshacer"]')?.options ?? [])].map((o) => o.textContent)`);
    await s().waitFor(async () => /el último turno · .+ · 1 fichero/.test((await options())[0] ?? ''), {
      timeout: 20_000,
      message: 'el turno deshacible',
    });
    assert.equal((await options()).length, 1);
  });

  it('el agente abre su navegador contra el servidor local y Desktop lo enseña', async (t) => {
    await send(s(), 'verifica la página');
    await s().waitFor(async () => /La página carga|No cargó|not available/.test(await s().bodyText()), { timeout: 90_000, message: 'el resultado del navegador' });
    await waitForIdle(s());
    const body = await s().bodyText();
    if (!/La página carga/.test(body) && /not available|browser_navigate/.test(body) && !/No cargó/.test(body)) {
      t.skip('sin navegador instalado');
      return;
    }
    assert.match(body, /La página carga: Tienda E2E\./);
    await s().clickButton('Navegador', { contains: true });
    await s().waitFor(
      () => s().execute(`const i = document.querySelector('.browser__viewport img'); return !!i && i.complete && i.naturalWidth > 300`),
      { timeout: 30_000, message: 'la captura del navegador' },
    );
    assert.equal(await s().execute(`return document.querySelector('.browser__address input').value`), site.url);
    assert.equal(await s().execute(`return document.querySelector('.browser__title').textContent`), PAGE_TITLE);
    await shot('05-browser');
    // La persona no abre lo externo desde aquí: eso lo pide el agente y se confirma.
    const input = await s().find('.browser__address input');
    await s().click(input);
    await s().execute(`const i = document.querySelector('.browser__address input'); i.select()`);
    await s().type(input, 'https://example.com');
    await s().waitForText('solo se abren direcciones locales', { timeout: 20_000 });
    assert.equal(await s().execute(`return document.querySelector('.browser__title').textContent`), PAGE_TITLE);
    // El panel del navegador también se redimensiona.
    assert.ok(await s().execute(`return !!document.querySelector('.resize-handle[data-edge="left"]')`));
    await s().clickButton('Cerrar el navegador');
  });

  it('deshacer el turno: desbloqueo y confirmación en ventanas nativas, y el fichero vuelve', async () => {
    await s().waitFor(() => s().button('Desbloquear para deshacer'), { timeout: 20_000, message: 'pide desbloquear' });
    let before = await handles();
    await s().clickButton('Desbloquear para deshacer');
    const unlock = await newWindow(before);
    await windowTo(unlock);
    await s().waitForElement('#key', { timeout: 20_000 });
    await s().type(await s().find('#key'), KEY);
    await s().click(await s().find('#submit'));
    await gone(unlock);
    await windowTo(main);
    await s().waitFor(() => s().button('Ver qué se desharía'), { timeout: 20_000, message: 'desbloqueado' });
    await s().execute(`const i = document.querySelector('[aria-label="Cuántos turnos deshacer"]'); if (i) i.scrollIntoView()`);
    await s().clickButton('Ver qué se desharía');
    await s().waitFor(async () => /Se restauran \(1\)/.test(await s().bodyText()), { timeout: 30_000, message: 'el plan' });
    assert.equal(readFileSync(join(project, 'app.txt'), 'utf8'), 'version 2\nlinea nueva\n');
    await shot('06-undo-plan');
    before = await handles();
    await s().clickButton('Deshacer…');
    const confirm = await newWindow(before);
    await windowTo(confirm);
    await s().waitForElement('#ok', { timeout: 20_000 });
    assert.match(await s().execute('return location.origin'), /desktop-confirm/);
    await s().waitFor(async () => (await s().execute(`return document.getElementById('facts').innerText`)).length > 0, { message: 'lo que dijo el daemon' });
    assert.match(await s().execute('return document.body.innerText'), /app\.txt/);
    assert.equal(await s().execute('return document.activeElement?.id'), 'cancel');
    await s().waitFor(async () => !(await s().execute(`return document.getElementById('ok').disabled`)), { timeout: 10_000, message: 'deja confirmar' });
    await s().click(await s().find('#ok'));
    await gone(confirm);
    await windowTo(main);
    await s().waitForText('Hecho: los ficheros han vuelto', { timeout: 30_000 });
    assert.equal(readFileSync(join(project, 'app.txt'), 'utf8'), 'version 1\n');
    assert.ok(existsSync(join(project, '.git')));
    await shot('07-undone');
  });

  it('volver a Chat deja la sesión de código en su modo', async () => {
    await s().execute(`[...document.querySelectorAll('.mode-switch [role="radio"]')].find((b) => b.textContent.includes('Chat')).click()`);
    await s().waitFor(async () => (await mode()) === 'chat', { message: 'modo chat' });
    assert.equal(await s().execute(`return !!document.querySelector('.code-bar')`), false);
    assert.doesNotMatch(await s().bodyText(), /Cambiado\./);
    await s().execute(`[...document.querySelectorAll('.mode-switch [role="radio"]')].find((b) => b.textContent.includes('Código')).click()`);
    await s().waitForText('Cambiado.', { timeout: 20_000 });
  });
});

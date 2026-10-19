import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliSessions, launch, send, waitForIdle, waitForReady } from './harness.mjs';
import { GREETING } from './mock-llm.mjs';

/**
 * M12 — Desktop conversa como cliente de `stratumd`: cada conversación es una
 * sesión normal del daemon (agente `assistant`, en su carpeta), que la CLI ve
 * igual que Desktop.
 */
describe('chat sobre stratumd (E2E, M12)', () => {
  let app;
  before(async () => {
    app = await launch();
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('frameless: TitleBar propia con sus controles', async () => {
    const s = app.session;
    for (const name of ['Minimizar', 'Maximizar', 'Cerrar']) {
      assert.ok(await s.button(name), `falta el control «${name}»`);
    }
    const decorated = await s.execute(
      `return document.querySelector('.titlebar').hasAttribute('data-tauri-drag-region')`,
    );
    assert.equal(decorated, true);
  });

  it('el primer mensaje abre una sesión del daemon; la respuesta llega en streaming', async () => {
    const s = app.session;
    await send(s, 'hola');
    await s.waitForText(GREETING, { timeout: 60_000 });
    await waitForIdle(s);
    // La sesión está en la lista porque el daemon la publica.
    await s.waitFor(
      () => s.execute(`return [...document.querySelectorAll('.conv-item__title')].some((e) => e.textContent.includes('hola'))`),
      { message: 'la sesión en la lista' },
    );
    // La CLI, otro cliente del mismo daemon, ve la misma sesión.
    const sessions = await cliSessions(app.home);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].origin, 'desktop');
    assert.equal(sessions[0].agent, 'assistant');
    assert.equal(sessions[0].host.kind, 'daemon');
    const announced = await s.execute(
      `return document.querySelector('.conversation [role="status"].sr-only')?.textContent`,
    );
    assert.equal(announced, 'Respuesta lista.');
  });

  it('con un run en marcha: indicador de estratos, controles del run y «Detener» lo cancela en el daemon', async () => {
    const s = app.session;
    await send(s, 'despacio, cuenta hasta doscientos');
    const phrase = await s.waitFor(
      () => s.execute(`return document.querySelector('.thinking__phrase')?.textContent ?? null`),
      { timeout: 10_000, message: 'el indicador de espera' },
    );
    assert.match(phrase, /…$/);
    await s.waitFor(() => s.button('Pausar'), { message: 'los controles del run' });
    await s.waitForText('3 4 5', { timeout: 30_000 });
    await s.clickButton('Detener');
    await s.waitForText('Respuesta detenida.');
    await waitForIdle(s);
  });

  it('lo que el asistente escribe en outputs/ aparece en el panel de ficheros', async () => {
    const s = app.session;
    await send(s, 'genera un informe');
    await s.waitForText('informe', { timeout: 60_000 });
    await waitForIdle(s);
    await s.clickButton('Ficheros de la conversación');
    await s.waitFor(
      () => s.execute(`return document.querySelector('.side-panel')?.innerText.includes('informe.md') ?? false`),
      { timeout: 20_000, message: 'informe.md en el panel de ficheros' },
    );
  });
});

describe('adjuntos en la carpeta de la sesión (E2E, D2 + M12)', () => {
  let app;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-e2e-pick-'));
    const file = join(dir, 'nota.txt');
    writeFileSync(file, 'El código es 4217.\n');
    // Con la feature `e2e`, el diálogo de abrir «elige» esta ruta.
    app = await launch({ env: { STRATUM_E2E_PICK: file } });
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('se adjunta en una conversación ya abierta y el asistente lo lee', async () => {
    const s = app.session;
    await send(s, 'hola');
    await s.waitForText(GREETING, { timeout: 60_000 });
    await waitForIdle(s);
    await s.clickButton('Adjuntar ficheros');
    await s.waitFor(
      () => s.execute(`return document.querySelector('.input-area')?.innerText.includes('nota.txt') ?? false`),
      { message: 'el adjunto listo' },
    );
    await send(s, 'lee el adjunto');
    await s.waitForText('El adjunto dice: El código es 4217.', { timeout: 60_000 });
    await waitForIdle(s);
  });
});

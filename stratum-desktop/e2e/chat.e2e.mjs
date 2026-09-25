import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launch, send, waitForIdle, waitForReady } from './harness.mjs';
import { GREETING, REASONING } from './mock-llm.mjs';

describe('chat (E2E)', () => {
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

  it('responde en streaming y guarda el razonamiento plegado', async () => {
    const s = app.session;
    await send(s, 'hola');
    await s.waitForText(GREETING, { timeout: 60_000 });
    await waitForIdle(s);
    // Bloque de razonamiento, plegado, que al abrirse enseña lo que pensó.
    const header = await s.waitForElement('.reasoning__header');
    assert.match(await s.text(header), /Razonó|Razonamiento/);
    assert.equal(await s.attribute(header, 'aria-expanded'), 'false');
    await s.click(header);
    await s.waitFor(
      async () =>
        (await s.execute(`return document.querySelector('.reasoning__body')?.innerText ?? ''`)).includes(
          REASONING.split(' ')[0],
        ),
      { message: 'el razonamiento desplegado' },
    );
    // El anuncio para lectores de pantalla.
    const announced = await s.execute(
      `return document.querySelector('.conversation [role="status"].sr-only')?.textContent`,
    );
    assert.equal(announced, 'Respuesta lista.');
    // El mock recibió la conversación con el mensaje del usuario.
    assert.ok(app.mock.requests.length >= 1);
  });

  it('mientras espera, el indicador de estratos; «Detener» corta la respuesta', async () => {
    const s = app.session;
    await send(s, 'despacio, cuenta hasta doscientos');
    // textContent y no el texto «visible»: la frase entra con opacidad 0.
    const phrase = await s.waitFor(
      () => s.execute(`return document.querySelector('.thinking__phrase')?.textContent ?? null`),
      { timeout: 10_000, message: 'el indicador de espera' },
    );
    assert.match(phrase, /…$/);
    await s.waitForText('3 4 5', { timeout: 30_000 });
    await s.clickButton('Detener');
    await s.waitForText('Respuesta detenida.');
    await waitForIdle(s);
  });
});

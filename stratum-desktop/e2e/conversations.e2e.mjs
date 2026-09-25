import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launch, send, waitForIdle, waitForReady } from './harness.mjs';
import { GREETING } from './mock-llm.mjs';

/** Títulos del listado de conversaciones, en orden. */
function titles(s) {
  return s.execute(
    `return [...document.querySelectorAll('.conv-item__title')].map((n) => n.textContent.trim())`,
  );
}

/**
 * Pulsa una acción (Renombrar, Eliminar) de una conversación concreta del
 * listado. Las acciones solo se ven con el ratón encima o el foco dentro: se
 * enfoca antes la conversación, como haría quien navega con Tab.
 */
async function itemAction(s, title, label) {
  const ok = await s.execute(
    `const [title, label] = arguments;
     const item = [...document.querySelectorAll('.conv-item')].find((li) => li.querySelector('.conv-item__title')?.textContent.trim() === title);
     const main = item?.querySelector('.conv-item__main');
     const action = item?.querySelector('[aria-label="' + label + '"]');
     if (!main || !action) return false;
     main.focus();
     action.setAttribute('data-e2e-action', '1');
     return true;`,
    title,
    label,
  );
  assert.ok(ok, `sin «${label}» para «${title}»`);
  const el = await s.find('[data-e2e-action="1"]');
  await s.execute(`document.querySelector('[data-e2e-action="1"]').removeAttribute('data-e2e-action')`);
  await s.click(el);
}

/** Abre una conversación del listado por su título. */
async function openItem(s, title) {
  const ok = await s.execute(
    `const t = [...document.querySelectorAll('.conv-item__title')].find((n) => n.textContent.trim() === arguments[0]);
     t?.closest('.conv-item__main')?.click();
     return !!t;`,
    title,
  );
  assert.ok(ok, `no está «${title}» en el listado`);
}

describe('conversaciones (E2E)', () => {
  let app;
  before(async () => {
    app = await launch();
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('el primer mensaje da título; «Nueva» abre otra conversación', async () => {
    const s = app.session;
    await send(s, 'hola primera');
    await s.waitForText(GREETING, { timeout: 60_000 });
    await waitForIdle(s);
    await s.waitFor(async () => (await titles(s)).includes('hola primera'), { message: 'el título' });

    await s.clickButton('Nueva');
    await s.waitForText('¿En qué puedo ayudarte?');
    await waitForReady(s);
    await send(s, 'hola segunda');
    await s.waitFor(async () => (await titles(s)).includes('hola segunda'), { message: 'el segundo título' });
    await waitForIdle(s);
    // La TitleBar enseña la conversación activa.
    await s.waitFor(
      async () => (await s.execute(`return document.querySelector('.titlebar__title').textContent`)) === 'hola segunda',
      { message: 'el título en la TitleBar' },
    );
  });

  it('cambiar, renombrar y eliminar', async () => {
    const s = app.session;
    // Cambiar a la primera: su respuesta vuelve a estar a la vista.
    await openItem(s, 'hola primera');
    await s.waitFor(
      async () => (await s.execute(`return document.querySelector('.titlebar__title').textContent`)) === 'hola primera',
      { message: 'la primera activa' },
    );
    await s.waitForText(GREETING);

    await itemAction(s, 'hola primera', 'Renombrar');
    const input = await s.waitForElement('.conv-item__rename');
    // Sin clear(): WebDriver desenfoca al vaciar, y el blur confirma el
    // renombrado. El input ya abre con el título seleccionado.
    await s.type(input, 'Renombrada\uE007');
    await s.waitFor(async () => (await titles(s)).includes('Renombrada'), { message: 'el nuevo título' });

    await itemAction(s, 'hola segunda', 'Eliminar');
    await s.waitForText('¿Eliminar esta conversación y sus ficheros?');
    await s.clickButton('Eliminar');
    await s.waitFor(async () => !(await titles(s)).includes('hola segunda'), { message: 'la conversación borrada' });
    assert.deepEqual((await titles(s)).filter((t) => t !== 'Nueva conversación'), ['Renombrada']);
  });
});

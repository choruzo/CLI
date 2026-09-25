import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launch, readConfig, waitForReady } from './harness.mjs';

describe('ajustes (E2E)', () => {
  let app;
  before(async () => {
    app = await launch();
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('cambiar una preferencia y guardar escribe el .stratumrc.json', async () => {
    const s = app.session;
    assert.equal(readConfig(app.home).desktop.notifications.enabled, false);
    await s.clickButton('Ajustes (Ctrl+,)');
    await s.waitForElement('.settings[role="dialog"]');
    await s.clickButton('Sistema');
    const box = await s.waitFor(
      () =>
        s.execute(
          `const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Notificar cuando termine'));
           const input = label?.querySelector('input[type="checkbox"]') ?? (label?.htmlFor && document.getElementById(label.htmlFor));
           if (!input) return null;
           input.setAttribute('data-e2e-box', '1');
           return true;`,
        ),
      { message: 'la casilla de notificaciones' },
    );
    assert.ok(box);
    await s.click(await s.find('[data-e2e-box="1"]'));
    await s.waitForText('Cambios sin guardar');
    await s.clickButton('Guardar');
    await s.waitFor(() => readConfig(app.home).desktop.notifications.enabled === true, {
      message: 'la config guardada en disco',
    });
    await s.waitForText('Sin cambios');
  });

  it('las secciones se recorren con flechas y Esc cierra', async () => {
    const s = app.session;
    const tab = await s.find('[role="tab"][aria-selected="true"]');
    await s.click(tab);
    await s.type(tab, '\uE015'); // ↓
    const selected = await s.execute(
      `return document.querySelector('[role="tab"][aria-selected="true"]').textContent`,
    );
    assert.notEqual(selected, 'Sistema');
    assert.equal(
      await s.execute(`return document.activeElement.getAttribute('role')`),
      'tab',
      'el foco sigue en las pestañas',
    );
    await s.type(tab, '\uE00C'); // Esc
    await s.waitFor(async () => !(await s.execute(`return !!document.querySelector('.settings')`)), {
      message: 'Ajustes cerrado',
    });
  });
});

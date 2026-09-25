import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { configPath, launch, readConfig, send, waitForReady } from './harness.mjs';
import { GREETING, MODEL } from './mock-llm.mjs';

/** Rellena el input que sigue a la etiqueta `label` del wizard. */
async function fill(s, label, text) {
  const ok = await s.execute(
    `const l = [...document.querySelectorAll('.wizard label')].find((x) => x.textContent.trim().startsWith(arguments[0]));
     const input = l && document.getElementById(l.htmlFor);
     if (!input) return false;
     input.setAttribute('data-e2e-input', '1');
     return true;`,
    label,
  );
  assert.ok(ok, `sin campo «${label}»`);
  const input = await s.find('[data-e2e-input="1"]');
  await s.execute(`document.querySelector('[data-e2e-input="1"]').removeAttribute('data-e2e-input')`);
  await s.clear(input);
  await s.type(input, text);
}

describe('onboarding sin .stratumrc.json (E2E)', () => {
  let app;
  before(async () => {
    app = await launch({ config: false });
  });
  after(async () => {
    await app?.close();
  });

  it('bienvenida → wizard → primera respuesta', async () => {
    const s = app.session;
    assert.equal(existsSync(configPath(app.home)), false);
    await s.waitForText('Te damos la bienvenida a Stratum', { timeout: 60_000 });
    await s.clickButton('Conectar un modelo');
    await s.clickButton('Otro (OpenAI-compatible)', { contains: true });
    await fill(s, 'Base URL', app.mock.baseUrl);
    await s.clickButton('Siguiente');
    await fill(s, 'Nombre', 'e2e');
    await s.clickButton('Siguiente');
    // El wizard sondea /models del mock y ofrece el modelo.
    await s.clickButton(MODEL, { timeout: 20_000 });
    await s.clickButton('Siguiente');
    await s.clickButton('Guardar');

    await s.waitFor(() => existsSync(configPath(app.home)), { message: 'la config escrita' });
    const config = readConfig(app.home);
    assert.equal(config.provider.default, 'e2e');
    assert.equal(config.provider.providers.e2e.baseUrl, app.mock.baseUrl);
    assert.equal(config.provider.providers.e2e.model, MODEL);

    await s.waitFor(async () => !(await s.execute(`return !!document.querySelector('.onboarding')`)), {
      timeout: 30_000,
      message: 'el onboarding cerrado',
    });
    await waitForReady(s);
    await send(s, 'hola');
    await s.waitForText(GREETING, { timeout: 60_000 });
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, makeHome, waitForReady } from './harness.mjs';

/** `<app_config_dir>` de la app dentro del HOME aislado del arnés. */
function appConfigDir(home) {
  return process.platform === 'win32'
    ? join(home, 'AppData', 'Roaming', 'dev.stratum.desktop')
    : join(home, '.config', 'dev.stratum.desktop');
}

/** Posición y tamaño de la ventana según el propio webview (px CSS). */
function geometry(s) {
  return s.execute(`return {
    x: window.screenX, y: window.screenY,
    w: window.outerWidth, h: window.outerHeight,
    sw: screen.width, sh: screen.height,
  }`);
}

describe('ventana frameless (E2E, 15.14)', () => {
  let app;
  let home;
  before(async () => {
    home = makeHome();
    // Se cerró en un monitor que ya no está: coordenadas que no existen.
    mkdirSync(appConfigDir(home), { recursive: true });
    writeFileSync(
      join(appConfigDir(home), 'window-state.json'),
      JSON.stringify({ x: -30000, y: -30000, width: 1000, height: 650, maximized: false }),
    );
    app = await launch({ home });
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('una posición guardada fuera de todo monitor se restaura visible', async () => {
    const g = await geometry(app.session);
    assert.ok(g.x > -50 && g.x < g.sw - 50, `x fuera de la pantalla: ${JSON.stringify(g)}`);
    assert.ok(g.y >= -10 && g.y < g.sh - 32, `y fuera de la pantalla: ${JSON.stringify(g)}`);
  });

  it('maximizar y restaurar con los controles propios', async () => {
    const s = app.session;
    const before = await geometry(s);
    await s.clickButton('Maximizar');
    await s.waitFor(() => s.button('Restaurar'), { message: 'el botón «Restaurar» (ventana maximizada)' });
    const max = await geometry(s);
    assert.ok(max.w >= before.w && max.h >= before.h, `no creció: ${JSON.stringify({ before, max })}`);
    await s.clickButton('Restaurar');
    await s.waitFor(() => s.button('Maximizar'), { message: 'el botón «Maximizar» (restaurada)' });
  });

  it('doble clic en la barra de título maximiza y restaura', async () => {
    const s = app.session;
    const title = await s.find('.titlebar__title');
    await s.doubleClick(title);
    await s.waitFor(() => s.button('Restaurar'), { message: 'maximizada por doble clic' });
    await s.doubleClick(title);
    await s.waitFor(() => s.button('Maximizar'), { message: 'restaurada por doble clic' });
  });

  it('«Cerrar» cierra la app y guarda dónde estaba', async () => {
    const s = app.session;
    const file = join(appConfigDir(home), 'window-state.json');
    const seeded = readFileSync(file, 'utf8');
    await s.clickButton('Cerrar').catch(() => undefined);
    await s.waitFor(() => existsSync(file) && readFileSync(file, 'utf8') !== seeded, {
      timeout: 20_000,
      message: 'window-state.json reescrito al cerrar',
    });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(saved.x > -30000 && saved.width > 0, `sin la posición ajustada: ${JSON.stringify(saved)}`);
  });
});

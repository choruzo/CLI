import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { e2eConfig, launch, makeHome, send, waitForIdle, waitForReady } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

/**
 * Retención (D3) de punta a punta: una conversación con ficheros se queda sin
 * uso; al volver a abrir la app, el janitor la comprime a tar.gz, y al abrir
 * la conversación sus ficheros se restauran.
 */
describe('retención de workspaces (E2E)', () => {
  let home;
  let mock;
  let app;
  const root = () => join(home, '.stratum', 'desktop', 'workspaces');

  before(async () => {
    home = makeHome();
    mock = await startMockLlm();
    const picks = join(home, 'elegidos');
    mkdirSync(picks, { recursive: true });
    writeFileSync(join(picks, 'nota.txt'), 'Nota para la retención\n');
    app = await launch({ home, mock, env: { STRATUM_E2E_PICK: join(picks, 'nota.txt') } });
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
    await mock?.close();
  });

  it('una conversación con ficheros sin uso se comprime y se restaura al abrirla', async () => {
    let s = app.session;
    await s.clickButton('Adjuntar ficheros');
    await s.waitFor(() => s.button('Quitar nota.txt'), { message: 'el chip del adjunto' });
    await send(s, 'lee el adjunto');
    await s.waitForText('El adjunto dice: Nota para la retención', { timeout: 60_000 });
    await waitForIdle(s);
    const [id] = readdirSync(root()).filter((n) => /^[0-9a-f-]{36}$/.test(n));
    assert.ok(id, 'sin carpeta de workspace');

    // Se deja activa otra conversación: la app reabre la última activa al
    // arrancar, y una conversación abierta no es «sin uso».
    await s.clickButton('Nueva');
    await s.waitForText('¿En qué puedo ayudarte?');
    // Cerrar y volver con una retención de ~1 s: al arrancar, el janitor la comprime.
    await app.close({ keepHome: true, keepMock: true });
    await new Promise((r) => setTimeout(r, 2_500));
    const quick = { desktop: { workspaces: { compressAfterDays: 0.00002, deleteAfterDays: 0 } } };
    app = await launch({ home, mock, config: (url) => e2eConfig(url, quick) });
    s = app.session;
    await waitForReady(s);
    await s.waitFor(() => existsSync(join(root(), `${id}.tar.gz`)), {
      timeout: 30_000,
      message: 'el tar.gz del workspace',
    });
    assert.equal(existsSync(join(root(), id)), false, 'la carpeta sigue ahí');

    // Abrirla la restaura.
    const opened = await s.execute(
      `const t = [...document.querySelectorAll('.conv-item__title')].find((n) => n.textContent.trim() === 'lee el adjunto');
       t?.closest('.conv-item__main')?.click();
       return !!t;`,
    );
    assert.ok(opened, 'no está la conversación en el listado');
    await s.waitFor(() => existsSync(join(root(), id, 'inputs', 'nota.txt')), {
      timeout: 30_000,
      message: 'los ficheros restaurados',
    });
    await s.waitForText('El adjunto dice: Nota para la retención');
  });
});

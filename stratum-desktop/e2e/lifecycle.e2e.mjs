import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliSessions,
  daemonRunning,
  launch,
  makeHome,
  send,
  startDaemon,
  stopDaemon,
  waitForIdle,
  waitForReady,
} from './harness.mjs';
import { GREETING, startMockLlm } from './mock-llm.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Abre desde la lista la sesión cuyo título contiene `title`. */
async function openFromList(s, title) {
  await s.waitFor(
    () =>
      s.execute(
        `const b = [...document.querySelectorAll('.conv-item__main')].find((e) => e.textContent.includes(${JSON.stringify(title)}));
         if (b) b.click();
         return !!b;`,
      ),
    { timeout: 30_000, message: `la sesión «${title}» en la lista` },
  );
}

/**
 * M12 — el ciclo de vida de Desktop no es el de sus sesiones:
 *
 *   conversación → cerrar Desktop a mitad de un run → el run sigue en el daemon
 *   → abrir Desktop → la misma sesión, reconstruida de las fotos
 *   → reiniciar el daemon → la sesión vuelve (M11) → se continúa
 *
 * Nada de esto lo restaura Desktop: no guarda conversaciones. Lo cuenta el daemon.
 */
describe('cerrar Desktop y reiniciar el daemon (E2E, M12)', () => {
  let home;
  let mock;
  let app;
  before(async () => {
    home = makeHome();
    mock = await startMockLlm();
  });
  after(async () => {
    await app?.close().catch(() => undefined);
    stopDaemon(home, { force: true });
    await mock?.close();
  });

  it('cerrar Desktop a mitad de un run no lo para: el daemon lo termina', async () => {
    app = await launch({ home, mock });
    await waitForReady(app.session);
    await send(app.session, 'hola');
    await app.session.waitForText(GREETING, { timeout: 60_000 });
    await waitForIdle(app.session);
    await send(app.session, 'despacio, cuenta hasta doscientos');
    await app.session.waitForText('3 4 5', { timeout: 30_000 });
    await app.close({ keepHome: true, keepMock: true });
    app = null;

    assert.equal(daemonRunning(home), true);
    const [session] = await cliSessions(home);
    assert.equal(session.state, 'running');
    // Sin Desktop, el run llega a su final.
    const deadline = Date.now() + 90_000;
    while ((await cliSessions(home))[0].state !== 'idle') {
      if (Date.now() > deadline) throw new Error('el run no terminó sin Desktop');
      await sleep(500);
    }
  });

  it('al abrir Desktop, la misma sesión vuelve de las fotos del daemon', async () => {
    const [before] = await cliSessions(home);
    app = await launch({ home, mock });
    await waitForReady(app.session);
    // Está en la lista porque el daemon la publica; al abrirla, su conversación
    // sale de su foto. (Con WebDriver cada arranque es un perfil de WebView2
    // nuevo, así que aquí no se recuerda la última selección.)
    await openFromList(app.session, 'hola');
    await app.session.waitForText(GREETING, { timeout: 30_000 });
    await app.session.waitForText('200', { timeout: 30_000 });
    const [after] = await cliSessions(home);
    assert.equal(after.id, before.id);
  });

  it('reiniciar el daemon con Desktop abierto: reconecta, la sesión vuelve y se continúa', async () => {
    const [before] = await cliSessions(home);
    stopDaemon(home);
    await app.session.waitForText('Reconectando', { timeout: 30_000 }).catch(() => undefined);
    startDaemon(home);
    await waitForReady(app.session, 60_000);
    await app.session.waitForText(GREETING, { timeout: 30_000 });
    await send(app.session, 'hola otra vez');
    await waitForIdle(app.session, 60_000);
    const [after] = await cliSessions(home);
    assert.equal(after.id, before.id);
    assert.equal(after.origin, 'desktop');
  });
});

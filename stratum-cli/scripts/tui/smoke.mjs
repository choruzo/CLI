/**
 * Recorrido de humo por la TUI de `stratum chat` contra el mock: bienvenida,
 * paleta, turno, tool call, confirmación destructiva, cancelación, errores y
 * salida. Sirve de comprobación rápida y de ejemplo de uso del arnés.
 *
 *   npm run build && npm run tui:smoke            # solo ✓/✗
 *   npm run tui:smoke -- --show                   # además, cada pantalla
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';
import { startMockLlm, mockConfig } from './mock-llm.mjs';

const SHOW = process.argv.includes('--show');
let failed = 0;

async function check(name, t, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    if (SHOW) t.shot(name, { last: 18 });
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${String(err.message).split('\n').join('\n  ')}`);
    if (!/--- pantalla ---/.test(String(err.message))) t.shot(`pantalla en el fallo: ${name}`);
  }
}

async function conversation() {
  const mock = await startMockLlm();
  const t = launch({ config: mockConfig(mock.baseUrl), files: { 'victima.txt': 'x\n' } });
  try {
    await check('bienvenida: aparece el prompt', t, async () => {
      await t.waitForBanner();
    });

    await check('bienvenida: paleta de /comandos', t, async () => {
      await t.type('/');
      await t.waitFor(/▶ \/help/);
      await t.key('down', 2);
      await t.waitFor(/▶ \/plan/);
      assert.equal(t.styleOf('▶')?.bold, true);
      await t.type('cont');
      await t.waitFor(/▶ \/context/);
      await t.key('esc');
      await t.waitGone(/▶ \/context/);
      await t.key('ctrl+u');
      await t.waitFor(/Type your first message/);
    });

    await check('bienvenida: Enter ejecuta el comando seleccionado', t, async () => {
      await t.type('/cont');
      await t.waitFor(/▶ \/context/);
      await t.key('enter');
      await t.waitFor(/Uso del contexto:/);
      await t.waitFor(/Type a message or \/ for commands/);
    });

    await check('conversación: paleta, Tab completa y Ctrl+U limpia', t, async () => {
      await t.type('/mod');
      await t.waitFor(/▶ \/model/);
      await t.key('tab');
      await t.waitFor(/❯❯ \/model/);
      await t.key('ctrl+u');
      await t.waitFor(/Type a message or \/ for commands/);
    });

    await check('turno: razonamiento plegado, markdown y barra de estado', t, async () => {
      await t.submit('hola');
      await t.waitFor(/Hola desde el mock/);
      await t.waitForIdle();
      const screen = t.screen();
      assert.match(screen, /⊙ razonó · 3 palabras/);
      assert.match(screen, /• uno/);
      assert.match(screen, /● mock │ mock-model/);
    });

    await check('tool call: se ejecuta y se expande con Tab + Space', t, async () => {
      await t.submit('lista el directorio');
      await t.waitFor(/✓ list_directory/);
      await t.waitFor(/Resultado de la tool recibido/);
      await t.waitForIdle();
      await t.key('tab');
      await t.key('space');
      await t.waitFor(/│ victima\.txt/);
      await t.key('esc');
    });

    await check('confirmación destructiva: N deniega y no se borra nada', t, async () => {
      await t.submit('borra el fichero');
      await t.waitFor(/⚠ Operación destructiva/);
      assert.match(t.screen(), /exec \[local\]: (Remove-Item|rm) victima\.txt/);
      await t.type('n');
      await t.waitFor(/✗ exec │ User denied/);
      await t.waitForIdle();
      assert.ok(existsSync(join(t.project, 'victima.txt')));
    });

    await check('error del provider (401): caja de error fatal', t, async () => {
      await t.submit('error401');
      await t.waitFor(/✗ Error fatal/);
      assert.match(t.screen(), /401/);
    });
  } finally {
    await t.close();
    await mock.close();
  }
}

async function cancelAndExit() {
  const mock = await startMockLlm();
  const t = launch({ config: mockConfig(mock.baseUrl), env: { STRATUM_NO_BROWSER: '1' } });
  try {
    await check('Ctrl+C a mitad de respuesta cancela el turno y la sesión sigue', t, async () => {
      await t.waitForBanner();
      await t.submit('responde lento');
      await t.waitFor(/dos tres/);
      await t.key('ctrl+c');
      await t.waitFor(/Type a message or \/ for commands/, 5000);
      assert.equal(t.exited(), null);
      assert.doesNotMatch(t.screen(), /once doce/);
    });

    await check('/help se resuelve en local, sin llamar al modelo', t, async () => {
      const before = mock.requests.length;
      await t.submit('/help');
      await t.waitFor(/\/quit\s+Termina la sesión/);
      assert.equal(mock.requests.length, before);
    });

    await check('/auditor levanta el visor con la traza de la sesión', t, async () => {
      await t.submit('/auditor');
      await t.waitFor(/Trayectoria de la sesión: http/);
      const url = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//.exec(
        t.screen().replace(/\n/g, ''),
      )[0];
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Trayectoria/);
      // El turno cancelado de antes ya está en la traza que sirve el visor.
      const events = await fetch(`${url}events`);
      const { value } = await events.body.getReader().read();
      assert.match(new TextDecoder().decode(value), /connected/);
      await t.submit('/auditor stop');
      await t.waitFor(/Visor de trayectoria cerrado/);
    });

    await check('/comando desconocido: error en local, no llega al modelo', t, async () => {
      const before = mock.requests.length;
      await t.submit('/noexiste');
      await t.waitFor(/✗ Comando desconocido: \/noexiste/);
      await sleep(500);
      assert.equal(mock.requests.length, before);
      assert.match(t.tail(3), /Type a message or \/ for commands/);
    });

    await check('doble Ctrl+C sale con exit 0', t, async () => {
      await t.key('ctrl+c');
      await sleep(200);
      assert.equal(t.exited(), null);
      await t.key('ctrl+c');
      assert.equal(await t.waitExit(), 0);
    });
  } finally {
    await t.close();
    await mock.close();
  }
}

async function startupErrors() {
  const down = launch({ config: mockConfig('http://127.0.0.1:9/v1') });
  try {
    await check('provider caído: error fatal con sugerencia', down, async () => {
      await down.waitForBanner();
      await down.submit('hola');
      await down.waitFor(/✗ Error fatal/, 30000);
      assert.match(down.screen(), /LLM connection failed/);
      assert.match(down.screen(), /Verifica que el provider esté en ejecución/);
    });
  } finally {
    await down.close();
  }

  const none = launch();
  try {
    await check('sin provider configurado: mensaje y exit 1', none, async () => {
      assert.equal(await none.waitExit(), 1);
      assert.match(none.screen(), /No provider configured/);
    });
  } finally {
    await none.close();
  }
}

await conversation();
await cancelAndExit();
await startupErrors();
console.log(failed === 0 ? '\nTUI smoke: todo en orden' : `\nTUI smoke: ${failed} fallo(s)`);
process.exit(failed === 0 ? 0 : 1);

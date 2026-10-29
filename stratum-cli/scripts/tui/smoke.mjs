/**
 * Recorrido de humo por la TUI de `stratum chat` contra el mock: bienvenida,
 * paleta, turno, tool call, confirmación destructiva, cancelación, errores y
 * salida. Sirve de comprobación rápida y de ejemplo de uso del arnés.
 *
 *   npm run build && npm run tui:smoke            # solo ✓/✗
 *   npm run tui:smoke -- --show                   # además, cada pantalla
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';
import { startMockLlm, mockConfig, text, toolCall } from './mock-llm.mjs';

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
      await t.waitFor(/Escribe tu primer mensaje/);
    });

    await check('bienvenida: Enter ejecuta el comando seleccionado', t, async () => {
      await t.type('/cont');
      await t.waitFor(/▶ \/context/);
      await t.key('enter');
      await t.waitFor(/Uso del contexto:/);
      await t.waitFor(/Escribe un mensaje o \/ para comandos/);
    });

    await check('conversación: paleta, Tab completa y Ctrl+U limpia', t, async () => {
      await t.type('/mod');
      await t.waitFor(/▶ \/model/);
      await t.key('tab');
      await t.waitFor(/❯❯ \/model/);
      await t.key('ctrl+u');
      await t.waitFor(/Escribe un mensaje o \/ para comandos/);
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
      await t.waitFor(/Escribe un mensaje o \/ para comandos/, 5000);
      assert.equal(t.exited(), null);
      assert.doesNotMatch(t.screen(), /once doce/);
    });

    await check('steering: un mensaje a mitad de turno se encola y el turno sigue', t, async () => {
      const before = mock.requests.length;
      await t.submit('responde lento otra vez');
      await t.waitFor(/↵ redirigir/);
      // Trabajando: el símbolo de Stratum y una frase sobre el input, que va vacío.
      await t.waitFor(/[⠀-⣿]{2} [^\n]*…/);
      await t.waitFor(/dos tres/);
      await t.submit('no toques OAuth');
      await t.waitFor(/en cola para el agente/);
      await t.waitFor(/1 mensaje en cola/);
      // No se canceló nada: la respuesta en curso termina y el modelo recibe el
      // mensaje en una segunda llamada del mismo turno.
      await t.waitFor(/el agente recibió 1 mensaje/, 15000);
      await t.waitFor(/Escribe un mensaje o \/ para comandos/, 20000);
      assert.equal(mock.requests.length, before + 2);
      assert.doesNotMatch(t.screen(), /mensaje en cola/);
    });

    await check('turno en curso: paleta reducida y /context sin llamar al modelo', t, async () => {
      const before = mock.requests.length;
      await t.submit('responde lento otra vez');
      await t.waitFor(/↵ redirigir/);
      await t.type('/');
      await t.waitFor(/\/memory show/);
      // Solo los comandos de consulta: /init abriría otro turno.
      assert.doesNotMatch(t.screen(), /\/init/);
      await t.type('clear');
      await t.key('enter');
      await t.waitFor(/No disponible mientras el agente trabaja/);
      await t.key('ctrl+u');
      await t.submit('/context');
      await t.waitFor(/Uso del contexto/);
      // El desglose también con el turno en curso.
      await t.waitFor(/tools\s+~[\d.]+K?\s+\d+%/);
      await t.waitFor(/total entrada\s+~/);
      await t.waitFor(/Escribe un mensaje o \/ para comandos/, 20000);
      assert.equal(mock.requests.length, before + 1);
    });

    await check(
      'steering demasiado grande: avisa, no lo envía y lo deja en el input',
      t,
      async () => {
        const before = mock.requests.length;
        const tail = 'Y NO TOQUES OAUTH';
        const huge = `Cambia el plan. ${'detalle '.repeat(1300)}${tail}`;
        await t.submit('responde despacio');
        await t.waitFor(/dos tres/);
        // Por trozos: un pegado grande de golpe pierde caracteres en el pty.
        for (let i = 0; i < huge.length; i += 200) {
          t.paste(huge.slice(i, i + 200));
          await sleep(40);
        }
        await t.waitFor(/NO TOQUES OAUTH/);
        await t.key('enter');
        await t.waitFor(
          /Demasiado largo para enviarlo ahora \([\d.]+ caracteres, límite 8\.?000\): no se ha enviado/,
        );
        // Con el input más alto que la pantalla Ink repinta entero y una lectura
        // suelta puede pillarla en blanco: se espera, no se mira una sola vez.
        await t.waitGone(/mensaje en cola/);
        // El turno termina sin haberlo visto, ni entero ni recortado. El input tapa
        // el placeholder: el fin de turno se reconoce por su última palabra.
        const turns = () => (t.scrollback().match(/once doce/g) ?? []).length;
        const seen = turns();
        for (let i = 0; i < 150 && turns() === seen; i++) await sleep(200);
        await sleep(1500);
        assert.equal(mock.requests.length, before + 1);
        assert.doesNotMatch(JSON.stringify(mock.requests), /Cambia el plan/);
        await t.waitFor(/NO TOQUES OAUTH/);
        // Sigue en el input: Enter lo envía entero, como turno normal.
        await t.key('enter');
        for (let i = 0; i < 60 && mock.requests.length < before + 2; i++) await sleep(200);
        const sent = mock.requests
          .at(-1)
          .messages.filter((m) => m.role === 'user')
          .at(-1).content;
        assert.ok(
          sent.length > 8000 && sent.endsWith(tail) && !sent.includes('runtime_updates'),
          `turno normal: ${mock.requests.length - before} llamadas, ${sent.length} chars, …${sent.slice(-40)}`,
        );
        await t.waitFor(/Escribe un mensaje o \/ para comandos/, 20000);
      },
    );

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
      // Bajo el input van el pie del prompt y, en la última línea, la barra de estado.
      assert.match(t.tail(5), /Escribe un mensaje o \/ para comandos/);
      assert.match(t.tail(1), /● mock │ mock-model/);
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

async function backgroundExec() {
  // Un exec que tarda ~4 s; Ctrl+B lo pasa a un job y el turno sigue (UX-4).
  const command = `node -e "console.log('a'); setTimeout(() => console.log('b'), 4000)"`;
  let toolResult = '';
  const mock = await startMockLlm(({ last }) => {
    if (last.role !== 'tool') return toolCall('exec', { command });
    toolResult = String(last.content);
    return text('Sigue en segundo plano.');
  });
  const t = launch({ config: mockConfig(mock.baseUrl) });
  try {
    await check('Ctrl+B pasa el exec en curso a un job y el turno sigue', t, async () => {
      await t.waitForBanner();
      await t.submit('lanza el comando');
      await t.waitFor(/ctrl\+b a segundo plano/);
      await t.key('ctrl+b');
      await t.waitFor(/pasado a segundo plano como job #1/);
      await t.waitFor(/Sigue en segundo plano/);
      assert.match(toolResult, /handedOver="true"/);
      await t.waitFor(/job #1 terminado · exit 0/, 15000);
    });
  } finally {
    await t.close();
    await mock.close();
  }
}

/**
 * UX-1 «cambios por turno» y PL1: el pie del turno dice qué ficheros cambió
 * (hace falta un repo git para los snapshots) y un plugin de `--plugin` veta sin
 * preguntar.
 */
async function turnChangesAndPlugins() {
  const plugin = fileURLToPath(new URL('../../src/plugins/fixtures/guard-env.mjs', import.meta.url));
  const mock = await startMockLlm(({ said, last }) => {
    if (last.role === 'tool') return text('hecho');
    if (said.includes('escribe')) {
      return toolCall('write_file', { path: 'nota.txt', content: 'uno\ndos\ntres\n' });
    }
    return toolCall('exec', { command: 'terraform destroy' });
  });
  const t = launch({
    config: mockConfig(mock.baseUrl),
    args: ['chat', '--plugin', plugin],
    files: { 'README.md': '# demo\n' },
  });
  try {
    const git = (...a) =>
      execFileSync('git', ['-C', t.project, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
        stdio: 'ignore',
      });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await check('el pie del turno dice qué ficheros cambió', t, async () => {
      await t.waitForBanner();
      await t.submit('escribe una nota');
      await t.waitFor(/✓ hecho · [\d.]+ s · ✎ 1 fichero · \+3 −0/);
    });
    await check('/plugins y un veto de plugin sin confirmación', t, async () => {
      await t.submit('/plugins');
      await t.waitFor(/guard-env\s+\[--plugin\]\s+tool\.before, tool\.after/);
      await t.submit('destruye la infra');
      await t.waitFor(/Blocked by plugin guard-env/);
      await t.waitForIdle();
    });
  } finally {
    await t.close();
    await mock.close();
  }
}

async function modelFromBanner() {
  const mock = await startMockLlm();
  const t = launch({ config: mockConfig(mock.baseUrl) });
  try {
    // Los overlays solo se pintan en la vista de conversación: desde el banner,
    // `/model` abría el selector sin que se viera nada.
    await check('bienvenida: /model abre el selector de modelos', t, async () => {
      await t.waitForBanner();
      await t.submit('/model');
      await t.waitFor(/otro-modelo/, 10000);
      await t.key('down');
      await t.key('enter');
      await t.waitFor(/Modelo cambiado a otro-modelo/);
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
await modelFromBanner();
await cancelAndExit();
await backgroundExec();
await turnChangesAndPlugins();
await startupErrors();
console.log(failed === 0 ? '\nTUI smoke: todo en orden' : `\nTUI smoke: ${failed} fallo(s)`);
process.exit(failed === 0 ? 0 : 1);

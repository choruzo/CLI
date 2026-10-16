/**
 * M10 — una sesión de `stratum chat` pasa a `stratumd` con Dot mirando.
 *
 * `stratum chat` en un terminal de verdad (el arnés de la TUI de la CLI) aloja
 * su sesión y la publica; Dot —`dot-probe`, el mismo enlace nativo de la app—
 * la sigue. La terminal hace `/detach` y sale:
 *
 *   - Dot sigue viendo **la misma** sesión: mismo id, nunca desaparece de la
 *     lista, misma conversación; solo cambia `host.kind` (`peer` → `daemon`);
 *   - el campo de Dot pasa de «se escribe en la terminal» a preguntar, y un
 *     mensaje nuevo llega al agente con el contexto de antes.
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link && node scripts/smoke-detach.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../stratum-cli/scripts/tui/harness.mjs';
import { mockConfig, startMockLlm, text } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { checker, sleep, startProbe, until } from './probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'stratum-cli', 'dist', 'index.js');
const PROBE = join(here, '..', 'target', 'debug', process.platform === 'win32' ? 'dot-probe.exe' : 'dot-probe');
for (const [what, path] of [['la CLI compilada', CLI], ['dot-probe', PROBE]]) {
  if (!existsSync(path)) {
    console.error(`Falta ${what}: ${path}`);
    process.exit(2);
  }
}

const runner = checker();
const check = runner.check;

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((p) => p.text ?? '').join('');
  return '';
}

/** El modelo dice si tiene en su contexto lo que se le contó en la terminal. */
const mock = await startMockLlm(({ said, messages }) => {
  if (said.includes('qué te dije')) {
    const knows = messages.some((m) => m.role === 'user' && contentOf(m).includes('kiwi'));
    return text(knows ? 'Me dijiste: kiwi.' : 'No me has dicho nada.');
  }
  return text('Anotado.');
});
const t = launch({ config: mockConfig(mock.baseUrl, { daemon: { autoStart: true } }) });
const env = {
  ...process.env,
  HOME: t.home,
  USERPROFILE: t.home,
  APPDATA: join(t.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(t.home, 'AppData', 'Local'),
  STRATUM_DOT_CLI: CLI,
  STRATUM_DOT_NO_AUTOSTART: '1',
};
delete env.STRATUM_NO_DAEMON;

let probe;
try {
  let sessionId;
  let before;
  await check('Dot ve la sesión de la terminal, alojada en ella', async () => {
    await t.waitForBanner();
    await t.submit('Mi código secreto de prueba es kiwi');
    await t.waitFor(/Anotado\./);
    await t.waitForIdle();
    probe = startProbe({ binary: PROBE, env, logDir: join(t.home, 'dot-logs') });
    await until('Dot conectado', () => probe.connection?.kind === 'connected', 30_000);
    sessionId = await until('la sesión par', () => probe.sessionIds[0]);
    before = await probe.photo(sessionId);
    assert.deepEqual(before.session.host, { kind: 'peer', client: 'cli', connected: true });
    assert.deepEqual(
      before.messages.filter((m) => m.kind === 'user').map((m) => m.text),
      ['Mi código secreto de prueba es kiwi'],
    );
    // A una sesión de terminal parada no se le escribe desde Dot.
    const refused = await probe.order('send', { sessionId, input: 'hola' });
    assert.deepEqual([refused.ok, refused.error.reason], [false, 'peer-hosted']);
  });

  await check('/detach en la terminal: para Dot es la misma sesión, que cambia de anfitrión', async () => {
    // Mientras dura, la lista de Dot no pierde la sesión ni un instante.
    let lost = false;
    const watching = setInterval(() => {
      if (!probe.sessionIds.includes(sessionId)) lost = true;
    }, 20);
    try {
      await t.submit('/detach');
      await t.waitFor(/now hosted by stratumd/);
      await until('la terminal sale', () => t.exited());
      await until('Dot ve el anfitrión nuevo', () => probe.sessions.get(sessionId)?.session.host.kind === 'daemon');
      await sleep(300);
    } finally {
      clearInterval(watching);
    }
    assert.equal(lost, false, 'la sesión desapareció de la lista de Dot');
    assert.deepEqual(probe.sessionIds, [sessionId]);
    const events = probe.seen.flatMap((m) => (m.type === 'events' && m.sessionId === sessionId ? m.events : []));
    assert.ok(!events.some((e) => e.type === 'session.closed' || e.type === 'session.opened'));
    const after = await probe.photo(sessionId);
    assert.equal(after.session.id, sessionId);
    assert.deepEqual(after.session.host, { kind: 'daemon', client: 'daemon', connected: true });
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.seq, before.seq + 1);
  });

  await check('Dot le escribe ya en el daemon: el agente conserva el contexto de la terminal', async () => {
    const sent = await probe.order('send', { sessionId, input: '¿Qué te dije antes?' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await until('el run termina', () => probe.sessions.get(sessionId)?.run?.status === 'completed' && probe.sessions.get(sessionId).run.id === sent.result.run.id);
    const snapshot = await probe.photo(sessionId);
    assert.deepEqual(
      snapshot.messages.filter((m) => m.kind === 'assistant').map((m) => m.text),
      ['Anotado.', 'Me dijiste: kiwi.'],
    );
  });

  await check('cerrar Dot no toca la sesión: sigue viva en el daemon', async () => {
    await probe.close();
    probe = null;
    const r = spawnSync(process.execPath, [CLI, 'ps', '--json'], { env, encoding: 'utf-8' });
    const listed = JSON.parse(r.stdout);
    assert.deepEqual(
      listed.sessions.map((s) => [s.id, s.host.kind]),
      [[sessionId, 'daemon']],
    );
  });
} finally {
  await probe?.close().catch(() => undefined);
  spawnSync(process.execPath, [CLI, 'daemon', 'stop', '--force'], { env, encoding: 'utf-8' });
  await sleep(400);
  await t.close();
  await mock.close();
}

console.log(runner.failed === 0 ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 ? 0 : 1);

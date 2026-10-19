/**
 * M12 — CLI, Desktop y Dot como clientes hermanos de un `stratumd` real
 * (`docs/STRATUM_CLIENT_ARCHITECTURE.md`). Desktop es aquí `dot-probe --client
 * desktop`: el **mismo** enlace nativo que usa la app (`dot-link` con el perfil
 * de Desktop), con la interfaz cambiada por líneas JSON. Dot es `dot-probe` con
 * su perfil, y la CLI es la CLI de verdad (`stratum chat`, `attach`, `ps`) en
 * un terminal del arnés de la TUI.
 *
 *   Desktop abre una sesión → Dot la ve → `stratum attach` ve lo mismo
 *   `stratum chat` (par) → Desktop la ve y no la conduce → /detach → Desktop la continúa
 *   cerrar Desktop → la sesión sigue → reiniciar el daemon → vuelve → Desktop la continúa
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link
 *   (aquí)            node scripts/smoke-clients.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../stratum-cli/scripts/tui/harness.mjs';
import { mockConfig, startMockLlm, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { checker, sleep, startProbe, until } from '../../stratum-dot/scripts/probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'stratum-cli', 'dist', 'index.js');
const PROBE = join(
  here,
  '..',
  '..',
  'stratum-dot',
  'target',
  'debug',
  process.platform === 'win32' ? 'dot-probe.exe' : 'dot-probe',
);
for (const [what, path] of [
  ['la CLI compilada', CLI],
  ['dot-probe', PROBE],
]) {
  if (!existsSync(path)) {
    console.error(`Falta ${what}: ${path}`);
    process.exit(2);
  }
}

const runner = checker();
const check = (name, fn) =>
  runner.failed === 0 ? runner.check(name, fn) : (console.log(`- ${name} (omitida)`), Promise.resolve());

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((p) => p.text ?? '').join('');
  return '';
}
const knows = (messages, word) => messages.some((m) => m.role === 'user' && contentOf(m).includes(word));

/** El modelo dice lo que tiene en su contexto: así se ve que la sesión es la misma. */
const mock = await startMockLlm(({ said, messages, last }) => {
  if (last.role === 'tool') return text('Nota guardada en outputs/nota.md.');
  if (said.includes('guarda una nota')) {
    return [...text('Voy.'), ...toolCall('write_file', { path: 'outputs/nota.md', content: 'kiwi' })];
  }
  if (said.includes('qué te dije')) {
    if (knows(messages, 'kiwi')) return text('Me dijiste: kiwi.');
    if (knows(messages, 'mango')) return text('Me dijiste: mango.');
    return text('No me has dicho nada.');
  }
  return text('Anotado.');
});

// Un HOME aislado para todo: la CLI (que arranca el daemon), Desktop y Dot lo comparten.
const t = launch({ config: mockConfig(mock.baseUrl, { daemon: { autoStart: true } }) });
const env = {
  ...process.env,
  HOME: t.home,
  USERPROFILE: t.home,
  APPDATA: join(t.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(t.home, 'AppData', 'Local'),
  STRATUM_DOT_CLI: CLI,
  STRATUM_DESKTOP_CLI: CLI,
};
delete env.STRATUM_NO_DAEMON;
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
const ps = () => JSON.parse(cli(['ps', '--json']).stdout).sessions;

/** Lo que hace Desktop al pedir una conversación nueva: su carpeta, y una sesión del asistente en ella. */
function desktopFolder() {
  const dir = join(t.home, '.stratum', 'desktop', 'workspaces', randomUUID());
  for (const sub of ['inputs', 'outputs', 'scratch']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

const userTexts = (snapshot) => snapshot.messages.filter((m) => m.kind === 'user').map((m) => m.text);
const replies = (snapshot) => snapshot.messages.filter((m) => m.kind === 'assistant').map((m) => m.text);

async function ask(probe, sessionId, input) {
  const sent = await probe.order('send', { sessionId, input });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const runId = sent.result.run.id;
  await until(
    `el run ${runId} termina`,
    () => {
      const known = probe.sessions.get(sessionId);
      return known?.run?.id === runId && known.run.status === 'completed';
    },
    40_000,
  );
  return runId;
}

let desktop;
let dot;
let attach;
try {
  let desktopSession;
  let folder;
  await check('la terminal publica su sesión; Desktop arranca y conecta con el comando oficial', async () => {
    await t.waitForBanner();
    await t.submit('Mi fruta es mango');
    await t.waitFor(/Anotado\./);
    await t.waitForIdle();
    desktop = startProbe({ binary: PROBE, env, logDir: join(t.home, 'desktop-logs'), client: 'desktop' });
    await until('Desktop conectado', () => desktop.connection?.kind === 'connected', 40_000);
    const log = readFileSync(join(t.home, 'desktop-logs', 'dot.log'), 'utf-8');
    assert.ok(!/token|approver/i.test(log.replace(/tokens?/gi, '')), 'el log no lleva credenciales');
  });

  await check('Desktop abre una conversación: una sesión normal del daemon, con su origen', async () => {
    folder = desktopFolder();
    const opened = await desktop.order('open', { cwd: folder, agent: 'assistant' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    desktopSession = opened.result.session.id;
    assert.equal(opened.result.session.origin, 'desktop');
    assert.equal(opened.result.session.agent, 'assistant');
    assert.equal(opened.result.session.host.kind, 'daemon');
    // Solo se sigue la sesión que se mira: la lista sale de la foto de conjunto.
    await until('en la lista de Desktop', () => desktop.sessionIds.includes(desktopSession));
    desktop.send({ cmd: 'focus', sessionId: desktopSession });
    await until('su foto', () => desktop.sessions.get(desktopSession));
    await ask(desktop, desktopSession, 'Recuerda kiwi y guarda una nota');
    assert.equal(readFileSync(join(folder, 'outputs', 'nota.md'), 'utf-8'), 'kiwi');
  });

  await check('Dot la ve igual (mismo id, misma conversación) sin haberla abierto', async () => {
    dot = startProbe({ binary: PROBE, env, logDir: join(t.home, 'dot-logs'), autostart: false });
    await until('Dot conectado', () => dot.connection?.kind === 'connected', 30_000);
    await until('Dot la sigue', () => dot.sessionIds.includes(desktopSession));
    const seenByDot = await dot.photo(desktopSession);
    const seenByDesktop = await desktop.photo(desktopSession);
    assert.equal(seenByDot.session.origin, 'desktop');
    assert.deepEqual(seenByDot.messages, seenByDesktop.messages);
    assert.deepEqual(userTexts(seenByDot), ['Recuerda kiwi y guarda una nota']);
    // Y sigue sin poder cerrarla: no está en el perfil de Dot (no sale nada).
    const refused = await dot.order('close', { sessionId: desktopSession });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.kind, 'invalid');
  });

  await check('`stratum ps` y `stratum attach <id>` ven la misma sesión y su conversación', async () => {
    const listed = ps().find((s) => s.id === desktopSession);
    assert.ok(listed, 'stratum ps la lista');
    assert.equal(listed.origin, 'desktop');
    attach = launch({ beside: t, args: ['attach', desktopSession] });
    await attach.waitFor(/Recuerda kiwi y guarda una nota/, 30_000);
    await attach.waitFor(/Nota guardada en outputs\/nota\.md/, 30_000);
    await attach.submit('/quit');
    await until('attach sale', () => attach.exited(), 15_000);
  });

  let peerSession;
  await check('la sesión de la terminal: Desktop la ve, pero no la conduce mientras la aloja la terminal', async () => {
    peerSession = await until('la sesión par', () =>
      desktop.sessionIds.find((id) => id !== desktopSession),
    );
    desktop.send({ cmd: 'focus', sessionId: peerSession });
    const photo = await desktop.photo(peerSession);
    assert.deepEqual(photo.session.host, { kind: 'peer', client: 'cli', connected: true });
    assert.equal(photo.session.origin, 'cli');
    const refused = await desktop.order('send', { sessionId: peerSession, input: 'hola' });
    assert.deepEqual([refused.ok, refused.error.reason], [false, 'peer-hosted']);
  });

  await check('/detach en la terminal: Desktop continúa la misma sesión con su contexto', async () => {
    await t.submit('/detach');
    await t.waitFor(/now hosted by stratumd/);
    await until('la terminal sale', () => t.exited());
    await until('Desktop ve el anfitrión nuevo', () => desktop.sessions.get(peerSession)?.session.host.kind === 'daemon');
    await ask(desktop, peerSession, '¿Qué te dije?');
    const after = await desktop.photo(peerSession);
    assert.equal(after.session.id, peerSession);
    assert.equal(after.session.origin, 'cli');
    assert.deepEqual(replies(after), ['Anotado.', 'Me dijiste: mango.']);
  });

  await check('cerrar Desktop no cierra nada: las dos sesiones siguen en el daemon', async () => {
    await desktop.close();
    desktop = null;
    const ids = ps().map((s) => s.id).sort();
    assert.deepEqual(ids, [desktopSession, peerSession].sort());
  });

  await check('reinicio del daemon: vuelven las sesiones guardadas y Desktop continúa la suya', async () => {
    assert.equal(cli(['daemon', 'stop']).status, 0);
    await until('el daemon se fue', () => cli(['daemon', 'status']).status !== 0, 20_000);
    assert.equal(cli(['daemon', 'start']).status, 0);
    desktop = startProbe({ binary: PROBE, env, logDir: join(t.home, 'desktop-logs-2'), client: 'desktop', autostart: false });
    await until('Desktop conectado', () => desktop.connection?.kind === 'connected', 30_000);
    await until('las dos vuelven', () => desktop.sessionIds.includes(desktopSession) && desktop.sessionIds.includes(peerSession), 20_000);
    const restored = (desktop.overview?.sessions ?? []).find((s) => s.id === desktopSession);
    assert.equal(restored?.origin, 'desktop');
    assert.equal(restored?.agent, 'assistant');
    // El historial completo, del daemon (M11), no de un almacén de Desktop.
    const page = await desktop.order('history', { sessionId: desktopSession, limit: 50 });
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.ok(page.result.messages.some((m) => m.kind === 'user' && m.text === 'Recuerda kiwi y guarda una nota'));
    desktop.send({ cmd: 'focus', sessionId: desktopSession });
    await until('su foto', () => desktop.sessions.get(desktopSession));
    await ask(desktop, desktopSession, '¿Qué te dije?');
    const after = await desktop.photo(desktopSession);
    assert.equal(replies(after).at(-1), 'Me dijiste: kiwi.');
  });

  await check('cerrar la sesión desde Desktop: desaparece para todos (también guardada)', async () => {
    const closed = await desktop.order('close', { sessionId: desktopSession });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    await until('fuera de la lista', () => !desktop.sessionIds.includes(desktopSession));
    assert.ok(!ps().some((s) => s.id === desktopSession));
    // Sus ficheros se quedan donde estaban.
    assert.equal(readFileSync(join(folder, 'outputs', 'nota.md'), 'utf-8'), 'kiwi');
  });
} finally {
  await desktop?.close().catch(() => undefined);
  await dot?.close().catch(() => undefined);
  await attach?.close?.().catch?.(() => undefined);
  cli(['daemon', 'stop', '--force']);
  await sleep(400);
  await t.close();
  await mock.close();
}

console.log(runner.failed === 0 ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 ? 0 : 1);

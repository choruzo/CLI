/**
 * M8 — la terminal y Dot compiten por la misma aprobación (first-valid-wins).
 *
 * `stratum run` en un terminal de verdad (el arnés de la TUI de la CLI, con un
 * pty) abre su prompt local; Dot —`dot-probe`, el mismo enlace nativo de la
 * app, con su broker de aprobador— ve la solicitud de esa sesión par y la
 * resuelve, o llega tarde:
 *
 *   - Dot gana → el prompt de la terminal se retira y la tool se ejecuta una vez;
 *   - la terminal gana → a Dot le llega `ALREADY_RESOLVED` y converge.
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link && node scripts/smoke-terminal.mjs
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../stratum-cli/scripts/tui/harness.mjs';
import { mockConfig, startMockLlm } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
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
const KEY = `clave-de-la-terminal-${randomBytes(6).toString('hex')}`;

function approverFile(key) {
  const params = { N: 1 << 15, r: 8, p: 1 };
  const salt = randomBytes(16);
  const hash = scryptSync(key.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * params.N * 8 });
  return JSON.stringify({ version: 1, algorithm: 'scrypt', ...params, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() });
}

const mock = await startMockLlm();
const config = mockConfig(mock.baseUrl, { daemon: { autoStart: true } });
const homeFiles = { '.stratum/daemon/approver.json': approverFile(KEY) };

/** Una terminal con `stratum run` y Dot mirando el mismo daemon. */
async function terminalAndDot() {
  const t = launch({ config, args: ['run', 'borra el fichero'], files: { 'victima.txt': 'x\n' }, homeFiles });
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
  await t.waitFor(/¿Continuar\? \(s\/N\/!\)/, 30_000);
  const probe = startProbe({ binary: PROBE, env, logDir: join(t.home, 'dot-logs') });
  await until('Dot conectado', () => probe.connection?.kind === 'connected', 30_000);
  await until('broker bloqueado', () => probe.approver?.kind === 'locked');
  assert.equal((await probe.order('unlock', { key: KEY })).ok, true);
  const sessionId = await until('la sesión par', () => probe.sessionIds[0]);
  await until('su foto', () => probe.sessions.has(sessionId));
  const approval = await until('la solicitud', () => {
    const snap = probe.sessions.get(sessionId)?.snapshot;
    const fromSnap = snap?.approvals?.[0];
    const fromEvents = probe.seen
      .flatMap((m) => (m.type === 'events' && m.sessionId === sessionId ? m.events : []))
      .find((e) => e.type === 'approval.requested')?.data.approval;
    return fromSnap ?? fromEvents;
  });
  const stop = async () => {
    await probe.close().catch(() => undefined);
    spawnSync(process.execPath, [CLI, 'daemon', 'stop', '--force'], { env, encoding: 'utf-8' });
    await sleep(400);
    await t.close();
  };
  return { t, probe, sessionId, approval, victim: join(t.project, 'victima.txt'), stop };
}

{
  const s = await terminalAndDot().catch((err) => {
    console.log(`✗ preparar la terminal\n  ${err.message}`);
    process.exitCode = 1;
    return null;
  });
  if (s) {
    try {
      await check('Dot gana: el prompt de la terminal se retira y la tool corre una vez', async () => {
        assert.equal(s.approval.expiresAt, null, 'con terminal no caduca');
        assert.equal(s.probe.sessions.get(s.sessionId).session.host.kind, 'peer');
        const done = await s.probe.resolve('approve', { sessionId: s.sessionId, approvalId: s.approval.id });
        assert.equal(done.ok, true, JSON.stringify(done));
        // La confirmación nativa enseñó lo que dijo el daemon: una sesión de terminal.
        assert.equal(done.confirmation.view.session.host, 'peer');
        await s.t.waitFor(/\[resolved from another client\]/);
        assert.equal(await s.t.waitExit(20_000), 0);
        assert.ok(!existsSync(s.victim));
        // Una respuesta posterior, de otra vía, llega tarde.
        const late = await s.probe.order('deny', { sessionId: s.sessionId, approvalId: s.approval.id });
        assert.deepEqual([late.ok, late.error.code], [false, 'ALREADY_RESOLVED']);
      });
    } finally {
      await s.stop();
    }
  }
}

{
  const s = await terminalAndDot().catch((err) => {
    console.log(`✗ preparar la terminal\n  ${err.message}`);
    process.exitCode = 1;
    return null;
  });
  if (s) {
    try {
      await check('la terminal gana: lo pendiente desaparece y Dot ya no puede resolverlo', async () => {
        await s.t.submit('s');
        await until('resuelta en la terminal', () =>
          s.probe.seen.some(
            (m) =>
              m.type === 'events' &&
              m.sessionId === s.sessionId &&
              m.events.some((e) => e.type === 'approval.resolved' && e.data.resolvedBy?.kind === 'local'),
          ),
        );
        // Ya no está pendiente: ni se llega a enseñar la confirmación.
        const late = await s.probe.resolve('approve', { sessionId: s.sessionId, approvalId: s.approval.id });
        assert.deepEqual([late.ok, late.error.code, late.confirmation], [false, 'NOT_FOUND', null]);
        assert.equal(await s.t.waitExit(20_000), 0);
        assert.ok(!existsSync(s.victim), 'la tool se ejecutó una vez, por la terminal');
      });
    } finally {
      await s.stop();
    }
  }
}

{
  const s = await terminalAndDot().catch((err) => {
    console.log(`✗ preparar la terminal
  ${err.message}`);
    process.exitCode = 1;
    return null;
  });
  if (s) {
    try {
      await check('la terminal gana con la confirmación de Dot abierta: se cancela y no se vuelve a resolver', async () => {
        const before = s.probe.confirmations.length;
        const asked = s.probe.order('approve', { sessionId: s.sessionId, approvalId: s.approval.id });
        await until('Dot enseña la confirmación', () => s.probe.confirmations.length > before);
        const { nonce } = s.probe.confirmations[before];
        await s.t.submit('s');
        const result = await asked;
        assert.deepEqual([result.ok, result.error.kind, result.error.reason], [false, 'not-confirmed', 'resolved-elsewhere']);
        // La persona pulsa tarde: la ventana ya no vale.
        const late = await s.probe.order('confirm', { nonce });
        assert.equal(late.ok, false);
        assert.equal(await s.t.waitExit(20_000), 0);
        assert.ok(!existsSync(s.victim), 'la tool se ejecutó una vez, por la terminal');
      });
    } finally {
      await s.stop();
    }
  }
}

await mock.close();
console.log(runner.failed === 0 && !process.exitCode ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 && !process.exitCode ? 0 : 1);

/**
 * `stratum chat` como anfitrión par, en un terminal de verdad: la sesión del
 * chat se publica en `stratumd` (aquí lo arranca ella, con `daemon.autoStart`),
 * y otro cliente del Stratum Protocol la ve, la redirige y cancela su turno.
 *
 *   npm run build && node scripts/tui/daemon-peer.mjs [--show]
 *
 * El cliente de este script habla el protocolo a mano (un socket y líneas
 * JSON): `dist/` es un bundle y no exporta `StratumClient`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';
import { startMockLlm, mockConfig } from './mock-llm.mjs';

const SHOW = process.argv.includes('--show');
let failed = 0;

async function check(name, t, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    if (SHOW) t.shot(name, { last: 14 });
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${String(err.message).split('\n').join('\n  ')}`);
    t.shot(`pantalla en el fallo: ${name}`);
  }
}

async function until(probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('condición no cumplida a tiempo');
    await sleep(150);
  }
}

/** Cliente mínimo del protocolo: handshake y peticiones correlacionadas por id. */
async function connect(home, roles) {
  const endpoint = JSON.parse(
    readFileSync(join(home, '.stratum', 'daemon', 'endpoint.json'), 'utf-8'),
  );
  const socket = createConnection(endpoint.ipcPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error)
        waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  socket.on('error', () => undefined);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  await request('core.hello', {
    protocol: endpoint.protocol,
    token: endpoint.token,
    client: { kind: 'other', name: 'tui-test', version: '0' },
    roles,
  });
  return { request, close: () => socket.destroy() };
}

const mock = await startMockLlm();
const t = launch({ config: mockConfig(mock.baseUrl, { daemon: { autoStart: true } }) });
let operator;
try {
  await check('el chat arranca el daemon y se publica en él', t, async () => {
    await t.waitForBanner();
    operator = await until(() => connect(t.home, ['operator']).catch(() => null));
    const { sessions } = await operator.request('sessions.list');
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].host, { kind: 'peer', client: 'cli', connected: true });
    assert.equal(sessions[0].state, 'idle');
    assert.equal(sessions[0].model, 'mock-model');
  });

  let sessionId;
  let runId;
  await check(
    'un turno del chat se ve desde fuera, con lo que escribió el usuario',
    t,
    async () => {
      await t.submit('responde despacio');
      const run = await until(
        async () => (await operator.request('runs.list', { active: true })).runs[0],
      );
      sessionId = run.sessionId;
      runId = run.id;
      assert.equal(run.input, 'responde despacio');
      const { snapshot } = await operator.request('sessions.get', { sessionId });
      assert.equal(snapshot.session.state, 'running');
      assert.equal(snapshot.session.title, 'responde despacio');
    },
  );

  await check('steering desde otro cliente: lo recibe la sesión del chat', t, async () => {
    const result = await operator.request('runs.steer', { sessionId, text: 'acaba ya' });
    assert.deepEqual(result, { status: 'accepted' });
    await t.waitFor(/mensaje en cola/);
  });

  await check('cancel desde otro cliente: el turno se corta y el input sigue vivo', t, async () => {
    assert.deepEqual(await operator.request('runs.cancel', { sessionId, runId }), {
      status: 'cancelled',
    });
    await until(
      async () => (await operator.request('runs.get', { runId })).run.status === 'cancelled',
    );
    await t.waitForIdle();
    await t.waitFor(/Escribe un mensaje o \/ para comandos/);
    assert.equal(t.exited(), null);
    const { snapshot } = await operator.request('sessions.get', { sessionId });
    assert.equal(snapshot.session.state, 'idle');
    // Lo que no llegó a entregarse sigue en la inbox del chat: va con el próximo mensaje.
    await t.waitFor(/delivered with your next message/);
  });

  await check('al salir del chat la sesión desaparece del daemon', t, async () => {
    await t.submit('/quit');
    await until(() => t.exited());
    await until(async () => (await operator.request('sessions.list')).sessions.length === 0);
    assert.equal((await operator.request('core.status')).activeRuns, 0);
  });
} finally {
  await operator?.request('core.shutdown', { force: true }).catch(() => undefined);
  operator?.close();
  await sleep(500);
  await t.close();
  await mock.close();
}

console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

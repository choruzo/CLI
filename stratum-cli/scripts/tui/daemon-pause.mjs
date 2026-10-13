/**
 * Pausa cooperativa de una sesión de `stratum chat`, en un terminal de verdad
 * (M5): otro cliente del Stratum Protocol pausa el turno del chat, lo redirige
 * con el run en pausa, lo reanuda y lo cancela. La pausa la decide el runtime
 * del chat; el daemon solo reenvía la orden.
 *
 *   npm run build && node scripts/tui/daemon-pause.mjs [--show]
 *
 * El cliente de este script habla el protocolo a mano (un socket y líneas
 * JSON): `dist/` es un bundle y no exporta `StratumClient`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';
import { startMockLlm, mockConfig, text, toolCall, SLOW_WORDS } from './mock-llm.mjs';

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

// El modelo habla despacio y acaba proponiendo una tool: la pausa llega mientras
// habla. Su segunda respuesta, tras reanudar, también es lenta: da tiempo a cancelar.
const mock = await startMockLlm(({ n }) =>
  n === 1
    ? [
        ...text('Voy a listar el directorio. uno dos tres cuatro cinco seis', 500),
        ...toolCall('list_directory', { path: '.' }),
      ]
    : text(`De acuerdo. ${SLOW_WORDS}`, 900),
);
const t = launch({ config: mockConfig(mock.baseUrl, { daemon: { autoStart: true } }) });
let operator;
try {
  let sessionId;
  let runId;
  const status = async () => (await operator.request('runs.get', { runId })).run.status;

  await check('el chat se publica y su turno se ve desde fuera', t, async () => {
    await t.waitForBanner();
    operator = await until(() => connect(t.home, ['operator']).catch(() => null));
    await t.submit('lista el directorio');
    const run = await until(
      async () => (await operator.request('runs.list', { active: true })).runs[0],
    );
    sessionId = run.sessionId;
    runId = run.id;
  });

  await check(
    'pausa desde otro cliente: la respuesta termina, la tool no empieza y el chat lo dice',
    t,
    async () => {
      assert.deepEqual(await operator.request('runs.pause', { sessionId }), {
        status: 'requested',
      });
      // Pedida, no alcanzada: el modelo sigue hablando.
      assert.equal(await status(), 'running');
      await until(async () => (await status()) === 'paused');
      await t.waitFor(/en pausa desde otro cliente/);
      // El texto no se cortó.
      await t.waitFor(/cinco seis/);
      const { snapshot } = await operator.request('sessions.get', { sessionId });
      assert.equal(snapshot.session.state, 'paused');
      await sleep(1500);
      assert.equal(mock.requests.length, 1);
      assert.equal(await status(), 'paused');
      assert.equal(t.exited(), null);
    },
  );

  await check('steering con el run en pausa: aceptado, y sigue en pausa', t, async () => {
    const result = await operator.request('runs.steer', {
      sessionId,
      text: 'mejor no listes nada',
    });
    assert.deepEqual(result, { status: 'accepted' });
    await t.waitFor(/steering update/);
    await sleep(1000);
    assert.equal(await status(), 'paused');
    assert.equal(mock.requests.length, 1);
  });

  await check('reanudar: el mismo turno sigue y el modelo recibe el mensaje', t, async () => {
    assert.deepEqual(await operator.request('runs.resume', { sessionId, runId }), {
      status: 'resumed',
    });
    await t.waitFor(/reanudado/);
    await until(() => mock.requests.length === 2);
    assert.match(JSON.stringify(mock.requests[1].messages), /mejor no listes nada/);
    assert.equal(await status(), 'running');
    assert.deepEqual(await operator.request('runs.resume', { sessionId }), {
      status: 'not-paused',
    });
  });

  await check('cancelar sigue funcionando, y el input queda vivo', t, async () => {
    assert.deepEqual(await operator.request('runs.cancel', { sessionId, runId }), {
      status: 'cancelled',
    });
    await until(async () => (await status()) === 'cancelled');
    await t.waitForIdle();
    await t.waitFor(/Type a message or \/ for commands/);
    assert.equal(t.exited(), null);
    assert.deepEqual(await operator.request('runs.pause', { sessionId }), {
      status: 'not-running',
    });
  });

  await check('al salir del chat la sesión desaparece del daemon', t, async () => {
    await t.submit('/quit');
    await until(() => t.exited());
    await until(async () => (await operator.request('sessions.list')).sessions.length === 0);
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

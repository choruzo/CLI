/**
 * M10 — traspaso de una sesión de `stratum chat` a `stratumd`, con procesos y
 * terminales de verdad:
 *
 *   1. `chat` (anfitrión par) conversa y deja algo en el contexto del agente;
 *   2. `/detach`: la sesión pasa al daemon con el mismo id y el chat sale;
 *   3. `stratum attach <id>` en otra terminal ve la misma conversación y
 *      continúa: el modelo recibe el contexto de antes;
 *   4. salir de `attach` no toca la sesión;
 *   5. `stratum detach <id>` desde otro proceso: con un turno en curso se
 *      rechaza y el chat sigue; parado, el chat la suelta y sale.
 *
 *   npm run build && node scripts/tui/daemon-detach.mjs [--show]
 *
 * El cliente de este script habla el protocolo a mano (un socket y líneas
 * JSON): `dist/` es un bundle y no exporta `StratumClient`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';
import { SLOW_WORDS, mockConfig, startMockLlm, text } from './mock-llm.mjs';

const SHOW = process.argv.includes('--show');
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
let failed = 0;

async function check(name, t, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    if (SHOW) t.shot(name, { last: 16 });
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

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((p) => p.text ?? '').join('');
  return '';
}

/** El modelo dice si tiene en su contexto lo que se le contó antes. */
function script({ said, messages }) {
  if (said.includes('qué te dije')) {
    const knows = messages.some((m) => m.role === 'user' && contentOf(m).includes('kiwi'));
    return text(knows ? 'Me dijiste: kiwi.' : 'No me has dicho nada.');
  }
  if (said.includes('despacio')) return text(SLOW_WORDS, 600);
  return text('Anotado.');
}

/** `stratum <args>` como otro proceso de la misma persona (mismo HOME). */
function stratum(t, args) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: t.project,
    env: { ...process.env, HOME: t.home, USERPROFILE: t.home },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const mock = await startMockLlm(script);
const config = mockConfig(mock.baseUrl, { daemon: { autoStart: true } });
const chat = launch({ config });
const others = [];
let operator;
try {
  let sessionId;
  await check('el chat se publica en el daemon y conversa', chat, async () => {
    await chat.waitForBanner();
    operator = await until(() => connect(chat.home, ['operator']).catch(() => null));
    await chat.submit('Mi código secreto de prueba es kiwi');
    await chat.waitFor(/Anotado\./);
    await chat.waitForIdle();
    const { sessions } = await operator.request('sessions.list');
    assert.equal(sessions.length, 1);
    sessionId = sessions[0].id;
    assert.equal(sessions[0].host.kind, 'peer');
  });

  await check(
    '/detach: la sesión pasa al daemon con el mismo id y el chat sale',
    chat,
    async () => {
      await chat.submit('/detach');
      await chat.waitFor(/now hosted by stratumd/);
      await until(() => chat.exited());
      assert.equal(chat.exited().exitCode, 0);
      const { sessions } = await operator.request('sessions.list');
      assert.deepEqual(
        sessions.map((s) => [s.id, s.host.kind, s.state]),
        [[sessionId, 'daemon', 'idle']],
      );
      // Lo que dice al salir: cómo seguir.
      assert.match(chat.scrollback(), new RegExp(`stratum attach ${sessionId}`));
    },
  );

  const attach = launch({ beside: chat, args: ['attach', sessionId] });
  others.push(attach);
  await check(
    'stratum attach: la misma conversación, y un turno nuevo con el contexto de antes',
    attach,
    async () => {
      await attach.waitFor(new RegExp(`Attached to ${sessionId}`));
      await attach.waitFor(/hosted by stratumd/);
      await attach.waitFor(/› Mi código secreto de prueba es kiwi/);
      await attach.waitFor(/Anotado\./);
      await attach.submit('¿Qué te dije antes?');
      await attach.waitFor(/Me dijiste: kiwi\./);
      const { snapshot } = await operator.request('sessions.get', { sessionId });
      assert.equal(snapshot.session.host.kind, 'daemon');
      assert.deepEqual(
        snapshot.messages.filter((m) => m.kind === 'user').map((m) => m.text),
        ['Mi código secreto de prueba es kiwi', '¿Qué te dije antes?'],
      );
    },
  );

  await check('salir de attach no toca la sesión', attach, async () => {
    await attach.submit('/quit');
    await until(() => attach.exited());
    await sleep(300);
    const { sessions } = await operator.request('sessions.list');
    assert.deepEqual(
      sessions.map((s) => s.id),
      [sessionId],
    );
  });

  // Otra sesión de chat, para traspasarla desde fuera.
  const chat2 = launch({ beside: chat, args: ['chat'] });
  others.push(chat2);
  let second;
  await check(
    'stratum detach con un turno en curso: se rechaza y el chat sigue',
    chat2,
    async () => {
      await chat2.waitForBanner();
      second = await until(async () =>
        (await operator.request('sessions.list')).sessions.find((s) => s.host.kind === 'peer'),
      );
      await chat2.submit('responde despacio');
      await until(
        async () => (await operator.request('runs.list', { active: true })).runs.length > 0,
      );
      const r = stratum(chat2, ['detach', second.id]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /the agent is working/);
      assert.equal(chat2.exited(), null);
    },
  );

  await check('stratum detach con la sesión parada: el chat la suelta y sale', chat2, async () => {
    await chat2.waitForIdle();
    const r = stratum(chat2, ['detach', second.id]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /now hosted by stratumd/);
    await chat2.waitFor(/now hosted by stratumd/);
    await until(() => chat2.exited());
    const { sessions } = await operator.request('sessions.list');
    assert.equal(sessions.find((s) => s.id === second.id)?.host.kind, 'daemon');
    // Repetirlo no cambia nada.
    const again = stratum(chat2, ['detach', second.id]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already hosted/);
  });
} finally {
  await operator?.request('core.shutdown', { force: true }).catch(() => undefined);
  operator?.close();
  await sleep(500);
  for (const o of others) await o.close();
  await chat.close();
  await mock.close();
}

console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

/**
 * M4 en terminales de verdad: una operación destructiva abre el prompt local de
 * `stratum chat` / `stratum run`, y otro cliente del Stratum Protocol —un
 * aprobador acreditado con su clave— compite con él por resolverla.
 *
 *   npm run build && node scripts/tui/daemon-approvals.mjs [--show]
 *
 * Comprueba, viéndolo en pantalla:
 *  - el remoto gana → el prompt de la terminal desaparece y la tool se ejecuta una vez;
 *  - el local gana → el remoto ve la resolución y su respuesta llega tarde;
 *  - con el token del daemon solo (lo que tendría un comando del agente) no se aprueba.
 *
 * El cliente de este script habla el protocolo a mano: `dist/` es un bundle.
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';
import { startMockLlm, mockConfig } from './mock-llm.mjs';

const SHOW = process.argv.includes('--show');
const APPROVER_KEY = 'clave de aprobador del recorrido';
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

/** `approver.json`, como lo deja `stratum approvals set-key`: solo una derivación de la clave. */
function approverFile(key) {
  const params = { N: 1 << 15, r: 8, p: 1 };
  const salt = randomBytes(16);
  const hash = scryptSync(key.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * params.N * 8 });
  return JSON.stringify({
    version: 1,
    algorithm: 'scrypt',
    ...params,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: new Date().toISOString(),
  });
}

/** Cliente mínimo del protocolo. Los errores llevan su código en `err.code`. */
async function connect(home, roles, approverKey) {
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
      if (message.error) {
        waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      } else waiter.resolve(message.result);
    }
  });
  socket.on('error', () => undefined);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const hello = await request('core.hello', {
    protocol: endpoint.protocol,
    token: endpoint.token,
    client: { kind: 'other', name: 'tui-approver', version: '0' },
    roles,
    ...(approverKey ? { approverKey } : {}),
  });
  return { request, hello, close: () => socket.destroy() };
}

const codeOf = (promise) =>
  promise.then(
    () => 'OK',
    (err) => err.code ?? String(err),
  );

const config = (baseUrl) => mockConfig(baseUrl, { daemon: { autoStart: true } });
const homeFiles = { '.stratum/daemon/approver.json': approverFile(APPROVER_KEY) };

async function pendingApproval(client) {
  return until(async () => (await client.request('approvals.list')).approvals[0]);
}

const mock = await startMockLlm();
const daemons = [];

// ---------------------------------------------------------------------------
// stratum chat (Ink)
// ---------------------------------------------------------------------------
{
  const t = launch({ config: config(mock.baseUrl), files: { 'victima.txt': 'x\n' }, homeFiles });
  const victim = join(t.project, 'victima.txt');
  let approver;
  try {
    await check('chat: el daemon acredita aprobadores y la sesión se publica', t, async () => {
      await t.waitForBanner();
      approver = await until(() => connect(t.home, ['approver'], APPROVER_KEY).catch(() => null));
      daemons.push(approver);
      assert.deepEqual(approver.hello.capabilities, ['observe', 'approve']);
      assert.ok(approver.hello.features.includes('remote-approvals'));
      assert.equal((await approver.request('sessions.list')).sessions.length, 1);
    });

    await check('chat: con el token solo no se aprueba (ni host, ni operator, ni approver sin clave)', t, async () => {
      await t.submit('borra el fichero');
      await t.waitFor(/⚠ Operación destructiva/);
      const approval = await pendingApproval(approver);
      assert.equal(approval.expiresAt, null);
      assert.match(approval.description, /victima\.txt/);
      for (const roles of [['host'], ['operator'], ['approver'], ['host', 'approver']]) {
        const shell = await connect(t.home, roles);
        assert.ok(!shell.hello.capabilities.includes('approve'), roles.join('+'));
        assert.equal(
          await codeOf(shell.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' })),
          'FORBIDDEN',
          roles.join('+'),
        );
        shell.close();
      }
      assert.equal(await codeOf(connect(t.home, ['approver'], 'otra clave')), 'UNAUTHORIZED');
      // Nada cambió: el prompt sigue en pantalla y el fichero en disco.
      assert.match(t.screen(), /⚠ Operación destructiva/);
      assert.ok(existsSync(victim));
    });

    await check('chat: el remoto aprueba → el prompt desaparece y la tool corre una vez', t, async () => {
      const approval = await pendingApproval(approver);
      await approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' });
      await t.waitGone(/⚠ Operación destructiva/);
      await t.waitFor(/confirmación aprobada desde other/);
      await t.waitForIdle();
      assert.ok(!existsSync(victim), 'la tool tuvo que ejecutarse');
      assert.equal((await approver.request('approvals.list')).approvals.length, 0);
      assert.equal(
        await codeOf(approver.request('approvals.resolve', { approvalId: approval.id, decision: 'deny' })),
        'ALREADY_RESOLVED',
      );
    });

    await check('chat: el local contesta primero → la respuesta remota llega tarde', t, async () => {
      writeFileSync(victim, 'x\n');
      await t.submit('borra el fichero otra vez');
      await t.waitFor(/⚠ Operación destructiva/);
      const approval = await pendingApproval(approver);
      await t.type('n');
      await t.waitFor(/✗ exec │ User denied/);
      await t.waitForIdle();
      assert.equal(
        await codeOf(approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' })),
        'ALREADY_RESOLVED',
      );
      assert.ok(existsSync(victim), 'denegada en la terminal: no se borra');
      assert.equal((await approver.request('approvals.list')).approvals.length, 0);
      // Lo de este turno lo resolvió la terminal: no hay nota de otro cliente.
      assert.doesNotMatch(t.screen().split('otra vez').pop(), /desde other/);
    });

    await check('chat: al salir, nada queda pendiente', t, async () => {
      await t.submit('/quit');
      await until(() => t.exited());
      await until(async () => (await approver.request('sessions.list')).sessions.length === 0);
      assert.equal((await approver.request('core.status')).pendingApprovals, 0);
    });
  } finally {
    const operator = await connect(t.home, ['operator']).catch(() => null);
    await operator?.request('core.shutdown', { force: true }).catch(() => undefined);
    operator?.close();
    approver?.close();
    await sleep(500);
    await t.close();
  }
}

// ---------------------------------------------------------------------------
// stratum run (readline)
// ---------------------------------------------------------------------------
{
  const t = launch({
    config: config(mock.baseUrl),
    args: ['run', 'borra el fichero'],
    files: { 'victima.txt': 'x\n' },
    homeFiles,
  });
  const victim = join(t.project, 'victima.txt');
  let approver;
  try {
    await check('run: el prompt de la terminal está abierto y la solicitud publicada', t, async () => {
      await t.waitFor(/¿Continuar\? \(s\/N\/!\)/);
      approver = await until(() => connect(t.home, ['approver'], APPROVER_KEY).catch(() => null));
      const approval = await pendingApproval(approver);
      assert.equal(approval.tool, 'exec');
      assert.equal(approval.expiresAt, null);
      assert.ok(existsSync(victim));
    });

    await check('run: el remoto aprueba → el prompt se retira, la tool corre una vez y sale con 0', t, async () => {
      const approval = await pendingApproval(approver);
      await approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' });
      await t.waitFor(/\[resolved from another client\]/);
      const exit = await t.waitExit(20_000);
      assert.equal(exit, 0);
      assert.ok(!existsSync(victim), 'la tool tuvo que ejecutarse');
      assert.match(t.scrollback(), /Hecho\. Resultado de la tool recibido/);
      assert.equal((await approver.request('core.status')).pendingApprovals, 0);
    });
  } finally {
    const operator = await connect(t.home, ['operator']).catch(() => null);
    await operator?.request('core.shutdown', { force: true }).catch(() => undefined);
    operator?.close();
    approver?.close();
    await sleep(500);
    await t.close();
  }
}

await mock.close();
console.log(failed === 0 ? '\nTodo correcto.' : `\n${failed} comprobación(es) fallida(s).`);
process.exit(failed === 0 ? 0 : 1);

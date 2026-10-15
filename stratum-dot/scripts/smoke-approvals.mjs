/**
 * Stratum Dot resuelve aprobaciones, preguntas y planes contra un `stratumd`
 * real (criterio rey de M8), sin automatizar la ventana.
 *
 * `dot-probe` es **el mismo enlace nativo** de la app —la conexión principal
 * (`operator`) y el broker de aprobador, con su propia conexión—; la clave se
 * le da por su entrada solo porque aquí no hay ventana de desbloqueo (en la
 * app la teclea la persona en ella). Todo lo demás es de verdad: la CLI
 * compilada, su daemon con `approver.json`, las sesiones que aloja, sus tools y
 * un modelo de guion.
 *
 *   Dot → New Chat → «borra» → approval.requested → unlock → approve
 *       → approval.resolved → la tool se ejecuta → el asistente contesta
 *
 *   (en stratum-cli)  npm run build
 *   (en stratum-dot)  cargo build -p dot-link && node scripts/smoke-approvals.mjs
 *
 * HOME y proyectos son temporales: no toca `~/.stratum` ni el daemon del usuario.
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm, mockConfig, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
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

/** La clave de aprobador de esta prueba. No debe aparecer en ningún fichero ni en lo que ve la interfaz. */
const KEY = `clave-de-aprobador-${randomBytes(6).toString('hex')}`;
const WRONG = `otra-clave-${randomBytes(6).toString('hex')}`;

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

// --- entorno aislado ---------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dot-appr-home-'));
const projects = [];
function project(name, config) {
  const dir = mkdtempSync(join(tmpdir(), `dot-appr-${name}-`));
  projects.push(dir);
  writeFileSync(join(dir, 'victim.txt'), 'no me borres\n');
  writeFileSync(join(dir, 'other.txt'), 'tampoco\n');
  if (config) writeFileSync(join(dir, '.stratumrc.json'), JSON.stringify(config, null, 2));
  return dir;
}
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  STRATUM_DOT_CLI: CLI,
  NO_COLOR: '1',
};
delete env.STRATUM_NO_DAEMON;

const said = (messages) => JSON.stringify(messages);
const lastTool = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) return m.tool_calls.at(-1).function.name;
  }
  return null;
};
const mock = await startMockLlm(({ messages, last, said: lastUser }) => {
  const all = said(messages);
  if (last.role === 'tool') {
    const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const tool = lastTool(messages);
    if (all.includes('no lo borres')) return text('Entendido, no lo borro.');
    if (/PLAN MODE/.test(out)) {
      return toolCall('present_plan', {
        summary: 'Crear planned.txt',
        steps: [{ title: 'Escribir planned.txt' }, { title: 'Comprobarlo' }],
      });
    }
    if (tool === 'question') return text(`Anotado: ${out.includes('production') ? 'production' : 'otra'}.`);
    // Plan aprobado: ahora sí se hace el cambio (rechazado, el turno termina).
    if (tool === 'present_plan' && !/reject/i.test(out)) {
      return toolCall('write_file', { path: 'planned.txt', content: 'plan' });
    }
    if (tool === 'exec' && all.includes('dos borrados') && !all.includes('other.txt')) {
      return toolCall('exec', { command: 'rm other.txt' });
    }
    return text(`Hecho (${tool}).`);
  }
  if (lastUser.includes('planifica') || all.includes('planned.txt')) {
    return toolCall('write_file', { path: 'planned.txt', content: 'plan' });
  }
  if (lastUser.includes('pregunta')) {
    return toolCall('question', { questions: [{ question: '¿Entorno?', options: ['staging', 'production'] }] });
  }
  if (lastUser.includes('borra')) return toolCall('exec', { command: 'rm victim.txt' });
  return text('Vale.');
});
mkdirSync(join(home, '.stratum', 'daemon'), { recursive: true });
writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(mockConfig(mock.baseUrl), null, 2));
writeFileSync(join(home, '.stratum', 'daemon', 'approver.json'), approverFile(KEY));

const endpointFile = join(home, '.stratum', 'daemon', 'endpoint.json');
const endpoint = () => JSON.parse(readFileSync(endpointFile, 'utf-8'));
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', ...opts });
const logDir = join(home, 'dot-logs');
const dot = () => startProbe({ binary: PROBE, env, logDir });

/** Los eventos de una sesión que ha visto el probe, desde `from`. */
const eventsOf = (probe, sessionId, from = 0) =>
  probe.seen.slice(from).flatMap((m) => (m.type === 'events' && m.sessionId === sessionId ? m.events : []));
const runIs = (probe, id, status) => probe.sessions.get(id)?.run?.status === status;

/** Abre una sesión del daemon en `cwd`, la enfoca y le envía un mensaje. */
async function chat(probe, cwd, input) {
  const opened = await probe.order('open', { cwd });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const id = opened.result.session.id;
  await until(`la sesión ${id}`, () => probe.sessions.has(id));
  const sent = await probe.order('send', { sessionId: id, input });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  return id;
}

/** La solicitud pendiente de ese tipo, tal como la publicó el anfitrión. */
async function requested(probe, sessionId, type = 'approval.requested', from = 0) {
  const event = await until(`${type} en ${sessionId}`, () =>
    eventsOf(probe, sessionId, from).find((e) => e.type === type),
  );
  return event.data.approval ?? event.data.request;
}

async function unlock(probe, key = KEY) {
  return probe.order('unlock', { key });
}

let probe;
let other;
try {
  await check('sin desbloquear no hay autoridad, y una clave que no vale da un error genérico', async () => {
    probe = dot();
    await until('conectado', () => probe.connection?.kind === 'connected');
    // La conexión principal es la de M6/M7: observar y conducir. Nunca `approve`.
    assert.deepEqual(probe.connection.capabilities, ['observe', 'control']);
    assert.ok(probe.connection.features.includes('remote-approvals'));
    await until('bloqueado', () => probe.approver?.kind === 'locked');

    const bad = await unlock(probe, WRONG);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.message, 'Could not unlock approval authority.');
    assert.deepEqual(probe.approver, { kind: 'error', message: 'Could not unlock approval authority.' });
    // Sin bucles: un segundo intento inmediato no sale.
    const again = await unlock(probe);
    assert.deepEqual([again.ok, again.error.kind], [false, 'not-sent']);
    await sleep(2_100);
    const ok = await unlock(probe);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(probe.approver.kind, 'ready');
  });

  // --- criterio rey ---------------------------------------------------------
  let a;
  let projectA;
  await check('New Chat → operación protegida → aprobar desde Dot → la tool se ejecuta → el asistente responde', async () => {
    projectA = project('a');
    a = await chat(probe, projectA, 'borra el fichero');
    const approval = await requested(probe, a);
    assert.equal(approval.tool, 'exec');
    assert.match(approval.description, /rm victim\.txt/);
    await until('esperando aprobación', () => runIs(probe, a, 'waiting_approval'));
    assert.equal(existsSync(join(projectA, 'victim.txt')), true);

    const done = await probe.order('approve', { sessionId: a, approvalId: approval.id });
    assert.equal(done.ok, true, JSON.stringify(done));
    const resolved = await until('approval.resolved', () =>
      eventsOf(probe, a).find((e) => e.type === 'approval.resolved'),
    );
    assert.equal(resolved.data.status, 'approved');
    assert.equal(resolved.data.resolvedBy.kind, 'remote');
    assert.equal(resolved.data.resolvedBy.client, 'dot');
    await until('el run termina', () => runIs(probe, a, 'completed'));
    assert.equal(existsSync(join(projectA, 'victim.txt')), false);
    const photo = await probe.photo(a);
    assert.equal(photo.messages.at(-1).text, 'Hecho (exec).');
    assert.deepEqual(photo.approvals, []);
  });

  await check('denegar: la tool no se ejecuta', async () => {
    const dir = project('deny');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    const denied = await probe.order('deny', { sessionId: id, approvalId: approval.id });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    await until('termina', () => runIs(probe, id, 'completed'));
    assert.equal(existsSync(join(dir, 'victim.txt')), true);
    const resolved = eventsOf(probe, id).find((e) => e.type === 'approval.resolved');
    assert.equal(resolved.data.status, 'denied');
  });

  await check('id correcto con la sesión equivocada: rechazado, y sigue pendiente', async () => {
    const dir = project('owner');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    const crossed = await probe.order('approve', { sessionId: a, approvalId: approval.id });
    assert.deepEqual([crossed.ok, crossed.error.code], [false, 'NOT_FOUND']);
    await sleep(300);
    assert.equal(existsSync(join(dir, 'victim.txt')), true);
    assert.equal(runIs(probe, id, 'waiting_approval'), true);
    const ok = await probe.order('deny', { sessionId: id, approvalId: approval.id });
    assert.equal(ok.ok, true);
    await until('termina', () => runIs(probe, id, 'completed'));
  });

  await check('con frase (entorno de producción): sin frase o con otra no se aprueba, y «para la sesión» no vale', async () => {
    const dir = project('prod', {
      environments: { prod: { match: ['local'], tier: 'production', confirmation: 'typed' } },
    });
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    assert.equal(approval.confirmPhrase, 'local');
    assert.equal(approval.environment.name, 'prod');
    for (const attempt of [{}, { phrase: 'Local' }, { phrase: 'local', forSession: true }]) {
      const r = await probe.order('approve', { sessionId: id, approvalId: approval.id, ...attempt });
      assert.deepEqual([r.ok, r.error?.code], [false, 'INVALID_PARAMS'], JSON.stringify(attempt));
    }
    assert.equal(existsSync(join(dir, 'victim.txt')), true);
    const ok = await probe.order('approve', { sessionId: id, approvalId: approval.id, phrase: 'local' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    await until('termina', () => runIs(probe, id, 'completed'));
    assert.equal(existsSync(join(dir, 'victim.txt')), false);
  });

  await check('«para la sesión» vale para esa sesión y nada más', async () => {
    const dirA = project('allow-a');
    const dirB = project('allow-b');
    const sa = await chat(probe, dirA, 'dos borrados');
    const first = await requested(probe, sa);
    const ok = await probe.order('approve', { sessionId: sa, approvalId: first.id, forSession: true });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    await until('A termina', () => runIs(probe, sa, 'completed'));
    // El segundo borrado de A no preguntó.
    assert.equal(eventsOf(probe, sa).filter((e) => e.type === 'approval.requested').length, 1);
    assert.equal(existsSync(join(dirA, 'victim.txt')) || existsSync(join(dirA, 'other.txt')), false);
    // B sigue preguntando.
    const sb = await chat(probe, dirB, 'borra');
    const asked = await requested(probe, sb);
    assert.equal(asked.sessionId, sb);
    await probe.order('deny', { sessionId: sb, approvalId: asked.id });
    await until('B termina', () => runIs(probe, sb, 'completed'));
    assert.equal(existsSync(join(dirB, 'victim.txt')), true);
  });

  await check('preguntas: se contestan con questions.answer (ni un run nuevo ni steering) y el run sigue', async () => {
    const dir = project('question');
    const id = await chat(probe, dir, 'pregunta algo');
    const request = await requested(probe, id, 'question.requested');
    await until('esperando a la persona', () => runIs(probe, id, 'waiting_input'));
    const option = request.questions[0].options.find((o) => o.label === 'production');
    const runId = probe.sessions.get(id).run.id;
    const answered = await probe.order('answer', {
      sessionId: id,
      requestId: request.id,
      answers: [{ question: request.questions[0].question, answer: option.label, optionId: option.id }],
    });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    await until('termina', () => runIs(probe, id, 'completed'));
    assert.equal(probe.sessions.get(id).run.id, runId);
    assert.equal((await probe.photo(id)).messages.at(-1).text, 'Anotado: production.');
  });

  await check('planes: aprobar ejecuta el propuesto; rechazar no; ninguno abre otro run', async () => {
    const config = { environments: { dev: { match: ['local'], tier: 'development', requirePlan: true } } };
    const dir = project('plan', config);
    const id = await chat(probe, dir, 'planifica el fichero');
    const request = await requested(probe, id, 'plan.proposed');
    assert.deepEqual(request.plan.steps.map((s) => s.title), ['Escribir planned.txt', 'Comprobarlo']);
    const runId = probe.sessions.get(id).run.id;
    const ok = await probe.order('plan', { sessionId: id, requestId: request.id, approve: true });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    await until('termina', () => runIs(probe, id, 'completed'), 40_000);
    assert.equal(probe.sessions.get(id).run.id, runId);
    assert.equal(existsSync(join(dir, 'planned.txt')), true);

    const dir2 = project('plan-no', config);
    const id2 = await chat(probe, dir2, 'planifica el fichero');
    const request2 = await requested(probe, id2, 'plan.proposed');
    const no = await probe.order('plan', { sessionId: id2, requestId: request2.id, approve: false });
    assert.equal(no.ok, true);
    await until('termina', () => runIs(probe, id2, 'completed'), 40_000);
    assert.equal(existsSync(join(dir2, 'planned.txt')), false);
  });

  // --- carreras ---------------------------------------------------------------
  await check('dos Dot a la vez sobre la misma solicitud: gana exactamente uno', async () => {
    other = dot();
    await until('el segundo conecta', () => other.connection?.kind === 'connected');
    await until('el segundo, bloqueado', () => other.approver?.kind === 'locked');
    assert.equal((await unlock(other)).ok, true);
    const dir = project('race');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    await until('el segundo la ve', () => other.sessions.has(id));
    const [x, y] = await Promise.all([
      probe.order('approve', { sessionId: id, approvalId: approval.id }),
      other.order('deny', { sessionId: id, approvalId: approval.id }),
    ]);
    const outcomes = [x.ok ? 'OK' : x.error.code, y.ok ? 'OK' : y.error.code].sort();
    assert.deepEqual(outcomes, ['ALREADY_RESOLVED', 'OK']);
    await until('termina', () => runIs(probe, id, 'completed'));
    const resolved = eventsOf(probe, id).filter((e) => e.type === 'approval.resolved');
    assert.equal(resolved.length, 1);
    assert.equal(existsSync(join(dir, 'victim.txt')), resolved[0].data.status === 'denied');
    await other.close();
    other = null;
  });

  // --- pausa ------------------------------------------------------------------
  await check('en pausa: aprobar no reanuda; al reanudar se ejecuta', async () => {
    const dir = project('pause');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    const runId = probe.sessions.get(id).run.id;
    const paused = await probe.order('pause', { sessionId: id, runId });
    assert.equal(paused.ok, true, JSON.stringify(paused));
    const ok = await probe.order('approve', { sessionId: id, approvalId: approval.id });
    assert.equal(ok.ok, true);
    await until('en pausa tras aprobar', () => runIs(probe, id, 'paused'));
    await sleep(800);
    assert.equal(runIs(probe, id, 'paused'), true);
    assert.equal(existsSync(join(dir, 'victim.txt')), true, 'aprobar no reanuda');
    const resumed = await probe.order('resume', { sessionId: id, runId });
    assert.equal(resumed.ok, true);
    await until('termina', () => runIs(probe, id, 'completed'));
    assert.equal(existsSync(join(dir, 'victim.txt')), false);
  });

  await check('en pausa con steering: lo aprobado se descarta al reanudar (M5 intacto)', async () => {
    const dir = project('steer');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    const runId = probe.sessions.get(id).run.id;
    await probe.order('pause', { sessionId: id, runId });
    await probe.order('approve', { sessionId: id, approvalId: approval.id });
    await until('en pausa', () => runIs(probe, id, 'paused'));
    const steer = await probe.order('steer', { sessionId: id, text: 'no lo borres' });
    assert.equal(steer.status, 'accepted');
    await probe.order('resume', { sessionId: id, runId });
    await until('termina', () => runIs(probe, id, 'completed'));
    assert.equal(existsSync(join(dir, 'victim.txt')), true, 'el steering descarta lo aprobado');
    // La aprobación consta como resuelta igualmente.
    assert.equal(eventsOf(probe, id).find((e) => e.type === 'approval.resolved').data.status, 'approved');
  });

  // --- cerrar Dot, reiniciar el daemon ----------------------------------------
  let pendingSession;
  let pendingDir;
  await check('cerrar Dot con una aprobación pendiente no la toca; al volver sigue ahí y el broker está bloqueado', async () => {
    pendingDir = project('close');
    pendingSession = await chat(probe, pendingDir, 'borra');
    const approval = await requested(probe, pendingSession);
    await probe.close();
    probe = null;
    await sleep(500);
    probe = dot();
    await until('conectado', () => probe.connection?.kind === 'connected');
    await until('la sesión vuelve', () => probe.sessions.has(pendingSession));
    assert.deepEqual(probe.sessions.get(pendingSession).snapshot.approvals.map((x) => x.id), [approval.id]);
    assert.equal(probe.sessions.get(pendingSession).run.status, 'waiting_approval');
    await until('bloqueado', () => probe.approver?.kind === 'locked');
    const locked = await probe.order('approve', { sessionId: pendingSession, approvalId: approval.id });
    assert.deepEqual([locked.ok, locked.error.kind], [false, 'not-sent']);
    assert.equal((await unlock(probe)).ok, true);
    assert.equal((await probe.order('approve', { sessionId: pendingSession, approvalId: approval.id })).ok, true);
    await until('termina', () => runIs(probe, pendingSession, 'completed'));
    assert.equal(existsSync(join(pendingDir, 'victim.txt')), false);
  });

  await check('el daemon se reinicia: la autoridad no vale contra el nuevo, hay que desbloquear otra vez', async () => {
    assert.equal(probe.approver.kind, 'ready');
    process.kill(endpoint().pid, 'SIGKILL');
    await until('bloqueado por la caída', () => probe.approver?.kind === 'locked' || probe.approver?.kind === 'unavailable');
    assert.equal(cli(['daemon', 'start']).status, 0);
    await until('conectado otra vez', () => probe.connection?.kind === 'connected', 40_000);
    await until('bloqueado', () => probe.approver?.kind === 'locked');
    assert.equal(probe.approver.reason, 'connection-lost');
    assert.equal((await unlock(probe)).ok, true);
    const dir = project('after');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    assert.equal((await probe.order('approve', { sessionId: id, approvalId: approval.id })).ok, true);
    await until('termina', () => runIs(probe, id, 'completed'));
  });

  await check('bloquear a mano: lo pendiente sigue y no se puede resolver desde Dot', async () => {
    const dir = project('lock');
    const id = await chat(probe, dir, 'borra');
    const approval = await requested(probe, id);
    probe.send({ cmd: 'lock' });
    await until('bloqueado', () => probe.approver?.kind === 'locked' && probe.approver.reason === 'manual');
    const r = await probe.order('approve', { sessionId: id, approvalId: approval.id });
    assert.deepEqual([r.ok, r.error.kind], [false, 'not-sent']);
    assert.equal(runIs(probe, id, 'waiting_approval'), true);
    probe.send({ cmd: 'cancel', sessionId: id, id: 99 });
    await until('cancelado', () => runIs(probe, id, 'cancelled'));
    assert.equal(existsSync(join(dir, 'victim.txt')), true);
  });

  await check('la clave no está en ningún fichero, ni en lo que ve la interfaz, ni en el log', async () => {
    const log = readFileSync(join(logDir, 'dot.log'), 'utf-8');
    for (const expected of ['approver: unlock attempt', 'approver: unlocked', 'approver: unlock failed (UNAUTHORIZED)', 'approver: resolve approve request=']) {
      assert.ok(log.includes(expected), `falta «${expected}» en el log`);
    }
    const ui = JSON.stringify(probe.seen);
    const scanned = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.size < 32 * 1024 * 1024) scanned.push(full);
      }
    };
    for (const dir of [home, ...projects]) walk(dir);
    for (const secret of [KEY, WRONG]) {
      assert.ok(!ui.includes(secret), 'la interfaz recibió la clave');
      for (const file of scanned) {
        assert.ok(!readFileSync(file).includes(secret), `la clave está en ${file}`);
      }
    }
    assert.ok(!ui.includes(endpoint().token), 'la interfaz recibió el token');
    assert.ok(scanned.some((f) => f.endsWith('dot.log')));
  });
} finally {
  await probe?.close().catch(() => undefined);
  await other?.close().catch(() => undefined);
  cli(['daemon', 'stop', '--force']);
  await mock.close();
  await sleep(300);
  for (const dir of [home, ...projects]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(runner.failed === 0 ? '\nTodo correcto.' : `\n${runner.failed} comprobación(es) fallida(s).`);
process.exit(runner.failed === 0 ? 0 : 1);

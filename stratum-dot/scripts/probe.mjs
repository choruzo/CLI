/**
 * Lo que comparten los smokes de Dot contra un `stratumd` real: `dot-probe`
 * —el mismo enlace nativo que usa la app, con la interfaz cambiada por líneas
 * JSON— manejado desde Node, y un par de utilidades.
 */
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no se cumplió a tiempo: ${what}`);
    await sleep(100);
  }
}

/** Un corredor de comprobaciones: cada una se cuenta, y un fallo no para las demás. */
export function checker() {
  let failed = 0;
  return {
    get failed() {
      return failed;
    },
    async check(name, fn) {
      try {
        await fn();
        console.log(`✓ ${name}`);
      } catch (err) {
        failed++;
        console.log(`✗ ${name}\n  ${String(err?.stack ?? err).split('\n').join('\n  ')}`);
      }
    },
  };
}

/**
 * `dot-probe`: lo que vería y haría la interfaz de Dot.
 *
 * De cada sesión se guarda lo último que se sabe: `session` y `run` se siguen
 * por eventos (lo justo para esperar a un estado), y `snapshot` es **la última
 * foto tal cual**. La conversación solo se lee de una foto —pedir una con
 * `resync`—: aquí no hay reductor, ese es del contrato.
 */
export function startProbe({ binary, env, logDir }) {
  const child = spawn(binary, ['--log-dir', logDir], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const seen = [];
  const sessions = new Map();
  const results = new Map();
  let connection = null;
  let approver = null;
  let sessionIds = [];
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      seen.push(msg);
      if (msg.type === 'connection') connection = msg.state;
      else if (msg.type === 'approver') approver = msg.status;
      else if (msg.type === 'sessions') sessionIds = msg.sessionIds;
      else if (msg.type === 'snapshot') {
        sessions.set(msg.sessionId, {
          session: msg.snapshot.session,
          run: msg.snapshot.run,
          snapshot: msg.snapshot,
          snapshots: (sessions.get(msg.sessionId)?.snapshots ?? 0) + 1,
        });
      } else if (msg.type === 'events') {
        const known = sessions.get(msg.sessionId);
        if (!known) continue;
        for (const event of msg.events) {
          if (event.type === 'session.updated') known.session = event.data.session;
          if (event.type.startsWith('run.')) known.run = event.data.run;
        }
      } else if (msg.type === 'result') results.get(msg.id)?.(msg);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const probe = {
    seen,
    sessions,
    exited,
    get connection() {
      return connection;
    },
    /** Último estado del broker de aprobador (`ApproverStatus`). */
    get approver() {
      return approver;
    },
    get sessionIds() {
      return sessionIds;
    },
    send: (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`),
    /** Una orden o una llamada: devuelve la línea `result` de `dot-probe`. */
    order(cmd, params) {
      const id = nextId++;
      const answer = new Promise((resolve) => results.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ cmd, id, ...params })}\n`);
      return answer;
    },
    /** Pide una foto nueva de la sesión y la devuelve. */
    async photo(sessionId) {
      const before = sessions.get(sessionId)?.snapshots ?? 0;
      probe.send({ cmd: 'resync', sessionId });
      await until(`foto de ${sessionId}`, () => (sessions.get(sessionId)?.snapshots ?? 0) > before);
      return sessions.get(sessionId).snapshot;
    },
    /** Cerrar Dot: se cierra su entrada, como al salir de la app. */
    async close() {
      child.stdin.end();
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) child.kill();
    },
  };
  return probe;
}

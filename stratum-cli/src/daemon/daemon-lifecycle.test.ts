import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ENDPOINT_FILE, fileDiscovery, type Endpoint } from '../client/discovery.js';
import { ProtocolError } from '../ipc/codec.js';
import { UnknownOutcomeError } from '../ipc/peer.js';
import { makeTextRound } from '../providers/mock.js';
import { STRATUM_PROTOCOL_VERSION } from '../protocol/index.js';
import { gate, startTestDaemon, watch, type TestDaemon } from './daemon.fixtures.js';
import { DaemonAlreadyRunningError } from './endpoint.js';

/** Ciclo de vida del daemon: instancia única, endpoint, apagado y apagado por inactividad. */

const running: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop().catch(() => undefined);
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const t = await startTestDaemon(options);
  running.push(t);
  return t;
}

function sharedBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-life-')));
  bases.push(base);
  return base;
}

const readEndpoint = (dir: string): Endpoint =>
  JSON.parse(readFileSync(join(dir, ENDPOINT_FILE), 'utf-8')) as Endpoint;

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('stratumd — instancia única y endpoint', () => {
  it('el primero arranca y publica; el segundo no puede apropiarse del endpoint', async () => {
    const base = sharedBase();
    const first = await start({ base });
    const published = readEndpoint(first.dir);
    expect(published).toEqual(first.daemon.endpoint);
    expect(published).toMatchObject({ protocol: STRATUM_PROTOCOL_VERSION, pid: process.pid });
    expect(published.token).toMatch(/^[0-9a-f]{64}$/);
    // Canal local, nunca un puerto.
    expect(published.ipcPath).toMatch(process.platform === 'win32' ? /^\\\\\.\\pipe\\/ : /\.sock$/);

    await expect(startTestDaemon({ base })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    // El primero ni se ha enterado: mismo endpoint, y sigue atendiendo.
    expect(readEndpoint(first.dir)).toEqual(published);
    const client = await first.connect(['observer']);
    expect((await client.request('core.status', {})).liveSessions).toBe(0);
  });

  it('cada arranque trae un token y un canal nuevos', async () => {
    const base = sharedBase();
    const one = await start({ base });
    const before = one.daemon.endpoint;
    await one.daemon.shutdown();
    const two = await start({ base });
    expect(two.daemon.endpoint.token).not.toBe(before.token);
    expect(two.daemon.endpoint.ipcPath).not.toBe(before.ipcPath);
  });

  it('un daemon que muere sin limpiar deja un endpoint rancio, detectable y reemplazable', async () => {
    const base = sharedBase();
    const dead = await start({ base });
    const client = await dead.connect(['observer']);
    const stale = dead.daemon.endpoint;
    await dead.daemon.crash();
    await until(() => client.status === 'closed');

    // El fichero sigue ahí, apuntando a un canal donde ya no hay nadie.
    expect(readEndpoint(dead.dir)).toEqual(stale);
    const next = await start({ base });
    expect(readEndpoint(next.dir)).toEqual(next.daemon.endpoint);
    expect(next.daemon.endpoint.token).not.toBe(stale.token);
    const again = await next.connect(['observer']);
    expect((await again.request('core.status', {})).clients).toBe(1);
  });

  it('un endpoint cuyo proceso ya no existe: el cliente lo ve rancio y el arranque lo reemplaza', async () => {
    const base = sharedBase();
    const dir = join(base, 'daemon');
    mkdirSync(dir, { recursive: true });
    const ghost: Endpoint = {
      protocol: STRATUM_PROTOCOL_VERSION,
      pid: 4_194_000, // nadie
      startedAt: new Date().toISOString(),
      version: '0.0.0-old',
      ipcPath:
        process.platform === 'win32' ? '\\\\.\\pipe\\stratumd-ghost' : join(dir, 'ghost.sock'),
      token: 'f'.repeat(64),
    };
    writeFileSync(join(dir, ENDPOINT_FILE), JSON.stringify(ghost));
    expect(await fileDiscovery({ dir }).locate()).toEqual({ status: 'stale', pid: ghost.pid });

    const t = await start({ base });
    expect(await fileDiscovery({ dir }).locate()).toEqual({
      status: 'found',
      endpoint: t.daemon.endpoint,
    });
  });
});

describe('stratumd — apagado', () => {
  it('apagado limpio: despide a los clientes, retira el endpoint y limpia el proceso una vez', async () => {
    const t = await start();
    const client = await t.connect(['operator']);
    const other = await t.connect(['observer']);

    await client.request('core.shutdown', {});
    expect(await t.daemon.closed).toBe('requested');
    expect(existsSync(join(t.dir, ENDPOINT_FILE))).toBe(false);
    expect(await fileDiscovery({ dir: t.dir }).locate()).toEqual({ status: 'absent' });
    await until(() => client.status === 'closed' && other.status === 'closed');
    expect(t.teardowns()).toBe(1);
    // Apagar dos veces no limpia dos veces.
    await t.daemon.shutdown();
    expect(t.teardowns()).toBe(1);
  });

  it('con un run en curso, core.shutdown pide force; un observer no puede apagar', async () => {
    const t = await start();
    const cwd = t.project('p', [{ wait: new Promise(() => undefined), then: [] }]);
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(observer, session.id);
    await live.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'no acaba' });

    await expect(observer.request('core.shutdown', { force: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(operator.request('core.shutdown', {})).rejects.toMatchObject({ code: 'BUSY' });
    expect(t.daemon.liveSessions).toBe(1);

    await operator.request('core.shutdown', { force: true }).catch((err: unknown) => {
      // Si la conexión cae antes de la respuesta, el resultado es desconocido: vale.
      if (!(err instanceof UnknownOutcomeError) && !(err instanceof ProtocolError)) throw err;
    });
    await t.daemon.closed;
    // La sesión se cerró por su camino antes de la limpieza global.
    expect(live.types()).toContain('run.cancelled');
    expect(live.states().at(-1)).toMatchObject({
      type: 'session.closed',
      data: { reason: 'server-shutdown' },
    });
    expect(t.teardowns()).toBe(1);
  });
});

describe('stratumd — apagado por inactividad', () => {
  it('sin sesiones ni operaciones, se apaga solo', async () => {
    const t = await start({ idleExitMs: 150 });
    expect(await t.daemon.closed).toBe('idle');
    expect(existsSync(join(t.dir, ENDPOINT_FILE))).toBe(false);
    expect(t.teardowns()).toBe(1);
  });

  it('una sesión viva lo mantiene aunque no quede ningún cliente; al cerrarla, sale', async () => {
    const t = await start({ idleExitMs: 150 });
    const hold = gate();
    const cwd = t.project('p', [{ wait: hold.wait, then: makeTextRound('fin') }]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    await operator.request('runs.start', { sessionId: session.id, input: 'tarda' });
    operator.close();

    let closed = false;
    void t.daemon.closed.then(() => (closed = true));
    // Varias veces el plazo de inactividad, sin clientes: sigue vivo.
    await new Promise((r) => setTimeout(r, 700));
    expect(closed).toBe(false);
    expect(t.daemon.liveSessions).toBe(1);

    // Tampoco con la sesión parada (sin run): sigue siendo una sesión viva.
    hold.open();
    await new Promise((r) => setTimeout(r, 500));
    expect(closed).toBe(false);

    const back = await t.connect(['operator']);
    await back.request('sessions.close', { sessionId: session.id });
    back.close();
    expect(await t.daemon.closed).toBe('idle');
  });

  it('idleExitMs 0: nunca se apaga solo', async () => {
    const t = await start({ idleExitMs: 0 });
    let closed = false;
    void t.daemon.closed.then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(closed).toBe(false);
  });
});

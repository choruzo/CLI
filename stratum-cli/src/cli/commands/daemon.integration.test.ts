import { describe, it, expect, afterAll } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { StratumClient } from '../../client/client.js';
import { ENDPOINT_FILE, fileDiscovery, type Endpoint } from '../../client/discovery.js';

/**
 * `stratum daemon run|start|stop|status` con el proceso de verdad: la CLI real
 * (código fuente con tsx) en un HOME temporal. Es el único test que mata un
 * daemon con una señal que no puede atender.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'index.ts');
const tsxLoader = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs'),
).href;

const home = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-cli-')));
const dir = join(home, '.stratum', 'daemon');
const endpointFile = join(dir, ENDPOINT_FILE);
const env = { HOME: home, USERPROFILE: home, STRATUM_LOG_LEVEL: 'silent' };

const children: ResultPromise[] = [];
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await stratum('daemon', 'stop', '--force').catch(() => undefined);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function stratum(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execa(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
    env,
    reject: false,
    timeout: 60_000,
  }).then((r) => ({ exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }));
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readEndpoint = (): Endpoint => JSON.parse(readFileSync(endpointFile, 'utf-8')) as Endpoint;

describe('stratum daemon (proceso real)', () => {
  it('run, status, instancia única, kill -9 → rancio, start y stop', async () => {
    // Sin daemon.
    const none = await stratum('daemon', 'status');
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toContain('not running');

    // `run` en primer plano.
    const foreground = execa(process.execPath, ['--import', tsxLoader, cliEntry, 'daemon', 'run'], {
      env,
      reject: false,
    });
    children.push(foreground);
    await until(() => existsSync(endpointFile));
    const first = readEndpoint();
    expect(first.pid).toBe(foreground.pid);

    const status = await stratum('daemon', 'status', '--json');
    expect(status.exitCode).toBe(0);
    const info = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(info).toMatchObject({ running: true, pid: first.pid, liveSessions: 0 });
    // Ni el token ni la ruta del canal salen por pantalla.
    expect(status.stdout).not.toContain(first.token);
    expect(status.stdout).not.toContain('stratumd-');

    // Un segundo daemon no arranca ni toca el endpoint del primero.
    const second = await stratum('daemon', 'run');
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain(`already running (pid ${first.pid})`);
    expect(readEndpoint()).toEqual(first);

    // Muere sin poder limpiar nada.
    foreground.kill('SIGKILL');
    await foreground;
    expect(existsSync(endpointFile)).toBe(true);
    expect(await fileDiscovery({ dir }).locate()).toEqual({ status: 'stale', pid: first.pid });
    const stale = await stratum('daemon', 'status');
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toContain('stale');

    // El siguiente arranque reconoce el endpoint rancio y lo sustituye.
    const started = await stratum('daemon', 'start');
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain('stratumd started');
    const next = readEndpoint();
    expect(next.pid).not.toBe(first.pid);
    expect(next.token).not.toBe(first.token);

    // Y atiende a un cliente cualquiera del protocolo.
    const client = new StratumClient({
      discovery: fileDiscovery({ dir }),
      identity: { kind: 'other', name: 'test', version: '0', roles: ['observer'] },
      reconnect: false,
    });
    await client.connect();
    expect(await client.request('core.status', {})).toMatchObject({ liveSessions: 0, clients: 1 });
    expect((await client.request('sessions.list', {})).sessions).toEqual([]);
    client.close();

    const again = await stratum('daemon', 'start');
    expect(again.stdout).toContain('already running');

    const stopped = await stratum('daemon', 'stop');
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain('stratumd stopped');
    expect(existsSync(endpointFile)).toBe(false);
    expect((await stratum('daemon', 'stop')).stdout).toContain('not running');
  }, 180_000);
});

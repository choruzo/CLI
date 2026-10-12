import { describe, it, expect, afterAll } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ENDPOINT_FILE, fileDiscovery, type Endpoint } from '../client/discovery.js';
import { STRATUM_PROTOCOL_VERSION } from '../protocol/index.js';
import { DaemonAlreadyRunningError, claimEndpoint, newIpcPath, newToken } from './endpoint.js';

const base = mkdtempSync(join(tmpdir(), 'stratum-endpoint-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const freshDir = (): string => join(base, `d${n++}`, 'daemon');

function endpoint(pid = process.pid): Endpoint {
  return {
    protocol: STRATUM_PROTOCOL_VERSION,
    pid,
    startedAt: new Date().toISOString(),
    version: '0.0.0-test',
    ipcPath: newIpcPath(base),
    token: newToken(),
  };
}

const alive = { isAlive: () => true, probe: async () => true };

describe('endpoint.json', () => {
  it('se publica completo, con token aleatorio, y el cliente lo descubre', async () => {
    const dir = freshDir();
    const ep = endpoint();
    const claim = await claimEndpoint({ dir, endpoint: ep, ...alive });
    expect(claim.replacedStale).toBe(false);
    expect(JSON.parse(readFileSync(claim.file, 'utf-8'))).toEqual(ep);
    expect(ep.token).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(ep.token);
    expect(await fileDiscovery({ dir }).locate()).toEqual({ status: 'found', endpoint: ep });
    // No queda ningún temporal al lado.
    expect(readdirSync(dir)).toEqual([ENDPOINT_FILE]);
  });

  it.skipIf(process.platform === 'win32')('queda con permisos solo del usuario', async () => {
    const dir = freshDir();
    const claim = await claimEndpoint({ dir, endpoint: endpoint(), ...alive });
    expect(statSync(claim.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('un segundo daemon no se apropia del endpoint de uno vivo', async () => {
    const dir = freshDir();
    const first = endpoint();
    await claimEndpoint({ dir, endpoint: first, ...alive });
    await expect(claimEndpoint({ dir, endpoint: endpoint(), ...alive })).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
    expect(JSON.parse(readFileSync(join(dir, ENDPOINT_FILE), 'utf-8'))).toEqual(first);
    expect(readdirSync(dir)).toEqual([ENDPOINT_FILE]);
  });

  it('de varios arranques simultáneos solo gana uno', async () => {
    const dir = freshDir();
    const candidates = Array.from({ length: 6 }, () => endpoint());
    const results = await Promise.allSettled(
      candidates.map((ep) => claimEndpoint({ dir, endpoint: ep, ...alive })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DaemonAlreadyRunningError);
    }
    const published = JSON.parse(readFileSync(join(dir, ENDPOINT_FILE), 'utf-8')) as Endpoint;
    expect((won[0] as PromiseFulfilledResult<{ endpoint: Endpoint }>).value.endpoint).toEqual(
      published,
    );
  });

  it('un endpoint cuyo proceso ya no existe es rancio y se sustituye', async () => {
    const dir = freshDir();
    await claimEndpoint({ dir, endpoint: endpoint(999_999), ...alive });
    const next = endpoint();
    const claim = await claimEndpoint({
      dir,
      endpoint: next,
      isAlive: (pid) => pid !== 999_999,
      probe: async () => true,
    });
    expect(claim.replacedStale).toBe(true);
    expect(JSON.parse(readFileSync(claim.file, 'utf-8'))).toEqual(next);
  });

  it('un pid vivo sin nadie escuchando en su canal también es rancio (pid reutilizado)', async () => {
    const dir = freshDir();
    await claimEndpoint({ dir, endpoint: endpoint(), ...alive });
    // Sondeo real: en ese pipe no escucha nadie.
    const claim = await claimEndpoint({ dir, endpoint: endpoint(), isAlive: () => true });
    expect(claim.replacedStale).toBe(true);
  });

  it('un fichero ilegible no impide arrancar', async () => {
    const dir = freshDir();
    const first = await claimEndpoint({ dir, endpoint: endpoint(), ...alive });
    writeFileSync(first.file, '{ no es json');
    const claim = await claimEndpoint({ dir, endpoint: endpoint(), ...alive });
    expect(claim.replacedStale).toBe(true);
  });

  it('al soltar se borra solo si sigue siendo el nuestro', async () => {
    const dir = freshDir();
    const old = await claimEndpoint({ dir, endpoint: endpoint(999_999), ...alive });
    const current = await claimEndpoint({
      dir,
      endpoint: endpoint(),
      isAlive: () => false,
      probe: async () => false,
    });
    // El anterior ya no es el dueño: soltar no puede llevarse el del siguiente.
    await old.release();
    expect(existsSync(current.file)).toBe(true);
    await current.release();
    await current.release();
    expect(existsSync(current.file)).toBe(false);
    expect(await fileDiscovery({ dir }).locate()).toEqual({ status: 'absent' });
  });
});

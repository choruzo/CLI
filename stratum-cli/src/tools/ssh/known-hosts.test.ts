import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KnownHostsStore, verifyHostKey, fingerprintOf, HostKeyError } from './known-hosts.js';
import { SSHConnectionPool } from './pool.js';
import { startTestServer, type TestServer } from './test-server.js';
import { configWithHost } from './ssh-test-utils.js';
import { StratumConfigSchema } from '../../config/schema.js';

const KEY = Buffer.from('00000007ssh-rsa-fake-key-material', 'utf-8');
const OTHER_KEY = Buffer.from('00000007ssh-rsa-other-key-material', 'utf-8');

function host(overrides: Record<string, unknown> = {}) {
  return StratumConfigSchema.parse({
    ssh: {
      hosts: {
        h: { host: '10.0.0.1', user: 'javi', password: 'x', ...overrides },
      },
    },
  }).ssh!.hosts.h!;
}

describe('KnownHostsStore', () => {
  let dir: string;
  let store: KnownHostsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-kh-'));
    store = new KnownHostsStore(join(dir, 'known_hosts.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('devuelve un mapa vacío cuando el fichero no existe', () => {
    expect(store.list()).toEqual({});
    expect(store.read('h')).toBeUndefined();
  });

  it('persiste y relee una entrada', () => {
    store.write('h', {
      fingerprint: fingerprintOf(KEY),
      algorithm: 'ssh-ed25519',
      addedAt: new Date().toISOString(),
      host: '10.0.0.1',
    });
    expect(store.read('h')?.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('elimina una entrada e informa si no existía', () => {
    store.write('h', { fingerprint: 'x', algorithm: 'a', addedAt: 'now', host: 'h' });
    expect(store.remove('h')).toBe(true);
    expect(store.remove('h')).toBe(false);
  });

  it('genera fingerprints en el formato SHA256 de OpenSSH, sin padding', () => {
    const fp = fingerprintOf(KEY);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith('=')).toBe(false);
  });
});

describe('verifyHostKey', () => {
  let dir: string;
  let store: KnownHostsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-kh-'));
    store = new KnownHostsStore(join(dir, 'known_hosts.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = { alias: 'h', key: KEY, algorithm: 'ssh-ed25519' as const };

  it('tofu: la primera conexión pregunta y persiste la clave al aprobar', async () => {
    const confirm = vi.fn().mockResolvedValue('approve');
    await verifyHostKey({ ...base, host: host(), store, confirm });

    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toContain(fingerprintOf(KEY));
    expect(store.read('h')?.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('tofu: la segunda conexión con la misma clave no vuelve a preguntar', async () => {
    const confirm = vi.fn().mockResolvedValue('approve');
    await verifyHostKey({ ...base, host: host(), store, confirm });
    confirm.mockClear();
    await verifyHostKey({ ...base, host: host(), store, confirm });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('tofu: denegar aborta y no persiste nada', async () => {
    const confirm = vi.fn().mockResolvedValue('deny');
    await expect(verifyHostKey({ ...base, host: host(), store, confirm })).rejects.toThrow(
      /no confiada/,
    );
    expect(store.read('h')).toBeUndefined();
  });

  it('tofu: sin gate interactivo (CI, salida a pipe) aborta en vez de confiar', async () => {
    await expect(verifyHostKey({ ...base, host: host(), store })).rejects.toThrow(/no confiada/);
    expect(store.read('h')).toBeUndefined();
  });

  it('allow-all confía en ESTE host, nunca en los siguientes', async () => {
    const confirm = vi.fn().mockResolvedValue('allow-all');
    await verifyHostKey({ ...base, host: host(), store, confirm });
    expect(store.read('h')).toBeDefined();

    // Otro alias con otra clave vuelve a pasar por el gate.
    const confirm2 = vi.fn().mockResolvedValue('deny');
    await expect(
      verifyHostKey({
        alias: 'otro',
        key: OTHER_KEY,
        algorithm: 'ssh-ed25519',
        host: host(),
        store,
        confirm: confirm2,
      }),
    ).rejects.toThrow();
    expect(confirm2).toHaveBeenCalledOnce();
  });

  it('un mismatch aborta SIEMPRE, sin preguntar, y es irrecuperable', async () => {
    const confirm = vi.fn().mockResolvedValue('approve');
    await verifyHostKey({ ...base, host: host(), store, confirm });
    confirm.mockClear();

    const err = await verifyHostKey({
      ...base,
      key: OTHER_KEY,
      host: host(),
      store,
      confirm,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HostKeyError);
    expect((err as HostKeyError).recoverable).toBe(false);
    expect((err as Error).message).toContain('HOST KEY MISMATCH');
    expect((err as Error).message).toContain('stratum ssh trust h --force');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('strict: acepta solo el hostKeyHash pinneado', async () => {
    const pinned = host({ hostKeyPolicy: 'strict', hostKeyHash: fingerprintOf(KEY) });
    await expect(verifyHostKey({ ...base, host: pinned, store })).resolves.toBeUndefined();
    // No usa known_hosts.
    expect(store.read('h')).toBeUndefined();

    await expect(verifyHostKey({ ...base, key: OTHER_KEY, host: pinned, store })).rejects.toThrow(
      /HOST KEY MISMATCH/,
    );
  });

  it('insecure: acepta cualquier clave sin preguntar ni persistir', async () => {
    const confirm = vi.fn();
    await verifyHostKey({ ...base, host: host({ hostKeyPolicy: 'insecure' }), store, confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(store.read('h')).toBeUndefined();
  });
});

describe('verificación de host key sobre una conexión real', () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-kh-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function poolFor(policy: string) {
    const config = configWithHost('dev', server.port, { hostKeyPolicy: policy });
    const store = new KnownHostsStore(join(dir, 'known_hosts.json'));
    return { pool: new SSHConnectionPool(config, store), store };
  }

  it('tofu guarda el fingerprint real del servidor al aceptarlo', async () => {
    const { pool, store } = poolFor('tofu');
    await pool.getConnection('dev', async () => 'approve');
    expect(store.read('dev')?.fingerprint).toBe(server.fingerprint);
    await pool.closeAll();
  });

  it('un mismatch impide la conexión con el error de MISMATCH, no con "handshake failed"', async () => {
    const { pool, store } = poolFor('tofu');
    store.write('dev', {
      fingerprint: 'SHA256:claveQueNoEsLaDelServidor',
      algorithm: 'ssh-rsa',
      addedAt: new Date().toISOString(),
      host: '127.0.0.1',
    });

    await expect(pool.getConnection('dev', async () => 'approve')).rejects.toThrow(
      /HOST KEY MISMATCH/,
    );
    await pool.closeAll();
  });
});

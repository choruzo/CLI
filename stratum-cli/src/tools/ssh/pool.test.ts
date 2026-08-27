import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SSHConnectionPool, detectKeyAlgorithm } from './pool.js';
import { KnownHostsStore } from './known-hosts.js';
import { startTestServer, type TestServer } from './test-server.js';
import { configWithHost } from './ssh-test-utils.js';

/**
 * Todos los hosts de este fichero usan `hostKeyPolicy: 'insecure'`, así que el
 * store nunca llega a escribirse; aun así apunta a un temporal propio para que
 * un fallo no toque el `~/.stratum/known_hosts.json` real del usuario.
 */
const storeDir = mkdtempSync(join(tmpdir(), 'stratum-pool-'));

afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

function throwawayStore(): KnownHostsStore {
  return new KnownHostsStore(join(storeDir, 'known_hosts.json'));
}

describe('SSHConnectionPool', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  function makePool(overrides: Record<string, unknown> = {}, extra = {}) {
    const config = configWithHost('dev', server.port, overrides, extra);
    return new SSHConnectionPool(config, throwawayStore());
  }

  it('reutiliza la conexión establecida en llamadas sucesivas', async () => {
    const pool = makePool();
    const before = server.connectionCount();

    const a = await pool.getConnection('dev');
    const b = await pool.getConnection('dev');

    expect(a).toBe(b);
    expect(server.connectionCount()).toBe(before + 1);
    await pool.closeAll();
  });

  it('dos peticiones concurrentes al mismo alias comparten un único socket', async () => {
    const pool = makePool();
    const before = server.connectionCount();

    // Este es el caso que motiva el mapa `inflight`: ssh_exec va con
    // serialized: false, así que dos tool calls pueden llegar a la vez.
    const [a, b, c] = await Promise.all([
      pool.getConnection('dev'),
      pool.getConnection('dev'),
      pool.getConnection('dev'),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(server.connectionCount()).toBe(before + 1);
    await pool.closeAll();
  });

  it('la primera apertura que falla rechaza de inmediato, sin backoff', async () => {
    // Puerto cerrado: nadie escucha ahí.
    const pool = makePool({ port: 1, connectTimeout: 1000 });
    const started = Date.now();

    await expect(pool.getConnection('dev')).rejects.toThrow();

    // Sin backoff: si hubiera reintentos 2s/4s/8s, esto tardaría segundos.
    expect(Date.now() - started).toBeLessThan(2000);
    await pool.closeAll();
  });

  it('un fallo de apertura no deja la promesa cacheada: el siguiente intento reintenta', async () => {
    const pool = makePool({ port: 1, connectTimeout: 500 });
    await expect(pool.getConnection('dev')).rejects.toThrow();
    await expect(pool.getConnection('dev')).rejects.toThrow();
    await pool.closeAll();
  });

  it('desaloja la conexión del pool cuando se cae', async () => {
    const pool = makePool();
    const client = await pool.getConnection('dev');
    expect(pool.activeAliases()).toContain('dev');

    await new Promise<void>((resolve) => {
      client.once('close', () => setTimeout(resolve, 20));
      client.end();
    });

    expect(pool.activeAliases()).not.toContain('dev');
    await pool.closeAll();
  });

  it('closeAll cierra todo y deja el pool vacío', async () => {
    const pool = makePool(
      {},
      {
        otro: {
          host: '127.0.0.1',
          port: server.port,
          user: 'tester',
          password: 'x',
          hostKeyPolicy: 'insecure',
        },
      },
    );

    await pool.getConnection('dev');
    await pool.getConnection('otro');
    expect(pool.activeAliases()).toHaveLength(2);

    await pool.closeAll();
    expect(pool.activeAliases()).toHaveLength(0);
  });

  it('un error tardío tras un fallo de conexión no tumba el proceso', async () => {
    // ssh2 emite 'error' de forma asíncrona incluso después de rechazar la
    // promesa ("Connection lost before handshake"). Sin un listener permanente,
    // ese EventEmitter sin manejador mata el proceso entero.
    const pool = makePool({ port: 1, connectTimeout: 300 });
    await expect(pool.getConnection('dev')).rejects.toThrow();

    const late: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      late.push(err);
    };
    process.on('uncaughtException', onUncaught);
    await new Promise((resolve) => setTimeout(resolve, 400));
    process.off('uncaughtException', onUncaught);

    expect(late).toHaveLength(0);
    await pool.closeAll();
  });

  it('resuelve el host del inventario y lanza con los alias disponibles si no existe', () => {
    const pool = makePool();
    expect(pool.host('dev').port).toBe(server.port);
    expect(() => pool.host('fantasma')).toThrow(/Hosts disponibles: dev/);
  });
});

describe('SSHConnectionPool — reconexión', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'reconecta en background una conexión establecida que se cae',
    async () => {
      const config = configWithHost('dev', server.port);
      const pool = new SSHConnectionPool(config, throwawayStore());

      const first = await pool.getConnection('dev');
      const connectionsBefore = server.connectionCount();

      // Caída de red simulada: la conexión ya estaba establecida, así que el
      // pool debe reintentar solo (primer intento a los 2s).
      first.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pool.activeAliases()).not.toContain('dev');

      await new Promise((resolve) => setTimeout(resolve, 2600));

      expect(pool.activeAliases()).toContain('dev');
      expect(server.connectionCount()).toBe(connectionsBefore + 1);
      expect(await pool.getConnection('dev')).not.toBe(first);

      await pool.closeAll();
    },
    { timeout: 15000 },
  );

  it('no reintenta tras closeAll: el cierre es deliberado, no una caída', async () => {
    const config = configWithHost('dev', server.port);
    const pool = new SSHConnectionPool(config, throwawayStore());

    await pool.getConnection('dev');
    const connectionsBefore = server.connectionCount();
    await pool.closeAll();

    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(pool.activeAliases()).toHaveLength(0);
    expect(server.connectionCount()).toBe(connectionsBefore);
  }, 15000);
});

describe('SSHConnectionPool — jump hosts', () => {
  let bastionServer: TestServer;
  let targetServer: TestServer;

  beforeAll(async () => {
    // El bastión debe permitir direct-tcpip para abrir el túnel al destino.
    bastionServer = await startTestServer({ allowForward: true });
    targetServer = await startTestServer();
  });

  afterAll(async () => {
    await bastionServer.close();
    await targetServer.close();
  });

  function jumpPool() {
    const config = configWithHost(
      'leaf',
      targetServer.port,
      { jumpHost: 'bastion' },
      {
        bastion: {
          host: '127.0.0.1',
          port: bastionServer.port,
          user: 'tester',
          password: 'x',
          hostKeyPolicy: 'insecure',
        },
      },
    );
    return new SSHConnectionPool(config, throwawayStore());
  }

  it('alcanza el destino a través del bastión y cachea ambas conexiones', async () => {
    const pool = jumpPool();
    const targetBefore = targetServer.connectionCount();
    const bastionBefore = bastionServer.connectionCount();

    await pool.getConnection('leaf');

    expect(pool.activeAliases().sort()).toEqual(['bastion', 'leaf']);
    expect(bastionServer.connectionCount()).toBe(bastionBefore + 1);
    expect(targetServer.connectionCount()).toBe(targetBefore + 1);

    await pool.closeAll();
  });

  it('closeAll cierra la hoja antes que su bastión', async () => {
    // El orden inverso al de apertura es el único seguro: cerrar el bastión
    // primero rompe los streams que lo atraviesan.
    const pool = jumpPool();
    const closed: string[] = [];

    const bastion = await pool.getConnection('bastion');
    const leaf = await pool.getConnection('leaf');
    bastion.once('close', () => closed.push('bastion'));
    leaf.once('close', () => closed.push('leaf'));

    await pool.closeAll();

    expect(closed).toEqual(['leaf', 'bastion']);
    expect(pool.activeAliases()).toHaveLength(0);
  });
});

describe('detectKeyAlgorithm', () => {
  it('lee el nombre del algoritmo del formato wire de la clave', () => {
    const name = 'ssh-ed25519';
    const key = Buffer.alloc(4 + name.length);
    key.writeUInt32BE(name.length, 0);
    key.write(name, 4, 'ascii');
    expect(detectKeyAlgorithm(key)).toBe(name);
  });

  it('degrada a "unknown" con datos que no son una clave', () => {
    expect(detectKeyAlgorithm(Buffer.from([1, 2]))).toBe('unknown');
    expect(detectKeyAlgorithm(Buffer.alloc(16))).toBe('unknown');
  });
});

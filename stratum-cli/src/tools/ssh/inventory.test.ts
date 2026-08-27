import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveHost,
  resolveSecret,
  resolveAgentSocket,
  buildConnectConfig,
  secretEnvVar,
} from './inventory.js';
import { StratumConfigSchema } from '../../config/schema.js';

function configWith(hosts: Record<string, Record<string, unknown>>) {
  return StratumConfigSchema.parse({ ssh: { hosts } });
}

describe('resolveHost', () => {
  it('devuelve el host con los defaults del schema aplicados', () => {
    const config = configWith({ dev: { host: '10.0.0.5', user: 'javi', useAgent: true } });
    const host = resolveHost(config, 'dev');
    expect(host.port).toBe(22);
    expect(host.hostKeyPolicy).toBe('tofu');
    expect(host.confirmAll).toBe(false);
    expect(host.commandTimeout).toBe(30000);
    expect(host.maxBytes).toBe(262144);
  });

  it('lista los alias disponibles cuando el host no existe', () => {
    const config = configWith({
      dev: { host: 'a', user: 'u', useAgent: true },
      prod: { host: 'b', user: 'u', useAgent: true },
    });
    expect(() => resolveHost(config, 'staging')).toThrow(/Hosts disponibles: dev, prod/);
  });

  it('lo indica cuando no hay inventario en absoluto', () => {
    const config = StratumConfigSchema.parse({});
    expect(() => resolveHost(config, 'dev')).toThrow(/inventario vacío/);
  });
});

describe('resolveSecret', () => {
  const ENV_VAR = 'STRATUM_TEST_SSH_SECRET';
  const FALLBACK = secretEnvVar('prod-web');

  beforeEach(() => {
    delete process.env[ENV_VAR];
    delete process.env[FALLBACK];
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
    delete process.env[FALLBACK];
  });

  it('resuelve el prefijo env: desde el entorno', () => {
    process.env[ENV_VAR] = 's3cr3t';
    expect(resolveSecret(`env:${ENV_VAR}`, 'prod-web')).toBe('s3cr3t');
  });

  it('cae a STRATUM_SSH_<ALIAS>_SECRET si la variable de env: no está definida', () => {
    process.env[FALLBACK] = 'desde-fallback';
    expect(resolveSecret(`env:${ENV_VAR}`, 'prod-web')).toBe('desde-fallback');
  });

  it('nombra ambas variables en el error cuando no hay ninguna', () => {
    expect(() => resolveSecret(`env:${ENV_VAR}`, 'prod-web')).toThrow(
      new RegExp(`${ENV_VAR}.*${FALLBACK}`, 's'),
    );
  });

  it('devuelve el valor literal cuando no hay prefijo', () => {
    expect(resolveSecret('contraseña-en-claro', 'prod-web')).toBe('contraseña-en-claro');
  });

  it('explica la alternativa cuando se usa keychain:, no soportado', () => {
    const err = (() => {
      try {
        resolveSecret('keychain:prod', 'prod-web');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain('no soportado');
    expect(err?.message).toContain('env:<VARIABLE>');
    expect(err?.message).toContain(FALLBACK);
  });

  it('keychain: sí funciona si el fallback de entorno está definido', () => {
    process.env[FALLBACK] = 'del-entorno';
    expect(resolveSecret('keychain:prod', 'prod-web')).toBe('del-entorno');
  });

  it('normaliza el alias al construir el nombre de la variable', () => {
    expect(secretEnvVar('prod-web.01')).toBe('STRATUM_SSH_PROD_WEB_01_SECRET');
  });
});

describe('resolveAgentSocket', () => {
  it('usa el named pipe de OpenSSH o Pageant en Windows, y SSH_AUTH_SOCK en POSIX', () => {
    if (process.platform === 'win32') {
      expect(['\\\\.\\pipe\\openssh-ssh-agent', 'pageant']).toContain(resolveAgentSocket());
      return;
    }
    const previous = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    expect(resolveAgentSocket()).toBe('/tmp/agent.sock');
    delete process.env.SSH_AUTH_SOCK;
    expect(() => resolveAgentSocket()).toThrow(/SSH_AUTH_SOCK/);
    if (previous !== undefined) process.env.SSH_AUTH_SOCK = previous;
  });
});

describe('buildConnectConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-inv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lee la clave privada del disco y traslada los campos de conexión', async () => {
    const keyPath = join(dir, 'id_test');
    writeFileSync(keyPath, 'CLAVE-FALSA', 'utf-8');
    const config = configWith({
      dev: { host: '10.0.0.5', port: 2222, user: 'javi', privateKey: keyPath },
    });

    const connect = await buildConnectConfig(resolveHost(config, 'dev'), 'dev');
    expect(connect.host).toBe('10.0.0.5');
    expect(connect.port).toBe(2222);
    expect(connect.username).toBe('javi');
    expect(connect.readyTimeout).toBe(10000);
    expect(connect.privateKey?.toString()).toBe('CLAVE-FALSA');
  });

  it('nombra la ruta en el error si la clave privada no se puede leer', async () => {
    const config = configWith({
      dev: { host: '10.0.0.5', user: 'javi', privateKey: join(dir, 'no-existe') },
    });
    await expect(buildConnectConfig(resolveHost(config, 'dev'), 'dev')).rejects.toThrow(
      /No se pudo leer la clave privada de "dev"/,
    );
  });

  it('nunca monta el hostVerifier: la verificación la añade el pool', async () => {
    const config = configWith({ dev: { host: '10.0.0.5', user: 'javi', password: 'x' } });
    const connect = await buildConnectConfig(resolveHost(config, 'dev'), 'dev');
    expect(connect.hostVerifier).toBeUndefined();
    expect(connect.password).toBe('x');
  });
});

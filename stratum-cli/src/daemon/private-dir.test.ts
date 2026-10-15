/**
 * M9 — la carpeta del daemon y su canal son privados, y lo que el sistema
 * verifica de quien conecta se dice tal cual (sin prometer más).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { STRATUM_PROTOCOL_VERSION } from '../protocol/index.js';
import { claimEndpoint, newIpcPath, newToken } from './endpoint.js';
import { peerVerification } from './peer-identity.js';
import { InsecureDaemonDirError, ensurePrivateDir, ensurePrivateDirSync } from './private-dir.js';

const base = mkdtempSync(join(tmpdir(), 'stratum-private-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => join(base, `d${n++}`, 'daemon');
const posix = process.platform !== 'win32';

describe('carpeta privada del daemon', () => {
  it('se crea si falta y, en POSIX, queda solo para este usuario', async () => {
    const dir = fresh();
    await ensurePrivateDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('una carpeta que existía abierta a otros se cierra', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    await ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    ensurePrivateDirSync(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('un enlace simbólico en su lugar no se sigue: no se arranca', async () => {
    const target = fresh();
    mkdirSync(target, { recursive: true });
    const dir = fresh();
    mkdirSync(join(dir, '..'), { recursive: true });
    try {
      symlinkSync(target, dir, 'junction');
    } catch {
      return; // sin permiso para crear enlaces (Windows sin modo desarrollador)
    }
    await expect(ensurePrivateDir(dir)).rejects.toBeInstanceOf(InsecureDaemonDirError);
    expect(() => ensurePrivateDirSync(dir)).toThrow(InsecureDaemonDirError);
    // Y el endpoint no se publica ahí.
    await expect(
      claimEndpoint({
        dir,
        endpoint: {
          protocol: STRATUM_PROTOCOL_VERSION,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          version: 't',
          ipcPath: newIpcPath(base),
          token: newToken(),
        },
      }),
    ).rejects.toBeInstanceOf(InsecureDaemonDirError);
  });

  it('el motivo no lleva rutas', () => {
    const err = new InsecureDaemonDirError('it belongs to another user');
    expect(err.message).toBe(
      'The Stratum daemon folder is not private: it belongs to another user.',
    );
  });
});

describe('lo que el sistema verifica de quien conecta', () => {
  it('se dice sin exagerar: en POSIX el permiso del socket, en Windows nada más que el token', () => {
    expect(peerVerification('linux')).toEqual({
      check: 'socket-permissions',
      boundary: 'same-user-or-root',
    });
    expect(peerVerification('darwin')).toEqual({
      check: 'socket-permissions',
      boundary: 'same-user-or-root',
    });
    expect(peerVerification('win32')).toEqual({ check: 'none', boundary: 'token-only' });
  });
});

describe('el daemon arranca con su canal privado', () => {
  it.runIf(posix)(
    'carpeta 0700, endpoint 0600 y socket 0600 antes de que nadie lo descubra',
    async () => {
      const { startTestDaemon } = await import('./daemon.fixtures.js');
      const { readFileSync } = await import('fs');
      const t = await startTestDaemon();
      try {
        const endpoint = JSON.parse(readFileSync(join(t.dir, 'endpoint.json'), 'utf-8')) as {
          ipcPath: string;
        };
        expect(statSync(t.dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(t.dir, 'endpoint.json')).mode & 0o777).toBe(0o600);
        expect(statSync(endpoint.ipcPath).mode & 0o777).toBe(0o600);
      } finally {
        await t.stop();
      }
    },
  );
});

describe('socket de reserva (ruta demasiado larga para sun_path)', () => {
  it('va en una subcarpeta propia del temporal, nunca suelto', () => {
    const long = join(base, 'x'.repeat(120));
    const path = newIpcPath(long, 'linux');
    expect(path.startsWith(join(tmpdir(), 'stratumd-'))).toBe(true);
    expect(path.endsWith(join('', 'd.sock'))).toBe(true);
  });

  it.runIf(posix)('el daemon la crea privada y la quita al apagarse', async () => {
    const { startTestDaemon } = await import('./daemon.fixtures.js');
    const { readFileSync, existsSync } = await import('fs');
    const { dirname } = await import('path');
    const dir = join(base, 'y'.repeat(110), 'daemon');
    const t = await startTestDaemon({ dir });
    const { ipcPath } = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf-8')) as {
      ipcPath: string;
    };
    expect(dirname(ipcPath)).not.toBe(dir);
    expect(statSync(dirname(ipcPath)).mode & 0o777).toBe(0o700);
    expect(statSync(ipcPath).mode & 0o777).toBe(0o600);
    await t.stop();
    expect(existsSync(dirname(ipcPath))).toBe(false);
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ENDPOINT_FILE,
  defaultEndpointDir,
  fileDiscovery,
  parseEndpoint,
  processAlive,
  staticDiscovery,
  type Endpoint,
} from './discovery.js';
import { createBackoff, sleep } from './reconnect.js';
import { STRATUM_PROTOCOL_VERSION } from '../protocol/index.js';

const dir = mkdtempSync(join(tmpdir(), 'stratum-discovery-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const endpoint: Endpoint = {
  protocol: STRATUM_PROTOCOL_VERSION,
  pid: process.pid,
  startedAt: '2026-10-12T10:00:00.000Z',
  version: '0.9.0',
  ipcPath: '\\\\.\\pipe\\stratumd-abc',
  token: 'a'.repeat(64),
};

function write(content: string): void {
  writeFileSync(join(dir, ENDPOINT_FILE), content, 'utf-8');
}

describe('parseEndpoint', () => {
  it('acepta un endpoint válido de la versión actual', () => {
    expect(parseEndpoint(JSON.stringify(endpoint))).toEqual({ status: 'found', endpoint });
    // Con BOM, como lo dejaría un editor de Windows.
    expect(parseEndpoint('﻿' + JSON.stringify(endpoint)).status).toBe('found');
  });

  it('otra versión del protocolo es incompatible, no inválido', () => {
    expect(parseEndpoint(JSON.stringify({ ...endpoint, protocol: 2 }))).toEqual({
      status: 'incompatible',
      protocol: 2,
      version: '0.9.0',
    });
  });

  it('lo ilegible es inválido, y el motivo no revela el token', () => {
    expect(parseEndpoint('{')).toEqual({ status: 'invalid', reason: 'not valid JSON' });
    const short = parseEndpoint(JSON.stringify({ ...endpoint, token: 'secreto-corto' }));
    expect(short).toEqual({ status: 'invalid', reason: 'bad field: token' });
    expect(JSON.stringify(short)).not.toContain('secreto-corto');
    expect(parseEndpoint(JSON.stringify({ ...endpoint, ipcPath: '' })).status).toBe('invalid');
  });
});

describe('fileDiscovery', () => {
  it('sin fichero: absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'stratum-discovery-empty-'));
    try {
      expect(await fileDiscovery({ dir: empty }).locate()).toEqual({ status: 'absent' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('con fichero y proceso vivo: found', async () => {
    write(JSON.stringify(endpoint));
    expect(await fileDiscovery({ dir }).locate()).toEqual({ status: 'found', endpoint });
  });

  it('con fichero y proceso muerto: stale', async () => {
    write(JSON.stringify({ ...endpoint, pid: 424242 }));
    expect(await fileDiscovery({ dir, isAlive: () => false }).locate()).toEqual({
      status: 'stale',
      pid: 424242,
    });
  });

  it('fichero dañado: invalid', async () => {
    write('no es json');
    expect((await fileDiscovery({ dir }).locate()).status).toBe('invalid');
  });

  it('se relee en cada intento', async () => {
    const discovery = fileDiscovery({ dir });
    write(JSON.stringify(endpoint));
    expect((await discovery.locate()).status).toBe('found');
    write(JSON.stringify({ ...endpoint, ipcPath: '\\\\.\\pipe\\stratumd-otro' }));
    expect(await discovery.locate()).toMatchObject({
      status: 'found',
      endpoint: { ipcPath: '\\\\.\\pipe\\stratumd-otro' },
    });
  });

  it('la carpeta por defecto cuelga del home', () => {
    expect(defaultEndpointDir('/home/u').replace(/\\/g, '/')).toBe('/home/u/.stratum/daemon');
  });

  it('processAlive reconoce al propio proceso', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});

describe('staticDiscovery', () => {
  it('fijo, calculado o ausente', async () => {
    expect((await staticDiscovery(endpoint).locate()).status).toBe('found');
    expect(await staticDiscovery(() => null).locate()).toEqual({ status: 'absent' });
    expect((await staticDiscovery({ ...endpoint, protocol: 9 }).locate()).status).toBe(
      'incompatible',
    );
  });
});

describe('backoff', () => {
  it('crece hasta el tope y respeta el máximo de intentos', () => {
    const backoff = createBackoff({ initialMs: 100, maxMs: 500, factor: 2, jitter: 0 });
    expect([1, 2, 3, 4, 5].map((n) => backoff.delay(n))).toEqual([100, 200, 400, 500, 500]);

    const limited = createBackoff({ initialMs: 10, jitter: 0, maxAttempts: 2 });
    expect([1, 2, 3].map((n) => limited.delay(n))).toEqual([10, 20, null]);
  });

  it('el jitter solo suma, dentro de su fracción', () => {
    const backoff = createBackoff({ initialMs: 100, jitter: 0.5, random: () => 1 });
    expect(backoff.delay(1)).toBe(150);
  });

  it('sleep se puede cortar', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(await sleep(1, new AbortController().signal)).toBe(true);
    expect(await sleep(1, controller.signal)).toBe(false);
  });
});

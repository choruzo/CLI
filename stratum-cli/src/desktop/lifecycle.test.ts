import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShutdownRegistry } from './lifecycle.js';
import { LineDecoder, FrameTooLargeError, parseInboundFrame } from './codec.js';
import { loadSharedConfig, parseSidecarArgs } from './main.js';
import {
  setOptionalModuleLoader,
  importOptional,
  toNamespace,
} from '../runtime/optional-import.js';

describe('ShutdownRegistry', () => {
  it('ejecuta los ganchos en orden inverso y aísla los fallos', async () => {
    const order: string[] = [];
    const reg = new ShutdownRegistry();
    reg.onShutdown('a', () => void order.push('a'));
    reg.onShutdown('b', () => {
      throw new Error('boom');
    });
    reg.onShutdown('c', async () => void order.push('c'));

    const result = await reg.run();
    expect(order).toEqual(['c', 'a']);
    expect(result).toEqual({ failed: ['b'], timedOut: false });
  });

  it('es idempotente: una segunda llamada no repite los ganchos', async () => {
    let calls = 0;
    const reg = new ShutdownRegistry();
    reg.onShutdown('x', () => void calls++);
    await Promise.all([reg.run(), reg.run()]);
    await reg.run();
    expect(calls).toBe(1);
  });

  it('acota el tiempo total aunque un gancho no termine nunca', async () => {
    const reg = new ShutdownRegistry(50);
    reg.onShutdown('cuelga', () => new Promise<void>(() => undefined));
    const result = await reg.run();
    expect(result.timedOut).toBe(true);
  });
});

describe('LineDecoder', () => {
  it('no corrompe un carácter multibyte partido entre chunks', () => {
    const d = new LineDecoder(1024);
    const bytes = Buffer.from('{"t":"ñandú"}\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // en mitad de la «ñ»
    expect(d.push(bytes.subarray(0, cut))).toEqual([]);
    expect(d.push(bytes.subarray(cut))).toEqual(['{"t":"ñandú"}']);
  });

  it('acepta CRLF e ignora líneas vacías', () => {
    const d = new LineDecoder(1024);
    expect(d.push(Buffer.from('a\r\n\n\r\nb\n'))).toEqual(['a', 'b']);
  });

  it('lanza si una línea en curso supera el tope, aunque no haya llegado su salto', () => {
    const d = new LineDecoder(8);
    d.push(Buffer.from('12345'));
    expect(() => d.push(Buffer.from('6789'))).toThrow(FrameTooLargeError);
  });
});

describe('parseInboundFrame', () => {
  it.each([
    ['[]', null],
    ['"ping"', null],
    ['{"type":"handshake"}', null],
    ['{"type":"ping","id":3}', null],
    ['{"type":"ping","id":"x","extra":1}', { type: 'ping', id: 'x' }],
    ['{"type":"handshake","token":"t"}', { type: 'handshake', token: 't' }],
  ])('%s', (line, expected) => {
    expect(parseInboundFrame(line)).toEqual(expected);
  });
});

describe('parseSidecarArgs', () => {
  it('reconoce ambas formas de --ipc-path y los flags', () => {
    expect(parseSidecarArgs(['--ipc-path', 'p', '--watch-stdin'])).toEqual({
      ipcPath: 'p',
      watchStdin: true,
      selfTest: false,
    });
    expect(parseSidecarArgs(['--ipc-path=q', '--self-test']).ipcPath).toBe('q');
  });
});

describe('loadSharedConfig', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('convierte una config de un Stratum más nuevo en un error fatal reportable, sin lanzar', () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-sidecar-'));
    writeFileSync(join(dir, '.stratumrc.json'), JSON.stringify({ schemaVersion: 99 }));
    const { config, error } = loadSharedConfig(dir);
    expect(config.memory).toBeDefined(); // defaults, para poder seguir contestando
    expect(error).toMatchObject({
      type: 'sidecar_error',
      fatal: true,
      code: 'schema_incompatible',
    });
    expect(error!.message).toContain('schemaVersion 99');
  });

  it('distingue una config que no valida', () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-sidecar-'));
    writeFileSync(join(dir, '.stratumrc.json'), '{ roto');
    expect(loadSharedConfig(dir).error).toMatchObject({ code: 'config_invalid', fatal: true });
  });
});

describe('importOptional', () => {
  afterEach(() => setOptionalModuleLoader(null));

  it('con un resolvedor instalado, normaliza un export CommonJS a namespace ESM', async () => {
    class Db {}
    setOptionalModuleLoader((s) => (s === 'fake-db' ? Db : null));
    const mod = await importOptional<{ default: unknown }>('fake-db');
    expect(mod.default).toBe(Db);
  });

  it('respeta un namespace ESM ya formado', () => {
    const ns = Object.defineProperty({ pipeline: 1 }, Symbol.toStringTag, { value: 'Module' });
    expect(toNamespace(ns)).toBe(ns);
    expect(toNamespace({ load: 1 })).toMatchObject({ load: 1, default: { load: 1 } });
  });
});

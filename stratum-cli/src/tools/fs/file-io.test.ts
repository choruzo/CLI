import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  linkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  FileChangedError,
  UnsupportedEncodingError,
  decodeText,
  detectEol,
  readTextFile,
  toCrlf,
  writeTextFileAtomic,
} from './file-io.js';

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `stratum-fileio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const leftovers = () => readdirSync(dir).filter((f) => f.endsWith('.stratum-tmp'));

describe('decodeText', () => {
  it('separa el BOM UTF-8 del texto', () => {
    const r = decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(r).toEqual({ text: 'hi', bom: true });
  });

  it('rechaza UTF-16, binarios y UTF-8 inválido', () => {
    expect(() => decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toThrow(
      UnsupportedEncodingError,
    );
    expect(() => decodeText(Buffer.from([0x68, 0x00, 0x69]))).toThrow(/binary/);
    // "café" en Latin-1: 0xE9 suelto no es UTF-8 válido.
    expect(() => decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toThrow(/not valid UTF-8/);
  });
});

describe('detectEol / toCrlf', () => {
  it('elige el final de línea dominante', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
    expect(detectEol('a\nb\r\nc\n')).toBe('lf');
    expect(detectEol('sin saltos')).toBe('lf');
  });

  it('no duplica los \\r existentes', () => {
    expect(toCrlf('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });
});

describe('writeTextFileAtomic', () => {
  it('crea, sobrescribe y no deja temporales', () => {
    const p = join(dir, 'sub', 'a.txt');
    writeTextFileAtomic(p, 'uno');
    writeTextFileAtomic(p, 'dos');
    expect(readFileSync(p, 'utf-8')).toBe('dos');
    expect(readdirSync(join(dir, 'sub'))).toEqual(['a.txt']);
  });

  it('escribe el BOM cuando se pide', () => {
    const p = join(dir, 'bom.txt');
    writeTextFileAtomic(p, 'x', { bom: true });
    expect([...readFileSync(p)]).toEqual([0xef, 0xbb, 0xbf, 0x78]);
  });

  it('no escribe si el fichero cambió desde la lectura, y lo deja intacto', () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'original');
    const read = readTextFile(p);
    writeFileSync(p, 'editado por el usuario');
    expect(() => writeTextFileAtomic(p, 'del agente', { expected: read.signature })).toThrow(
      FileChangedError,
    );
    expect(readFileSync(p, 'utf-8')).toBe('editado por el usuario');
    expect(leftovers()).toEqual([]);
  });

  it('un touch sin cambiar el contenido no cuenta como cambio', () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'igual');
    const read = readTextFile(p);
    writeFileSync(p, 'igual'); // nuevo mtime, mismo contenido
    writeTextFileAtomic(p, 'nuevo', { expected: read.signature });
    expect(readFileSync(p, 'utf-8')).toBe('nuevo');
  });

  it('falla sin tocar nada si el destino es un directorio', () => {
    const p = join(dir, 'carpeta');
    mkdirSync(p);
    expect(() => writeTextFileAtomic(p, 'x')).toThrow(/not a regular file/);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('conserva los permisos del original', () => {
    const p = join(dir, 'script.sh');
    writeFileSync(p, '#!/bin/sh\n');
    chmodSync(p, 0o755);
    writeTextFileAtomic(p, '#!/bin/sh\necho hola\n');
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it('sigue un symlink: reescribe el fichero real y el enlace sigue siendo enlace', () => {
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'viejo');
    try {
      symlinkSync(real, link, 'file');
    } catch {
      return; // Windows sin modo desarrollador no permite crear symlinks.
    }
    writeTextFileAtomic(link, 'nuevo');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf-8')).toBe('nuevo');
  });

  it('con hard links escribe en sitio para que todos los nombres vean el cambio', () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'viejo');
    linkSync(a, b);
    writeTextFileAtomic(a, 'nuevo');
    expect(readFileSync(b, 'utf-8')).toBe('nuevo');
  });
});

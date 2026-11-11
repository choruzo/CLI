import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from './zip.js';
import { makeZip } from './test-helpers.js';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-zip-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const BIG = 'línea,número\n'.repeat(5000);

describe.each([
  ['deflate', 8 as const],
  ['stored', 0 as const],
])('ZipArchive (%s)', (_name, method) => {
  it('lista las entradas y lee una en streaming', async () => {
    const p = join(tmp, `a-${method}.zip`);
    writeFileSync(
      p,
      makeZip({ 'a.txt': 'hola ñandú', 'dir/b.txt': BIG }, method, { y: 2026, m: 11, d: 11 }),
    );
    const zip = await ZipArchive.open(p);
    expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(zip.newestDate()).toBe('20261111');
    expect(await zip.readText('a.txt')).toBe('hola ñandú');
    // Por nombre base y en streaming por trozos.
    const s = await zip.stream('b.txt');
    expect(s).not.toBeNull();
    let total = 0;
    for await (const chunk of s!) total += (chunk as Buffer).length;
    expect(total).toBe(Buffer.byteLength(BIG));
  });

  it('una entrada inexistente es null', async () => {
    const p = join(tmp, `b-${method}.zip`);
    writeFileSync(p, makeZip({ 'a.txt': 'x' }, method));
    const zip = await ZipArchive.open(p);
    expect(await zip.stream('nada.txt')).toBeNull();
    expect(await zip.readText('nada.txt')).toBeNull();
  });

  it('una entrada vacía se lee como cadena vacía', async () => {
    const p = join(tmp, `c-${method}.zip`);
    writeFileSync(p, makeZip({ 'vacio.txt': '' }, method));
    const zip = await ZipArchive.open(p);
    expect(await zip.readText('vacio.txt')).toBe('');
  });
});

describe('ZipArchive: errores', () => {
  it('un fichero que no es un zip falla con un mensaje claro', async () => {
    const p = join(tmp, 'no.zip');
    writeFileSync(p, 'esto no es un zip');
    await expect(ZipArchive.open(p)).rejects.toThrow(/ZIP/);
  });
});

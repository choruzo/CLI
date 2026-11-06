import { describe, expect, it } from 'vitest';
import { SYNC_BEGIN, SYNC_END, installSyncOutput, isFrameWrite } from './sync-output.js';

function fakeOut(isTTY = true) {
  const writes: unknown[] = [];
  const out = {
    isTTY,
    write: (chunk: unknown): boolean => {
      writes.push(chunk);
      return true;
    },
  };
  return { out, writes };
}

const noProc = { once: () => undefined, off: () => undefined } as unknown as Pick<
  NodeJS.Process,
  'once' | 'off'
>;

describe('isFrameWrite', () => {
  it('reconoce un fotograma que borra líneas o abarca varias', () => {
    expect(isFrameWrite('\x1b[2K\x1b[1A\x1b[2K\x1b[Gtexto')).toBe(true);
    expect(isFrameWrite('uno\ndos')).toBe(true);
  });

  it('deja las escrituras sueltas, la pantalla alternativa y lo ya sincronizado', () => {
    expect(isFrameWrite('\x1b]11;#000000\x07')).toBe(false);
    expect(isFrameWrite('\x1b[?1049h\n')).toBe(false);
    expect(isFrameWrite(`${SYNC_BEGIN}x\n${SYNC_END}`)).toBe(false);
    expect(isFrameWrite(Buffer.from('a\n'))).toBe(false);
  });
});

describe('installSyncOutput', () => {
  it('envuelve el fotograma y deja pasar lo suelto', async () => {
    const { out, writes } = fakeOut();
    installSyncOutput(out, {}, noProc);
    out.write('\x1b[2Kfoto\n');
    await Promise.resolve();
    out.write('\x1b]111\x07');
    expect(writes).toEqual([`${SYNC_BEGIN}\x1b[2Kfoto\n${SYNC_END}`, '\x1b]111\x07']);
  });

  it('fusiona las escrituras de un mismo tick en un solo bloque', async () => {
    const { out, writes } = fakeOut();
    installSyncOutput(out, {}, noProc);
    out.write('\x1b[2K\x1b[G'); // log.clear()
    out.write('estatico\n');
    out.write('\x1b[2Kregion\n');
    expect(writes).toEqual([]);
    await Promise.resolve();
    expect(writes).toEqual([`${SYNC_BEGIN}\x1b[2K\x1b[Gestatico\n\x1b[2Kregion\n${SYNC_END}`]);
  });

  it('una escritura suelta vacía antes lo pendiente (orden)', () => {
    const { out, writes } = fakeOut();
    installSyncOutput(out, {}, noProc);
    out.write('foto\n');
    out.write('\x1b]11;#000\x07');
    expect(writes).toEqual([`${SYNC_BEGIN}foto\n${SYNC_END}`, '\x1b]11;#000\x07']);
  });

  it('restaurar vacía lo pendiente y devuelve el write original', () => {
    const { out, writes } = fakeOut();
    const original = out.write;
    const restore = installSyncOutput(out, {}, noProc);
    expect(out.write).not.toBe(original);
    out.write('ultimo\n');
    restore();
    expect(out.write).toBe(original);
    expect(writes).toEqual([`${SYNC_BEGIN}ultimo\n${SYNC_END}`]);
  });

  it('no toca nada sin TTY ni con STRATUM_NO_SYNC_OUTPUT=1', () => {
    const noTty = fakeOut(false);
    const w1 = noTty.out.write;
    installSyncOutput(noTty.out, {}, noProc);
    expect(noTty.out.write).toBe(w1);

    const off = fakeOut();
    const w2 = off.out.write;
    installSyncOutput(off.out, { STRATUM_NO_SYNC_OUTPUT: '1' }, noProc);
    expect(off.out.write).toBe(w2);
  });
});

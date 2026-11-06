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
  it('envuelve el fotograma en la misma escritura', () => {
    const { out, writes } = fakeOut();
    installSyncOutput(out, {});
    out.write('\x1b[2Kfoto\n');
    out.write('\x1b]111\x07');
    expect(writes).toEqual([`${SYNC_BEGIN}\x1b[2Kfoto\n${SYNC_END}`, '\x1b]111\x07']);
  });

  it('restaurar devuelve el write original', () => {
    const { out, writes } = fakeOut();
    const original = out.write;
    const restore = installSyncOutput(out, {});
    expect(out.write).not.toBe(original);
    restore();
    expect(out.write).toBe(original);
    out.write('a\n');
    expect(writes).toEqual(['a\n']);
  });

  it('no toca nada sin TTY ni con STRATUM_NO_SYNC_OUTPUT=1', () => {
    const noTty = fakeOut(false);
    const w1 = noTty.out.write;
    installSyncOutput(noTty.out, {});
    expect(noTty.out.write).toBe(w1);

    const off = fakeOut();
    const w2 = off.out.write;
    installSyncOutput(off.out, { STRATUM_NO_SYNC_OUTPUT: '1' });
    expect(off.out.write).toBe(w2);
  });
});

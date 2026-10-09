import { describe, it, expect } from 'vitest';
import { JobOutput } from './output.js';
import { redactSecrets } from '../security/redact-output.js';

const plain = (text: string): string => text;
const redact = (text: string): string => redactSecrets(text, []).text;

describe('JobOutput', () => {
  it('lee por partes con offsets absolutos y separa stdout de stderr', () => {
    const out = new JobOutput(10_000, plain);
    out.push('stdout', 'uno\ndos\n');
    out.push('stderr', 'aviso\n');
    out.push('stdout', 'tres\n');

    const first = out.read(0, 8);
    expect(first.stdout).toBe('uno\ndos\n');
    expect(first.stderr).toBe('');
    expect(first.nextOffset).toBe(8);
    expect(first.more).toBe(true);

    const rest = out.read(first.nextOffset, 1000);
    expect(rest.stdout).toBe('tres\n');
    expect(rest.stderr).toBe('aviso\n');
    expect(rest.nextOffset).toBe(out.totalChars);
    expect(rest.more).toBe(false);
  });

  it('corta en un salto de línea cuando el límite cae a mitad de una', () => {
    const out = new JobOutput(10_000, plain);
    out.push('stdout', 'linea uno\nlinea dos\nlinea tres\n');
    const slice = out.read(0, 15);
    expect(slice.stdout).toBe('linea uno\n');
    expect(out.read(slice.nextOffset, 100).stdout).toBe('linea dos\nlinea tres\n');
  });

  it('retiene la línea a medias hasta su salto, y la entrega al cerrar', () => {
    const out = new JobOutput(10_000, plain);
    expect(out.push('stdout', 'sin salto')).toBe(false);
    expect(out.totalChars).toBe(0);
    expect(out.push('stdout', ' todavía\n')).toBe(true);
    expect(out.read(0, 100).stdout).toBe('sin salto todavía\n');

    out.push('stdout', 'cola');
    out.close();
    expect(out.read(0, 100).stdout).toBe('sin salto todavía\ncola');
  });

  it('redacta un secreto aunque llegue partido entre dos trozos del stream', () => {
    const out = new JobOutput(10_000, redact);
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    out.push('stdout', `token=${token.slice(0, 12)}`);
    out.push('stdout', `${token.slice(12)}\nfin\n`);
    const text = out.read(0, 1000).stdout;
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(12));
    expect(text).toContain('[redacted:');
    expect(text).toContain('fin');
  });

  it('retiene un bloque PEM abierto hasta que llega su cierre', () => {
    const out = new JobOutput(100_000, redact);
    out.push('stdout', 'antes\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n');
    // Lo anterior al BEGIN ya se puede leer; el bloque, todavía no.
    expect(out.read(0, 1000).stdout).toBe('antes\n');
    out.push('stdout', 'IBAAKC\n-----END RSA PRIVATE KEY-----\ndespues\n');
    const text = out.read(0, 1000).stdout;
    expect(text).not.toContain('MIIEow');
    expect(text).not.toContain('IBAAKC');
    expect(text).toContain('despues');
  });

  it('conserva la cola: pasado el límite descarta lo más antiguo y lo dice', () => {
    const out = new JobOutput(16, plain);
    for (let i = 0; i < 10; i++) out.push('stdout', `linea-${i}\n`);
    expect(out.totalChars).toBe(80);
    expect(out.droppedChars).toBe(64);
    expect(out.retainedChars).toBe(16);

    const slice = out.read(0, 1000);
    expect(slice.offset).toBe(64);
    expect(slice.droppedChars).toBe(64);
    expect(slice.stdout).toBe('linea-8\nlinea-9\n');
  });

  it('cuenta los bytes crudos de cada stream aunque no los conserve', () => {
    const out = new JobOutput(4, plain);
    out.push('stdout', Buffer.from('ñandú\n'));
    out.push('stderr', 'abc\n');
    expect(out.bytes.stdout).toBe(Buffer.byteLength('ñandú\n'));
    expect(out.bytes.stderr).toBe(4);
  });

  it('un carácter multibyte partido entre dos chunks llega entero', () => {
    const out = new JobOutput(1000, plain);
    const bytes = Buffer.from('aé\n');
    out.push('stdout', bytes.subarray(0, 2));
    out.push('stdout', bytes.subarray(2));
    expect(out.read(0, 100).stdout).toBe('aé\n');
  });

  it('tailOffset apunta al inicio de una línea cerca del final', () => {
    const out = new JobOutput(10_000, plain);
    out.push('stdout', 'aaaa\nbbbb\ncccc\n');
    const from = out.tailOffset(7);
    expect(out.read(from, 100).stdout).toBe('cccc\n');
  });

  it('release libera lo más antiguo para el límite global', () => {
    const out = new JobOutput(1000, plain);
    out.push('stdout', '0123456789\n');
    expect(out.release(5)).toBe(5);
    expect(out.read(0, 100).stdout).toBe('56789\n');
  });
});

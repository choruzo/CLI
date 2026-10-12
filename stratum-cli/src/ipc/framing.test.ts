import { describe, it, expect } from 'vitest';
import { FrameTooLargeError, LineDecoder, encodeLine } from './framing.js';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('LineDecoder', () => {
  it('devuelve líneas completas y guarda la que está a medias', () => {
    const decoder = new LineDecoder(1024);
    expect(decoder.push(bytes('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(decoder.bufferedBytes).toBe(5);
    expect(decoder.push(bytes('2}\n'))).toEqual(['{"b":2}']);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('un receptor lento no lo rompe: byte a byte da lo mismo que de golpe', () => {
    const lines = [
      encodeLine({ id: 1, method: 'core.status' }),
      encodeLine({ method: 'events', params: { text: 'señal → ✓ 日本語 🚀' } }),
      encodeLine({ id: 2, result: { ok: true } }),
    ];
    const stream = bytes(lines.join(''));
    const expected = lines.map((l) => l.trimEnd());

    const atOnce = new LineDecoder(4096).push(stream);
    expect(atOnce).toEqual(expected);

    // De uno en uno: todos los caracteres multibyte quedan partidos entre chunks.
    const slow = new LineDecoder(4096);
    const oneByOne: string[] = [];
    for (let i = 0; i < stream.length; i++) oneByOne.push(...slow.push(stream.subarray(i, i + 1)));
    expect(oneByOne).toEqual(expected);

    // Y en trozos de tamaño irregular.
    for (const size of [2, 3, 5, 7, 11, 64]) {
      const decoder = new LineDecoder(4096);
      const out: string[] = [];
      for (let i = 0; i < stream.length; i += size) {
        out.push(...decoder.push(stream.subarray(i, i + size)));
      }
      expect(out, `chunks de ${size}`).toEqual(expected);
    }
  });

  it('una trama demasiado grande se rechaza, completa o en curso', () => {
    const complete = new LineDecoder(16);
    expect(() => complete.push(bytes('x'.repeat(17) + '\n'))).toThrow(FrameTooLargeError);

    // Sin salto de línea todavía: no espera a acumularla entera para rechazarla.
    const growing = new LineDecoder(16);
    growing.push(bytes('x'.repeat(10)));
    expect(() => growing.push(bytes('x'.repeat(10)))).toThrow(FrameTooLargeError);
  });

  it('el límite es en bytes, no en caracteres', () => {
    const decoder = new LineDecoder(8);
    // 4 caracteres, 12 bytes.
    expect(() => decoder.push(bytes('日本語!\n'.slice(0, 3) + '語\n'))).toThrow(FrameTooLargeError);
  });

  it('setLimit sube el tope para las tramas siguientes', () => {
    const decoder = new LineDecoder(8);
    decoder.setLimit(64);
    expect(decoder.push(bytes('x'.repeat(40) + '\n'))).toHaveLength(1);
  });

  it('una desconexión a mitad de trama no produce ninguna línea', () => {
    const decoder = new LineDecoder(1024);
    const lines = decoder.push(bytes('{"id":1,"result":{}}\n{"id":2,"resu'));
    expect(lines).toEqual(['{"id":1,"result":{}}']);
    // Lo que quede sin terminar no es un mensaje: quien cierra lo descarta.
    expect(decoder.bufferedBytes).toBeGreaterThan(0);
  });

  it('ignora líneas en blanco y admite CRLF', () => {
    const decoder = new LineDecoder(1024);
    expect(decoder.push(bytes('\n\r\n{"a":1}\r\n  \n'))).toEqual(['{"a":1}']);
  });
});

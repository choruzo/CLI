import { describe, expect, it } from 'vitest';
import { resampleTo16k } from './resample.js';

/**
 * M25 fase 3 — el FIR de 48 a 16 kHz (`resample.ts`).
 *
 * Lo que se mide: que la banda de voz pase con la amplitud intacta, que lo que
 * se plegaría (8–24 kHz sin filtrar) quede muy por debajo, y que no aparezcan
 * `NaN` ni longitudes raras.
 */

/** Un seno de `hz` de amplitud 0.5, a 48 kHz. */
function tone(hz: number, seconds = 1, rate = 48_000): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return pcm;
}

/** RMS de `pcm` entre dos índices. */
function rms(pcm: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / (to - from));
}

/** Ganancia en dB de la señal filtrada frente a la de entrada (0.5 de pico). */
function gainDb(filtered: Float32Array): number {
  // Se saltan los bordes: ahí el filtro ve ceros y la amplitud cae.
  const edge = Math.min(2_000, Math.floor(filtered.length / 4));
  const reference = 0.5 / Math.SQRT2;
  return 20 * Math.log10(rms(filtered, edge, filtered.length - edge) / reference);
}

describe('resampleTo16k', () => {
  it('de 48 kHz: un tono de 1 kHz conserva la amplitud (±1 dB)', () => {
    expect(gainDb(resampleTo16k(tone(1_000), 48_000))).toBeCloseTo(0, 0);
    expect(Math.abs(gainDb(resampleTo16k(tone(1_000), 48_000)))).toBeLessThan(1);
    // También en el extremo alto de la banda de voz.
    expect(Math.abs(gainDb(resampleTo16k(tone(3_000), 48_000)))).toBeLessThan(1);
  });

  it('de 48 kHz: un tono de 10 kHz queda atenuado más de 40 dB', () => {
    // Sin el filtro caería en 6 kHz al diezmar por 3: es el `aliasing` que evita.
    expect(gainDb(resampleTo16k(tone(10_000), 48_000))).toBeLessThan(-40);
  });

  it('la longitud es floor(n/3)', () => {
    for (const n of [1, 2, 3, 4, 4_799, 4_800, 48_001]) {
      expect(resampleTo16k(new Float32Array(n), 48_000)).toHaveLength(Math.floor(n / 3));
    }
  });

  it('no devuelve NaN', () => {
    const out = resampleTo16k(tone(440, 0.25), 48_000);
    expect(out.some((v) => !Number.isFinite(v))).toBe(false);
  });

  it('de 16 kHz devuelve una copia, no el mismo buffer', () => {
    const input = tone(1_000, 0.1, 16_000);
    const out = resampleTo16k(input, 16_000);
    expect(out).toHaveLength(input.length);
    expect(out).not.toBe(input);
    out[0] = 1;
    expect(input[0]).not.toBe(1);
  });

  it('cualquier otra frecuencia lanza', () => {
    expect(() => resampleTo16k(new Float32Array(10), 44_100)).toThrow(/solo de 48000 o 16000/);
    expect(() => resampleTo16k(new Float32Array(10), 8_000)).toThrow();
  });
});

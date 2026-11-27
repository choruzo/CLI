/**
 * Tests del troceador: los 8 de la fase 1 (`chunk.test.mjs`) más los casos que
 * pedía el encargo de la fase 2 (silencio en los extremos, voz breve, fondo
 * continuo, el máximo en muestras con otra frecuencia y el filtro de casi mudo).
 */
import { describe, expect, it } from 'vitest';
import { chunk, isNearSilent, NEAR_SILENT_DBFS } from './chunk.js';

const SR = 16_000;

/** Tono + silencio, en muestras. */
function tone(sec: number, freq = 220, amp = 0.3): Float32Array {
  const n = Math.round(sec * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}
const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR));

const concat = (...parts: Float32Array[]): Float32Array => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Ruido determinista con semilla. */
function noise(sec: number, seed = 7, amp = 0.2): Float32Array {
  const n = Math.round(sec * SR);
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/** Comprueba que las ventanas cubren todo el audio sin huecos ni solapes. */
function assertCoverage(chunks: Array<{ start: number; end: number }>, total: number): void {
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(total);
  for (let i = 0; i < chunks.length; i++) {
    expect(chunks[i]!.end).toBeGreaterThan(chunks[i]!.start);
    if (i) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
  }
}

const rmsAround = (x: Float32Array, at: number, half: number): number => {
  const a = Math.max(0, at - half);
  const b = Math.min(x.length, at + half);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};

describe('chunk (portado de la fase 1)', () => {
  it('tonos con silencios: corta dentro de los silencios', () => {
    const x = concat(tone(10), silence(1.2), tone(10), silence(1.2), tone(10));
    const chunks = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 12 });
    assertCoverage(chunks, x.length);

    const full = rmsAround(x, 5 * SR, 480); // dentro del primer tono
    for (const c of chunks.slice(0, -1)) {
      const e = rmsAround(x, c.end, 480);
      expect(e, `el corte en ${(c.end / SR).toFixed(2)} s cae sobre señal`).toBeLessThan(full / 5);
      expect(c.reason).toBe('silence');
    }
    expect(chunks.length).toBe(3);
    expect(Math.abs(chunks[0]!.end / SR - 10.6)).toBeLessThan(0.15);
    expect(Math.abs(chunks[1]!.end / SR - 21.8)).toBeLessThan(0.15);
    expect(chunks.at(-1)!.reason).toBe('end');
  });

  it('ruido sin silencios: cortes duros en maxSec', () => {
    const x = noise(20);
    const chunks = chunk(x, { sampleRate: SR, targetSec: 5, maxSec: 6 });
    assertCoverage(chunks, x.length);
    const maxN = Math.round(6 * SR);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(maxN + 480);
    // sin silencios reales el corte es exactamente maxSec (no se encontró silencio)
    expect(chunks.slice(0, 3).map((c) => c.end)).toEqual([6 * SR, 12 * SR, 18 * SR]);
    expect(chunks.slice(0, 3).map((c) => c.reason)).toEqual(['forced', 'forced', 'forced']);
    expect(chunks.length).toBe(4); // el resto (2 s) va como último trozo
  });

  it('audio más corto que la ventana: un solo trozo', () => {
    const x = tone(3);
    const chunks = chunk(x, { sampleRate: SR, targetSec: 25, maxSec: 30 });
    expect(chunks).toEqual([{ start: 0, end: x.length, reason: 'end' }]);
  });

  it('audio vacío: sin trozos', () => {
    expect(chunk(new Float32Array(0), {})).toEqual([]);
  });

  it('puro y determinista: no muta la entrada y repite resultado', () => {
    const x = concat(tone(10), silence(1.2), tone(10), silence(1.2), tone(10));
    const copy = Float32Array.from(x);
    const a = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 12 });
    const b = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 12 });
    expect(a).toEqual(b);
    expect(x).toEqual(copy);
  });

  it('un silencio más corto que minSilenceMs no sirve de corte', () => {
    // 10 s de tono, 100 ms de silencio, 10 s de tono, 1,2 s de silencio, 10 s de tono.
    // Con minSilenceMs = 400 el hueco de 100 ms se descarta y el corte cae en el de 1,2 s (o, si no
    // hubiera ninguno, en el corte duro de maxSec).
    const x = concat(tone(10), silence(0.1), tone(10), silence(1.2), tone(10));
    const chunks = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 12, minSilenceMs: 400 });
    assertCoverage(chunks, x.length);
    expect(chunks.slice(0, -1).some((c) => Math.abs(c.end / SR - 10.05) < 0.5)).toBe(false);
    // Con el hueco de 100 ms ignorado, el único silencio válido de la primera ventana está fuera de
    // [8, 12] s, así que el primer corte es duro en 12 s.
    expect(Math.abs(chunks[0]!.end / SR - 12)).toBeLessThan(0.05);
    expect(chunks[0]!.reason).toBe('forced');
  });

  it('la cola corta se pega al trozo anterior cuando cabe', () => {
    // 10 + 1,2 + 10 + 1,2 + 4 s: la cola de 4,6 s cabe en maxSec junto al trozo anterior (15,8 s)
    const x = concat(tone(10), silence(1.2), tone(10), silence(1.2), tone(4));
    const chunks = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 16 });
    assertCoverage(chunks, x.length);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(16 * SR);
    expect(chunks.length).toBe(2);
    // Al pegarse la cola, el trozo acaba en el final del audio: el motivo es `end`.
    expect(chunks.at(-1)!.reason).toBe('end');
  });

  it('todas las ventanas caben en maxSec con params del banco', () => {
    const x = concat(
      ...Array.from({ length: 8 }, () => [tone(6, 200), silence(0.9)]).flat(),
      tone(6),
    );
    for (const targetSec of [15, 25, 30]) {
      const chunks = chunk(x, { sampleRate: SR, targetSec, maxSec: 30 });
      assertCoverage(chunks, x.length);
      for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(30 * SR + 480);
    }
  });
});

describe('chunk (fase 2: silencio en los extremos y fondo continuo)', () => {
  it('silencio al principio y al final: los cortes caen dentro', () => {
    // Medio segundo mudo, tres tonos de 10 s con 1,2 s de pausa, medio segundo mudo.
    const x = concat(
      silence(0.5),
      tone(10),
      silence(1.2),
      tone(10),
      silence(1.2),
      tone(10),
      silence(0.5),
    );
    const chunks = chunk(x, { sampleRate: SR, targetSec: 8, maxSec: 12 });
    assertCoverage(chunks, x.length);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(x.length);
    for (const c of chunks.slice(0, -1)) {
      const at = rmsAround(x, c.end, 480);
      const voice = rmsAround(x, c.start + 3 * SR, 480);
      expect(at, `corte en ${(c.end / SR).toFixed(2)} s sobre señal`).toBeLessThan(voice / 5);
    }
  });

  it('voz breve dentro de un silencio largo: un solo trozo y se ve qué es voz', () => {
    const x = concat(silence(20), tone(2), silence(20));
    const chunks = chunk(x, { sampleRate: SR, targetSec: 25, maxSec: 30 });
    // La primera ventana [25, 30] s no tiene silencio: corte duro; el resto acaba al final.
    expect(chunks[0]!.reason).toBe('forced');
    expect(chunks.at(-1)!.end).toBe(x.length);
    // El trozo que contiene la voz no es casi mudo; el silencio del principio sí.
    const quiet = chunks[0]!;
    expect(isNearSilent(x, quiet.start, quiet.start + 20 * SR)).toBe(true);
    expect(isNearSilent(x, 19 * SR, 23 * SR)).toBe(false);
  });

  it('fondo continuo sin pausas: todo son cortes forzados', () => {
    // Un zumbido constante con voz encima: no hay valles que sirvan de silencio.
    const bed = noise(40, 3, 0.05);
    const voice = concat(tone(10, 300), tone(10, 320), tone(10, 340), tone(10, 360));
    const x = new Float32Array(40 * SR);
    for (let i = 0; i < x.length; i++) x[i] = bed[i]! + (voice[i] ?? 0);
    const chunks = chunk(x, { sampleRate: SR, targetSec: 25, maxSec: 30 });
    assertCoverage(chunks, x.length);
    for (const c of chunks.slice(0, -1)) expect(c.reason).toBe('forced');
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(30 * SR);
  });
});

describe('chunk (el máximo se comprueba en muestras)', () => {
  it('con 22 050 muestras/s ningún trozo pasa de round(maxSec * sampleRate)', () => {
    const sr = 22_050;
    const n = 40 * sr;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
    const maxSamples = Math.round(30 * sr);
    const chunks = chunk(x, { sampleRate: sr, targetSec: 25, maxSec: 30 });
    expect(chunks.at(-1)!.end).toBe(n);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(maxSamples);
  });

  it('también con 8 000 muestras/s y una trama que no divide la ventana', () => {
    const sr = 8_000;
    const n = 25 * sr;
    const x = new Float32Array(n).fill(0.1);
    const chunks = chunk(x, { sampleRate: sr, targetSec: 5, maxSec: 7.5 });
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(Math.round(7.5 * sr));
  });
});

describe('chunk (opciones inválidas)', () => {
  it('targetSec mayor que maxSec se rechaza', () => {
    expect(() => chunk(tone(1), { targetSec: 31, maxSec: 30 })).toThrow(/maxSec/);
  });

  it('valores no finitos o no positivos se rechazan', () => {
    expect(() => chunk(tone(1), { targetSec: Number.NaN })).toThrow(/finito/);
    expect(() => chunk(tone(1), { maxSec: Number.POSITIVE_INFINITY })).toThrow(/finito/);
    expect(() => chunk(tone(1), { sampleRate: 0 })).toThrow(/sampleRate/);
    expect(() => chunk(tone(1), { targetSec: 0 })).toThrow(/targetSec/);
    expect(() => chunk(tone(1), { maxSec: -1 })).toThrow(/maxSec/);
    expect(() => chunk(tone(1), { frameMs: 0 })).toThrow(/frameMs/);
    expect(() => chunk(tone(1), { smoothFrames: 0 })).toThrow(/smoothFrames/);
    expect(() => chunk(tone(1), { minSilenceMs: -1 })).toThrow(/minSilenceMs/);
    expect(() => chunk(tone(1), { tailSearchSec: -0.1 })).toThrow(/tailSearchSec/);
  });
});

describe('isNearSilent (filtro de trozos casi mudos)', () => {
  it('el umbral, medido en la fase 2, está a −58 dBFS', () => {
    expect(NEAR_SILENT_DBFS).toBe(-58);
  });

  it('la voz más baja medida (−52 dBFS) no es casi muda; −60 dBFS sí', () => {
    // Un seno de RMS r tiene amplitud r·√2.
    const atDbfs = (db: number): Float32Array => tone(2, 220, 10 ** (db / 20) * Math.SQRT2);
    const low = atDbfs(-52.3);
    expect(isNearSilent(low, 0, low.length)).toBe(false);
    const hiss = atDbfs(-60);
    expect(isNearSilent(hiss, 0, hiss.length)).toBe(true);
  });

  it('un silencio digital (RMS 0) es casi mudo', () => {
    const x = silence(2);
    expect(isNearSilent(x, 0, x.length)).toBe(true);
  });

  it('un tono a nivel de voz no lo es', () => {
    const x = tone(2);
    expect(isNearSilent(x, 0, x.length)).toBe(false);
  });

  it('voz baja (−37 dBFS) tampoco: no se tira la voz de la persona', () => {
    // Amplitud 0.02 → RMS ≈ 0.014 → unos −37 dBFS, por encima del umbral.
    const x = tone(2, 220, 0.02);
    expect(isNearSilent(x, 0, x.length)).toBe(false);
  });

  it('un fondo muy bajo (−70 dBFS) sí lo es', () => {
    const x = noise(2, 11, 0.0005);
    expect(isNearSilent(x, 0, x.length)).toBe(true);
  });

  it('basta una trama con señal para que el trozo no sea mudo', () => {
    const x = concat(silence(5), tone(0.1), silence(5));
    expect(isNearSilent(x, 0, x.length)).toBe(false);
    expect(isNearSilent(x, 0, Math.round(4.9 * SR))).toBe(true);
    expect(isNearSilent(x, Math.round(5.2 * SR), x.length)).toBe(true);
  });

  it('un rango vacío o al revés es mudo; el umbral se puede cambiar', () => {
    const x = tone(1);
    expect(isNearSilent(x, 100, 100)).toBe(true);
    expect(isNearSilent(x, 900, 100)).toBe(true);
    expect(isNearSilent(tone(1, 220, 0.02), 0, x.length, { thresholdDbfs: -20 })).toBe(true);
    expect(() => isNearSilent(x, 0, x.length, { thresholdDbfs: Number.NaN })).toThrow();
  });
});

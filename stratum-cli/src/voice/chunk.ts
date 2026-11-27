/**
 * M25 (voz) — troceo de audio por energía, sin ningún modelo. Función pura y
 * determinista. Porto de la fase 1 (`chunk.mjs`, medido): **el algoritmo y sus
 * valores por defecto no cambian**, solo se le añade a cada trozo el motivo del
 * corte y se comprueba el máximo en muestras.
 *
 * Idea: se mide la energía (RMS) por tramas de ~30 ms, se suaviza, y se busca el
 * silencio más largo dentro de la ventana de búsqueda de cada corte. Se corta por
 * el centro de ese silencio. Si no hay silencio, corte duro en `maxSec`.
 *
 * Por qué trocear: una nota entera pierde un 86,8 % de palabras (fase 1). Con
 * ventanas de 25 s y corte forzado a los 30 s baja al 2,48 % limpio, y de paso la
 * memoria se queda en ~450 MB en vez de 5 GB.
 */

/** Por qué se cortó un trozo donde se cortó. */
export type ChunkReason =
  /** El centro de un silencio. */
  | 'silence'
  /** Corte duro en `maxSec`: no había un silencio válido en la ventana. */
  | 'forced'
  /** Se acabó el audio: este trozo llega hasta el final. */
  | 'end';

/** Un trozo continúo de audio. `start`/`end` son índices en muestras, `end` exclusivo. */
export interface AudioChunk {
  start: number;
  end: number;
  reason: ChunkReason;
}

export interface ChunkOptions {
  sampleRate?: number;
  targetSec?: number;
  maxSec?: number;
  frameMs?: number;
  smoothFrames?: number;
  minSilenceMs?: number;
  tailSearchSec?: number;
  mergeTail?: boolean;
}

const DEFAULTS = {
  sampleRate: 16_000,
  targetSec: 25, // dónde se quiere cortar
  maxSec: 30, // nunca más largo que esto
  frameMs: 30, // trama de energía
  smoothFrames: 5, // suavizado de la energía (~150 ms)
  minSilenceMs: 150, // un silencio más corto no vale como punto de corte
  tailSearchSec: 0.2, // margen del corte duro cuando targetSec == maxSec
  mergeTail: true, // el resto final se pega al trozo anterior si cabe
} as const;

interface ResolvedChunkOptions {
  sampleRate: number;
  targetSec: number;
  maxSec: number;
  frameMs: number;
  smoothFrames: number;
  minSilenceMs: number;
  tailSearchSec: number;
  mergeTail: boolean;
}

/** Valida las opciones del troceador. Un valor imposible no se corrige: se lanza. */
function resolveOptions(opts: ChunkOptions): ResolvedChunkOptions {
  const o: ResolvedChunkOptions = { ...DEFAULTS, ...opts };
  const finite = (name: string, value: number): number => {
    if (!Number.isFinite(value)) throw new Error(`chunk: ${name} tiene que ser un número finito`);
    return value;
  };
  finite('sampleRate', o.sampleRate);
  finite('targetSec', o.targetSec);
  finite('maxSec', o.maxSec);
  finite('frameMs', o.frameMs);
  finite('minSilenceMs', o.minSilenceMs);
  finite('tailSearchSec', o.tailSearchSec);
  finite('smoothFrames', o.smoothFrames);
  if (!(o.sampleRate > 0)) throw new Error('chunk: sampleRate > 0');
  if (!(o.maxSec > 0)) throw new Error('chunk: maxSec > 0');
  if (!(o.targetSec > 0)) throw new Error('chunk: targetSec > 0');
  if (o.targetSec > o.maxSec) throw new Error('chunk: targetSec no puede pasar de maxSec');
  if (!(o.frameMs > 0)) throw new Error('chunk: frameMs > 0');
  if (!(o.smoothFrames >= 1)) throw new Error('chunk: smoothFrames >= 1');
  if (o.minSilenceMs < 0) throw new Error('chunk: minSilenceMs >= 0');
  if (o.tailSearchSec < 0) throw new Error('chunk: tailSearchSec >= 0');
  return o;
}

/** Energía RMS por trama. */
function frameEnergy(x: Float32Array, frameLen: number): Float64Array {
  const n = Math.ceil(x.length / frameLen);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * frameLen;
    const b = Math.min(x.length, a + frameLen);
    let s = 0;
    for (let i = a; i < b; i++) s += x[i]! * x[i]!;
    out[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  return out;
}

/** Media móvil centrada. */
function smooth(e: Float64Array, k: number): Float64Array {
  if (k <= 1) return Float64Array.from(e);
  const h = Math.floor(k / 2);
  const out = new Float64Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(e.length - 1, i + h); j++) {
      s += e[j]!;
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

/** Percentil de un array (0..1) sobre una copia ordenada. */
function pct(e: Float64Array, p: number): number {
  if (e.length === 0) return 0;
  const s = Float64Array.from(e).sort();
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i]!;
}

/**
 * Trocea en ventanas que cubren todo el audio, sin huecos ni solapes.
 *
 * @returns índices en muestras (`end` exclusivo) con el motivo de cada corte.
 */
export function chunk(samples: Float32Array, opts: ChunkOptions = {}): AudioChunk[] {
  const o = resolveOptions(opts);
  const { sampleRate, targetSec, maxSec, frameMs, smoothFrames, minSilenceMs } = o;
  const len = samples.length;
  if (len === 0) return [];
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const nFrames = Math.ceil(len / frameLen);
  const sampleAt = (f: number): number => Math.min(len, f * frameLen);

  const e = smooth(frameEnergy(samples, frameLen), smoothFrames);

  // Umbral relativo a la propia señal. Tres referencias:
  //  - `loud` (percentil 95): el nivel de voz; el umbral nunca pasa de la mitad, para que en una
  //    señal sin pausas (ruido) no se declare «silencio» en mitad de la voz;
  //  - `floor` (percentil 10): el suelo de la señal (las pausas, o el fondo si casi no hay pausas);
  //    2,5× por encima para no cortar en un valle de la propia voz;
  //  - `loud * 0.1` (−20 dB): suelo mínimo del umbral cuando `floor` es casi cero.
  const floor = pct(e, 0.1);
  const loud = pct(e, 0.95);
  const thr = Math.min(loud * 0.5, Math.max(floor * 2.5, loud * 0.1));

  // Tramos de silencio (tramas consecutivas por debajo del umbral).
  const isSil = new Uint8Array(nFrames);
  for (let f = 0; f < nFrames; f++) isSil[f] = e[f]! <= thr ? 1 : 0;
  const runs: Array<{ from: number; to: number }> = [];
  for (let f = 0; f < nFrames; ) {
    if (!isSil[f]) {
      f++;
      continue;
    }
    let g = f;
    while (g + 1 < nFrames && isSil[g + 1]) g++;
    runs.push({ from: f, to: g });
    f = g + 1;
  }
  const minRunFrames = Math.max(1, Math.round(minSilenceMs / frameMs));
  const good = runs.filter((r) => r.to - r.from + 1 >= minRunFrames);

  const targetFrames = (targetSec * 1000) / frameMs;
  // El máximo se comprueba **en muestras**, no en tramas: con una `frameMs` que
  // no divida la ventana (22 050 muestras/s, por ejemplo), `floor(maxSec/frameMs)`
  // tramas se pasaban del máximo por unas pocas muestras.
  const maxSamples = Math.round(maxSec * sampleRate);
  const maxFrames = Math.max(
    1,
    Math.min(Math.floor((maxSec * 1000) / frameMs), Math.floor(maxSamples / frameLen)),
  );
  // Ventana de búsqueda: de targetSec a maxSec. Si targetSec == maxSec, se permite retroceder un
  // poco (tailSearchSec) para no cortar en mitad de una palabra.
  let searchFrom = Math.min(targetFrames, maxFrames);
  let searchTo = maxFrames;
  if (searchTo - searchFrom < 1) {
    searchFrom = Math.max(0, searchTo - Math.round((o.tailSearchSec * 1000) / frameMs) - 1);
  }

  const out: AudioChunk[] = [];
  let startFrame = 0;
  while (startFrame < nFrames) {
    const lo = startFrame + searchFrom;
    const hi = startFrame + searchTo;
    if (lo >= nFrames) {
      // queda menos audio que targetSec: cierra aquí
      out.push({ start: sampleAt(startFrame), end: len, reason: 'end' });
      break;
    }
    // Mejor silencio cuyo centro cae en [lo, hi]
    let best: { c: number; score: [number, number] } | null = null;
    for (const r of good) {
      const c = (r.from + r.to) / 2;
      if (c < lo || c > hi) continue;
      const score: [number, number] = [r.to - r.from + 1, -e[Math.round(c)]!];
      if (
        !best ||
        score[0] > best.score[0] ||
        (score[0] === best.score[0] && score[1] > best.score[1]) ||
        (score[0] === best.score[0] &&
          score[1] === best.score[1] &&
          Math.abs(c - lo) < Math.abs(best.c - lo))
      ) {
        best = { c, score };
      }
    }
    // Corte duro: ni un silencio largo, ni uno corto, en la ventana.
    let cutFrame = best ? Math.round(best.c) : startFrame + searchTo;
    if (cutFrame <= startFrame) cutFrame = startFrame + Math.max(1, searchTo);
    if (cutFrame >= nFrames) {
      out.push({ start: sampleAt(startFrame), end: len, reason: 'end' });
      break;
    }
    out.push({
      start: sampleAt(startFrame),
      end: sampleAt(cutFrame),
      reason: best ? 'silence' : 'forced',
    });
    startFrame = cutFrame;
  }

  // El último trozo, si queda corto, se pega al anterior cuando cabe en maxSec.
  if (o.mergeTail && out.length >= 2) {
    const last = out[out.length - 1]!;
    const prev = out[out.length - 2]!;
    const joined = last.end - prev.start;
    if (joined <= maxSec * sampleRate) {
      prev.end = last.end;
      prev.reason = last.reason;
      out.pop();
    }
  }

  // Invariante del diseño: ninguna ventana pasa del máximo en muestras.
  for (const c of out) {
    if (c.end - c.start > maxSamples) {
      throw new Error(
        `chunk: trozo de ${c.end - c.start} muestras, más que el máximo ${maxSamples}`,
      );
    }
  }
  return out;
}

/**
 * Umbral de «casi mudo», en dBFS de RMS.
 *
 * **Provisional**: es el punto de partida de la fase 2 y se medirá después, con
 * voz baja de verdad, para no tirar voz de la persona. No lo ajustes a ojo.
 */
export const NEAR_SILENT_DBFS = -50;

/**
 * ¿Es casi mudo el trozo `[start, end)`? Sí cuando **ninguna** trama de ~30 ms
 * llega a `thresholdDbfs` de RMS. Un trozo casi mudo no se manda al decoder:
 * inventa texto (fase 1: un 17,1 % de error en un control con silencio añadido).
 *
 * Las tramas son de 30 ms a 16 kHz (480 muestras), la frecuencia del audio que
 * se transcribe.
 */
export function isNearSilent(
  samples: Float32Array,
  start: number,
  end: number,
  opts: { thresholdDbfs?: number; frameMs?: number; sampleRate?: number } = {},
): boolean {
  const threshold = opts.thresholdDbfs ?? NEAR_SILENT_DBFS;
  const frameMs = opts.frameMs ?? 30;
  const sampleRate = opts.sampleRate ?? 16_000;
  if (!Number.isFinite(threshold)) throw new Error('isNearSilent: thresholdDbfs no es un número');
  const from = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const to = Math.max(from, Math.min(samples.length, Math.floor(end)));
  if (to === from) return true;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  for (let a = from; a < to; a += frameLen) {
    const b = Math.min(to, a + frameLen);
    let s = 0;
    for (let i = a; i < b; i++) s += samples[i]! * samples[i]!;
    const rms = Math.sqrt(s / Math.max(1, b - a));
    // RMS 0 es -∞ dBFS: por debajo de cualquier umbral, así que «no supera».
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    if (dbfs > threshold) return false;
  }
  return true;
}

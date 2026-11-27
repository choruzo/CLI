/**
 * M25 fase 3 — de la frecuencia de una nota de voz a la del modelo (16 kHz).
 *
 * **Puro**: sin Node, sin E/S. Opus decodifica siempre a 48 kHz, así que el
 * único cambio real es 48 000 → 16 000, que es un tercio exacto.
 *
 * Bajar de 48 a 16 kHz sin filtrar es *aliasing* puro: todo lo que haya entre 8
 * y 24 kHz se pliega dentro de la banda de voz. Por eso va un FIR paso bajo de
 * fase lineal (sinc enventanado con Blackman, 63 coeficientes, corte ~7,2 kHz) y
 * **después** se toma una de cada tres muestras. La ventana de Blackman deja el
 * lóbulo lateral a unos −74 dB, así que un tono de 10 kHz (que sin filtrar
 * caería en 6 kHz) queda por debajo de −80 dB.
 *
 * El filtro va centrado en la muestra que se conserva (`3m`), así que la salida
 * no lleva retardo de grupo: la muestra `m` es el instante `3m` de la entrada.
 */

/** Frecuencia del PCM que entra al modelo (`transcribe.ts`). */
export const TARGET_SAMPLE_RATE = 16_000;

/** Frecuencia de lo que decodifica Opus (`ogg-opus-decoder`). */
export const OPUS_SAMPLE_RATE = 48_000;

/** Coeficientes del FIR. Impar, para que su centro caiga en una muestra. */
const TAPS = 63;

/** Corte del paso bajo, en Hz. Por debajo del Nyquist de 16 kHz (8 kHz). */
const CUTOFF_HZ = 7_200;

/** Los coeficientes del FIR, calculados una vez. */
const COEFFICIENTS: Float64Array = designLowPass();

/**
 * FIR paso bajo de fase lineal: sinc truncado y enventanado con Blackman,
 * normalizado para que la ganancia en continua sea exactamente 1.
 */
function designLowPass(): Float64Array {
  const half = (TAPS - 1) / 2;
  const fc = CUTOFF_HZ / OPUS_SAMPLE_RATE; // ciclos por muestra, 0..0.5
  const h = new Float64Array(TAPS);
  let sum = 0;
  for (let k = 0; k < TAPS; k++) {
    const t = k - half;
    // sinc(2·fc·t) = sin(2·π·fc·t) / (π·t), con el límite 2·fc en t = 0.
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * k) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * k) / (TAPS - 1));
    h[k] = sinc * w;
    sum += h[k]!;
  }
  for (let k = 0; k < TAPS; k++) h[k] = h[k]! / sum;
  return h;
}

/**
 * Pasa un PCM mono a 16 kHz.
 *
 * Con 48 000 filtra y diezma por 3; con 16 000 devuelve una copia (no el mismo
 * buffer: quien llama puede soltarlo sin tocar el de nadie). Cualquier otra
 * frecuencia lanza: es un fallo de programación, no un caso del runtime.
 */
export function resampleTo16k(pcm: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_SAMPLE_RATE) return new Float32Array(pcm);
  if (fromRate !== OPUS_SAMPLE_RATE) {
    throw new Error(
      `resampleTo16k: no se resamplea de ${fromRate} Hz; solo de ${OPUS_SAMPLE_RATE} o ${TARGET_SAMPLE_RATE}`,
    );
  }
  const factor = OPUS_SAMPLE_RATE / TARGET_SAMPLE_RATE; // 3
  const half = (TAPS - 1) / 2;
  const outLength = Math.floor(pcm.length / factor);
  const out = new Float32Array(outLength);
  for (let m = 0; m < outLength; m++) {
    const center = m * factor;
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const index = center - half + k;
      if (index < 0 || index >= pcm.length) continue; // bordes: los ceros de fuera
      acc += COEFFICIENTS[k]! * pcm[index]!;
    }
    out[m] = acc;
  }
  return out;
}

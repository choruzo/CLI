/**
 * M25 (voz) — Canary-1B-v2 con `onnxruntime-node`: preprocesador `nemo128` →
 * encoder → decoder AED voraz con caché KV (`decoder_mems`).
 *
 * Portado de la fase 1 (`canary.mjs`), que dio los WER medidos. **Solo lo usa el
 * worker** (`worker.ts`), que es quien carga `onnxruntime-node` con
 * `importOptional()` y quien recibe el módulo ya importado: aquí no se importa
 * nada nativo.
 *
 * Dos trampas ya resueltas que no deben volver:
 * - **nunca DirectML** (el encoder falla en el `Reshape` `node_view_189`, y con
 *   otro `device_id` ONNX Runtime cae a la CPU sin avisar);
 * - **nunca `preferredOutputLocation: 'gpu-buffer'`**: dejaba el proceso colgado.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/** Tope de tokens de salida por segundo de audio de cada trozo: corta los bucles. */
export const TOKENS_PER_SECOND_CAP = 12;

/** Techo absoluto de tokens de salida, prefijo incluido. */
export const MAX_TOTAL_TOKENS = 1024;

/** Frecuencia del audio que entra: la del modelo. */
export const CANARY_SAMPLE_RATE = 16_000;

/**
 * RTF (preprocesador + encoder ÷ duración) de la **sonda** por encima del cual
 * la GPU **no** se da por confirmada.
 *
 * Medido el 2026-11-27 (fase 2, RTX 5060 Ti): el primer `encoder.run` tras
 * cargar cuesta 0,5-0,7 s fijos sea cual sea el trozo, así que medir el primer
 * trozo real no sirve (con 2-5 s, la GPU salía como CPU). En caliente, con 15 s,
 * la GPU da 0,0076 libre y hasta 0,0137 con otro proceso WebGPU compitiendo; la
 * CPU, 0,085 o más. **Provisional**: la sonda en sí está pendiente de validar en
 * otros equipos y con un fallback silencioso reproducible.
 */
export const GPU_CONFIRM_MAX_ENCODER_RTF = 0.03;

/** Duración de la sonda de la GPU: con 15 s se separan GPU y CPU (con 2-5 s, no). */
export const GPU_PROBE_SECONDS = 15;

/**
 * La sonda: 15 s de ruido leve y determinista (siempre el mismo), para que el
 * coste no dependa de la nota. Solo pasa por el preprocesador y el encoder.
 */
function probeSignal(): Float32Array {
  const samples = new Float32Array(GPU_PROBE_SECONDS * CANARY_SAMPLE_RATE);
  let state = 0x2545f491;
  for (let i = 0; i < samples.length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples[i] = (state / 0xffff_ffff - 0.5) * 0.02;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Lo mínimo de `onnxruntime-node` que se usa (el paquete es opcional y no trae
// tipos: lo carga el worker con `importOptional()`).
// ---------------------------------------------------------------------------

export interface OrtTensor {
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
}

export interface OrtRunResult {
  [name: string]: OrtTensor;
}

export interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<OrtRunResult>;
  inputMetadata?: ReadonlyArray<{ name: string; shape: readonly number[] }>;
  release?(): Promise<void> | void;
}

export interface OrtModule {
  Tensor: new (
    type: 'float32' | 'int64',
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => unknown;
  InferenceSession: {
    create(path: string, options?: { executionProviders?: string[] }): Promise<OrtSession>;
  };
}

/** Lo que devuelve un troceado transcrito. */
export interface CanaryTranscription {
  text: string;
  encMs: number;
  decMs: number;
  /** Tokens de salida, sin contar el prefijo. */
  outputTokens: number;
  /** Se llegó al tope de tokens: el texto puede estar cortado. */
  capped: boolean;
}

export type VoiceDeviceChoice = 'auto' | 'gpu' | 'cpu';
export type VoiceDeviceInUse = 'gpu' | 'cpu';
/**
 * Lo que se sabe del dispositivo: `gpu` solo si la sonda lo confirmó;
 * `unconfirmed` si las sesiones son de WebGPU pero la sonda salió lenta (puede
 * que ONNX Runtime cayera a la CPU sin avisar, o que la GPU estuviera ocupada).
 */
export type VoiceDeviceStatus = 'gpu' | 'cpu' | 'unconfirmed';

/**
 * Tope de tokens de salida de **un trozo**, sin contar el prefijo: 12 por
 * segundo de audio, hacia arriba. El techo absoluto (`MAX_TOTAL_TOKENS`) se
 * aplica fuera, sumando el prefijo.
 */
export function outputTokenCap(samples: number, sampleRate: number): number {
  const seconds = samples / sampleRate;
  return Math.ceil(seconds * TOKENS_PER_SECOND_CAP);
}

export interface CanaryEngine {
  /** El dispositivo, ya decidido al cargar con la sonda (nunca `gpu` sin confirmarlo). */
  readonly device: VoiceDeviceStatus;
  /** El dispositivo con el que se crearon las sesiones al cargar. */
  readonly loadedDevice: VoiceDeviceInUse;
  /** RTF de la segunda pasada de la sonda; `undefined` si no hubo sonda (CPU). */
  readonly probeRtf?: number;
  /** Por qué no se usa lo que se pidió, si hubo que cambiar. */
  readonly warning?: string;
  readonly loadMs: number;
  /** El paso a la CPU falló a medias: no sirve para nada más y hay que tirar el proceso. */
  readonly broken?: boolean;
  transcribe(pcm16k: Float32Array, opts: { language: string }): Promise<CanaryTranscription>;
  release(): Promise<void>;
}

export interface LoadCanaryEngineOptions {
  dir: string;
  device?: VoiceDeviceChoice;
  ort: OrtModule;
  /** Milisegundos de reloj monotónico (los tests lo pasan falso). */
  now?: () => number;
}

const DEFAULT_NOW = (): number => performance.now();

/**
 * Carga el motor. Con `auto` se intenta WebGPU y, si crear la sesión lanza, se
 * usa la CPU con un `warning`. Con `gpu` no hay reserva: si no se puede, lanza.
 */
export async function loadCanaryEngine(opts: LoadCanaryEngineOptions): Promise<CanaryEngine> {
  const { ort, dir } = opts;
  const wanted = opts.device ?? 'auto';
  const now = opts.now ?? DEFAULT_NOW;
  const started = now();

  const pre = await ort.InferenceSession.create(join(dir, 'nemo128.onnx'));
  let enc: OrtSession | undefined;
  let dec: OrtSession | undefined;
  /** Con qué se crearon las sesiones (con WebGPU, aún sin confirmar). */
  let created: VoiceDeviceInUse = 'cpu';
  let warning: string | undefined;

  const createPair = async (executionProvider: string): Promise<void> => {
    enc = await ort.InferenceSession.create(join(dir, 'encoder-model.onnx'), {
      executionProviders: [executionProvider],
    });
    dec = await ort.InferenceSession.create(join(dir, 'decoder-model.onnx'), {
      executionProviders: [executionProvider],
    });
  };

  if (wanted === 'cpu') {
    await createPair('cpu');
    created = 'cpu';
  } else if (wanted === 'gpu') {
    // Sin reserva: si la GPU no va, se dice en vez de transcribir lento sin avisar.
    await createPair('webgpu');
    created = 'gpu';
  } else {
    try {
      await createPair('webgpu');
      created = 'gpu';
    } catch (err) {
      await releaseQuietly(enc);
      await releaseQuietly(dec);
      await createPair('cpu');
      created = 'cpu';
      warning = `no se pudo usar la GPU (${errorMessage(err)}); se transcribe en la CPU`;
    }
  }
  if (!enc || !dec) throw new Error('canary: faltan las sesiones del encoder o del decoder');

  // Sonda de la GPU, al cargar: una pasada de calentamiento (compila los
  // kernels) y otra medida, sobre la misma señal fija y sin decoder. Así la GPU
  // se confirma antes de la primera nota, tenga uno o varios trozos.
  let device: VoiceDeviceStatus = created;
  let probeRtf: number | undefined;
  if (created === 'gpu') {
    const probe = probeSignal();
    const runProbe = async (): Promise<number> => {
      const t0 = now();
      const out = await pre.run({
        waveforms: new ort.Tensor('float32', probe, [1, probe.length]),
        waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(probe.length)]), [1]),
      });
      await enc!.run({ audio_signal: out.features, length: out.features_lens });
      return now() - t0;
    };
    try {
      await runProbe();
      probeRtf = (await runProbe()) / (GPU_PROBE_SECONDS * 1000);
    } catch (err) {
      // WebGPU creó las sesiones pero no corre: con `auto`, a la CPU; con
      // `gpu`, se dice.
      if (wanted !== 'auto') throw err;
      await releaseQuietly(enc);
      await releaseQuietly(dec);
      enc = undefined;
      dec = undefined;
      await createPair('cpu');
      created = 'cpu';
      device = 'cpu';
      warning = `la GPU ha fallado en la sonda (${errorMessage(err)}); se transcribe en la CPU`;
    }
    if (probeRtf !== undefined) {
      if (probeRtf <= GPU_CONFIRM_MAX_ENCODER_RTF) {
        device = 'gpu';
      } else {
        device = 'unconfirmed';
        warning =
          `la GPU no se ha confirmado (RTF de la sonda ${probeRtf.toFixed(4)} > ` +
          `${GPU_CONFIRM_MAX_ENCODER_RTF}); puede estar corriendo en la CPU`;
      }
    }
  }
  if (!enc || !dec) throw new Error('canary: faltan las sesiones del encoder o del decoder');

  const loadMs = now() - started;
  const vocab = readVocab(join(dir, 'vocab.txt'));
  const idOf = (token: string): number => {
    const index = vocab.indexOf(token);
    if (index < 0) throw new Error(`canary: falta el token "${token}" en vocab.txt`);
    return index;
  };
  const EOS = idOf('<|endoftext|>');
  const memoryMeta = dec.inputMetadata?.find((meta) => meta.name === 'decoder_mems')?.shape;
  const memoryLayers = memoryMeta?.[0];
  const memoryHidden = memoryMeta?.[3];
  if (memoryLayers === undefined || memoryHidden === undefined) {
    throw new Error('canary: el decoder no declara la forma de "decoder_mems"');
  }

  const prefixFor = (language: string): number[] => [
    idOf('▁'),
    idOf('<|startofcontext|>'),
    idOf('<|startoftranscript|>'),
    idOf('<|emo:undefined|>'),
    idOf(`<|${language}|>`),
    idOf(`<|${language}|>`),
    idOf('<|pnc|>'),
    idOf('<|noitn|>'),
    idOf('<|notimestamp|>'),
    idOf('<|nodiarize|>'),
  ];

  let confirmed: VoiceDeviceStatus = device;
  let runtimeWarning = warning;
  /** Ya se cayó a la CPU en tiempo de ejecución: no se reintenta. */
  let fellBack = false;
  /** El paso a la CPU falló a medias: el motor no sirve y el worker debe tirarse. */
  let broken = false;

  /** Un trozo: preprocesador → encoder → decoder voraz. */
  const runChunk = async (pcm16k: Float32Array, language: string): Promise<CanaryTranscription> => {
    const t0 = now();
    const preOut = await pre.run({
      waveforms: new ort.Tensor('float32', pcm16k, [1, pcm16k.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(pcm16k.length)]), [1]),
    });
    const encOut = await enc!.run({
      audio_signal: preOut.features,
      length: preOut.features_lens,
    });
    const tEnc = now();

    const tokens = prefixFor(language);
    const prefix = tokens.length;
    const cap = Math.min(
      MAX_TOTAL_TOKENS,
      prefix + outputTokenCap(pcm16k.length, CANARY_SAMPLE_RATE),
    );
    let mems = new ort.Tensor('float32', new Float32Array(0), [memoryLayers, 1, 0, memoryHidden]);
    let capped = false;
    for (;;) {
      if (tokens.length >= cap) {
        capped = true;
        break;
      }
      const first = (mems as OrtTensor).dims[2] === 0;
      const ids = first ? tokens : [tokens[tokens.length - 1]!];
      const out = await dec!.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        encoder_embeddings: encOut.encoder_embeddings,
        encoder_mask: encOut.encoder_mask,
        decoder_mems: mems,
      });
      const logits = out.logits!;
      const dims = logits.dims;
      const steps = dims[1]!;
      const vocabSize = dims[2]!;
      const offset = (steps - 1) * vocabSize;
      const values = logits.data as Float32Array;
      let best = 0;
      for (let k = 1; k < vocabSize; k++) {
        if (values[offset + k]! > values[offset + best]!) best = k;
      }
      mems = out.decoder_hidden_states as unknown as OrtTensor;
      if (best === EOS) break;
      tokens.push(best);
    }
    const text = tokens
      .slice(prefix)
      .map((token) => vocab[token])
      .filter((token): token is string => token !== undefined && !/^<\|.*\|>$/.test(token))
      .join('')
      .replaceAll('▁', ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const t1 = now();
    return {
      text,
      encMs: tEnc - t0,
      decMs: t1 - tEnc,
      outputTokens: tokens.length - prefix,
      capped,
    };
  };

  return {
    get device() {
      return confirmed;
    },
    get warning() {
      return runtimeWarning;
    },
    get loadedDevice() {
      return created;
    },
    ...(probeRtf !== undefined ? { probeRtf } : {}),
    loadMs,

    async transcribe(pcm16k, { language }) {
      if (broken) throw new Error('canary: el motor quedó inservible al pasar a la CPU');
      if (created !== 'gpu' || fellBack) return runChunk(pcm16k, language);
      try {
        return await runChunk(pcm16k, language);
      } catch (err) {
        // Crear la sesión en WebGPU no prueba que la GPU corra: si una ejecución
        // revienta (en cualquier trozo), se cambia a CPU y se repite ese trozo una
        // vez. Con `gpu` explícito no hay reserva: el fallo se propaga.
        if (wanted !== 'auto') throw err;
        await releaseQuietly(dec);
        await releaseQuietly(enc);
        dec = undefined;
        enc = undefined;
        // El par de CPU se publica solo entero: si falla a medias, se suelta lo
        // creado y el motor queda inservible (el worker lo tira y el siguiente
        // arranque empieza de cero).
        let cpuEnc: OrtSession | undefined;
        try {
          cpuEnc = await ort.InferenceSession.create(join(dir, 'encoder-model.onnx'), {
            executionProviders: ['cpu'],
          });
          const cpuDec = await ort.InferenceSession.create(join(dir, 'decoder-model.onnx'), {
            executionProviders: ['cpu'],
          });
          enc = cpuEnc;
          dec = cpuDec;
        } catch (cpuErr) {
          await releaseQuietly(cpuEnc);
          broken = true;
          throw new Error(
            `canary: la GPU falló (${errorMessage(err)}) y no se pudo pasar a la CPU ` +
              `(${errorMessage(cpuErr)})`,
          );
        }
        fellBack = true;
        created = 'cpu';
        confirmed = 'cpu';
        runtimeWarning = `la GPU ha fallado al ejecutar (${errorMessage(err)}); se transcribe en la CPU`;
        return runChunk(pcm16k, language);
      }
    },

    get broken() {
      return broken;
    },

    async release() {
      await releaseQuietly(dec);
      await releaseQuietly(enc);
      await releaseQuietly(pre);
    },
  };
}

async function releaseQuietly(session: OrtSession | undefined): Promise<void> {
  try {
    await session?.release?.();
  } catch {
    // Soltar la memoria de un motor que ya no se usa no es un fallo del turno.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `vocab.txt`: una línea `token id` (el token puede llevar espacios). */
function readVocab(file: string): string[] {
  const vocab: string[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const index = line.lastIndexOf(' ');
    // Una línea sin id (o vacía) no es un token: se ignora en vez de romper la carga.
    if (index > 0) vocab[Number(line.slice(index + 1))] = line.slice(0, index);
  }
  return vocab;
}

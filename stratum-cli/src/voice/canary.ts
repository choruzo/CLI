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
 * RTF del encoder por encima del cual la GPU **no** se da por buena.
 *
 * **Provisional**: es un punto de partida para detectar la caída silenciosa a la
 * CPU de ONNX Runtime (en la RTX 5060 Ti medida, el RTF del encoder con WebGPU
 * era de 0,083-0,088 y en CPU 0,32-0,41). Se afina cuando se mida la memoria y
 * la repetibilidad con el dispositivo real confirmado.
 */
export const GPU_CONFIRM_MAX_ENCODER_RTF = 0.1;

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
 * Tope de tokens de salida de **un trozo**, sin contar el prefijo: 12 por
 * segundo de audio, hacia arriba. El techo absoluto (`MAX_TOTAL_TOKENS`) se
 * aplica fuera, sumando el prefijo.
 */
export function outputTokenCap(samples: number, sampleRate: number): number {
  const seconds = samples / sampleRate;
  return Math.ceil(seconds * TOKENS_PER_SECOND_CAP);
}

export interface CanaryEngine {
  /** El dispositivo **confirmado** (nunca `gpu` sin comprobarlo). */
  readonly device: VoiceDeviceInUse;
  /**
   * El dispositivo con el que se crearon las sesiones al cargar. Con WebGPU es
   * `gpu` y todavía **no** significa confirmado: es lo que el worker anuncia
   * como `gpu-unconfirmed` en el `ready`.
   */
  readonly loadedDevice: VoiceDeviceInUse;
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

  let confirmed: VoiceDeviceInUse = created;
  let runtimeWarning = warning;
  let gpuChecked = false;
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

    // ONNX Runtime puede caer a la CPU sin avisar: la GPU no se da por buena
    // hasta que el primer encoder la confirma. El tiempo medido es el mismo que
    // se informa como `encMs` (preprocesador + encoder), que es con el que se
    // midieron los RTF de referencia en la fase 1.
    if (confirmed === 'gpu' && !gpuChecked) {
      gpuChecked = true;
      const audioMs = (pcm16k.length / CANARY_SAMPLE_RATE) * 1000;
      const rtf = audioMs > 0 ? (tEnc - t0) / audioMs : Number.POSITIVE_INFINITY;
      if (rtf > GPU_CONFIRM_MAX_ENCODER_RTF) {
        // Solo cambia la etiqueta: el resultado ya calculado es correcto y las
        // sesiones no se recrean.
        confirmed = 'cpu';
        runtimeWarning =
          `la GPU no se ha confirmado (RTF del encoder ${rtf.toFixed(3)} > ` +
          `${GPU_CONFIRM_MAX_ENCODER_RTF}); se informa cpu`;
      }
    }

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
    loadedDevice: created,
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
        gpuChecked = true;
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

/**
 * Tests de las piezas puras de `canary.ts`. El motor en sí necesita
 * `onnxruntime-node` y el modelo de 4 GB: eso se comprueba con el modelo real,
 * no aquí.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CANARY_SAMPLE_RATE,
  loadCanaryEngine,
  MAX_TOTAL_TOKENS,
  type OrtModule,
  type OrtSession,
  outputTokenCap,
  TOKENS_PER_SECOND_CAP,
} from './canary.js';

const SR = CANARY_SAMPLE_RATE;

describe('outputTokenCap', () => {
  it('da 12 tokens por segundo de audio, hacia arriba', () => {
    expect(TOKENS_PER_SECOND_CAP).toBe(12);
    expect(outputTokenCap(SR, SR)).toBe(12);
    expect(outputTokenCap(25 * SR, SR)).toBe(300);
    // Menos de un token sigue pidiendo uno: un trozo nunca se queda sin salida.
    expect(outputTokenCap(0.01 * SR, SR)).toBe(1);
    expect(outputTokenCap(SR / 2, SR)).toBe(6);
  });

  it('el prefijo no entra aquí, y el techo total nunca pasa de 1024', () => {
    // El tope por trozo no lleva prefijo; el techo se aplica fuera, sumándolo.
    const prefix = 10;
    const applied = (samples: number): number =>
      Math.min(MAX_TOTAL_TOKENS, prefix + outputTokenCap(samples, SR));
    expect(MAX_TOTAL_TOKENS).toBe(1024);
    expect(applied(300 * SR)).toBe(1024);
    expect(applied(1000 * SR)).toBe(1024);
    // Por debajo del techo, el prefijo sí se suma.
    expect(applied(1 * SR)).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// El paso a la CPU, con un `onnxruntime-node` falso (sin modelo de verdad)
// ---------------------------------------------------------------------------

const VOCAB = [
  '▁',
  '<|startofcontext|>',
  '<|startoftranscript|>',
  '<|emo:undefined|>',
  '<|es|>',
  '<|pnc|>',
  '<|noitn|>',
  '<|notimestamp|>',
  '<|nodiarize|>',
  '<|endoftext|>',
  '▁hola',
];
const EOS = VOCAB.indexOf('<|endoftext|>');
const HOLA = VOCAB.indexOf('▁hola');

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

interface FakeOrtControl {
  /** Lanza en la N-ésima ejecución (desde 1) del encoder en WebGPU. */
  failGpuEncoderRun?: number;
  /** Lanza al crear el decoder en CPU. */
  failCpuDecoderCreate?: boolean;
  created: string[];
  released: string[];
}

function fakeOrt(control: FakeOrtControl): OrtModule {
  let gpuEncoderRuns = 0;
  return {
    Tensor: FakeTensor as unknown as OrtModule['Tensor'],
    InferenceSession: {
      async create(path: string, options?: { executionProviders?: string[] }) {
        const name = path.split(/[\\/]/).pop()!;
        const ep = options?.executionProviders?.[0] ?? 'cpu';
        if (name === 'decoder-model.onnx' && ep === 'cpu' && control.failCpuDecoderCreate) {
          throw new Error('sin memoria para el decoder');
        }
        const id = `${name}@${ep}`;
        control.created.push(id);
        const session: OrtSession = {
          inputMetadata:
            name === 'decoder-model.onnx' ? [{ name: 'decoder_mems', shape: [2, 1, 0, 4] }] : [],
          release: () => {
            control.released.push(id);
          },
          async run(feeds: Record<string, unknown>) {
            if (name === 'nemo128.onnx') {
              return {
                features: new FakeTensor('float32', new Float32Array(4), [1, 128, 1]),
                features_lens: new FakeTensor('int64', BigInt64Array.from([1n]), [1]),
              } as never;
            }
            if (name === 'encoder-model.onnx') {
              if (ep === 'webgpu') {
                gpuEncoderRuns++;
                if (gpuEncoderRuns === control.failGpuEncoderRun) {
                  throw new Error('WebGPU: dispositivo perdido');
                }
              }
              return {
                encoder_embeddings: new FakeTensor('float32', new Float32Array(4), [1, 1, 4]),
                encoder_mask: new FakeTensor('int64', BigInt64Array.from([1n]), [1, 1]),
              } as never;
            }
            const mems = feeds.decoder_mems as FakeTensor;
            const best = mems.dims[2] === 0 ? HOLA : EOS;
            const logits = new Float32Array(VOCAB.length);
            logits[best] = 1;
            return {
              logits: new FakeTensor('float32', logits, [1, 1, VOCAB.length]),
              decoder_hidden_states: new FakeTensor('float32', new Float32Array(8), [2, 1, 1, 4]),
            } as never;
          },
        };
        return session;
      },
    },
  };
}

describe('paso a la CPU cuando WebGPU falla al ejecutar', () => {
  let modelDir: string;
  beforeEach(() => {
    modelDir = mkdtempSync(join(tmpdir(), 'stratum-canary-'));
    writeFileSync(
      join(modelDir, 'vocab.txt'),
      VOCAB.map((token, index) => `${token} ${index}`).join('\n'),
    );
  });
  afterEach(() => rmSync(modelDir, { recursive: true, force: true }));

  const pcm = new Float32Array(SR);
  // Reloj quieto: el RTF del encoder sale 0 y la GPU queda confirmada.
  const now = (): number => 1_000;

  it('con auto, un fallo en un trozo **posterior** también pasa a la CPU y repite ese trozo', async () => {
    const control: FakeOrtControl = { failGpuEncoderRun: 2, created: [], released: [] };
    const engine = await loadCanaryEngine({
      dir: modelDir,
      device: 'auto',
      ort: fakeOrt(control),
      now,
    });
    expect(engine.loadedDevice).toBe('gpu');

    const first = await engine.transcribe(pcm, { language: 'es' });
    expect(first.text).toBe('hola');
    expect(engine.device).toBe('gpu');

    const second = await engine.transcribe(pcm, { language: 'es' });
    expect(second.text).toBe('hola');
    expect(engine.device).toBe('cpu');
    expect(engine.warning).toMatch(/GPU ha fallado/);
    // Las sesiones de WebGPU se sueltan antes de crear las de CPU.
    expect(control.released).toEqual(
      expect.arrayContaining(['encoder-model.onnx@webgpu', 'decoder-model.onnx@webgpu']),
    );
    expect(control.created).toEqual(
      expect.arrayContaining(['encoder-model.onnx@cpu', 'decoder-model.onnx@cpu']),
    );
    // Y ya no vuelve a intentarlo en la GPU.
    await engine.transcribe(pcm, { language: 'es' });
    expect(control.created.filter((id) => id.endsWith('@webgpu'))).toHaveLength(2);
  });

  it('si el par de CPU no se puede crear entero, el motor queda inservible', async () => {
    const control: FakeOrtControl = {
      failGpuEncoderRun: 1,
      failCpuDecoderCreate: true,
      created: [],
      released: [],
    };
    const engine = await loadCanaryEngine({
      dir: modelDir,
      device: 'auto',
      ort: fakeOrt(control),
      now,
    });
    await expect(engine.transcribe(pcm, { language: 'es' })).rejects.toThrow(
      /no se pudo pasar a la CPU/,
    );
    expect(engine.broken).toBe(true);
    // El encoder de CPU que sí se creó se suelta: no queda un par a medias.
    expect(control.released).toContain('encoder-model.onnx@cpu');
    await expect(engine.transcribe(pcm, { language: 'es' })).rejects.toThrow(/inservible/);
  });

  it('con gpu explícito, el fallo se propaga sin pasar a la CPU', async () => {
    const control: FakeOrtControl = { failGpuEncoderRun: 1, created: [], released: [] };
    const engine = await loadCanaryEngine({
      dir: modelDir,
      device: 'gpu',
      ort: fakeOrt(control),
      now,
    });
    await expect(engine.transcribe(pcm, { language: 'es' })).rejects.toThrow(/dispositivo perdido/);
    expect(control.created.some((id) => id.endsWith('@cpu') && !id.startsWith('nemo128'))).toBe(
      false,
    );
  });
});

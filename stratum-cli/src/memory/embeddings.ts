import { homedir } from 'os';
import { join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { resolveMemoryPaths } from '../config/paths.js';

/**
 * Función de bajo nivel que convierte textos en vectores. Inyectable en tests
 * para no depender del modelo ONNX real ni de la red.
 */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbeddingServiceOptions {
  /** Override del backend de embeddings (tests). Si se pasa, no se usa HTTP ni ONNX. */
  embedFn?: EmbedFn;
}

/** Normaliza L2 un vector in-place y lo devuelve (coseno == producto punto). */
function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/**
 * EmbeddingService — Capa 3 (§12.10).
 *
 * Estrategia provider-agnostic:
 *   1. Endpoint HTTP OpenAI-compatible (`memory.embeddingEndpoint`) si está
 *      configurado, con fast-fail y un latch de proceso que evita re-probar un
 *      endpoint caído en cada llamada.
 *   2. Fallback a `@xenova/transformers` (ONNX local, lazy load, cache en
 *      ~/.stratum/models). Importado dinámicamente para que el paquete no sea
 *      obligatorio si solo se usa el endpoint HTTP.
 *
 * Todos los vectores se devuelven normalizados L2. `embed()` nunca lanza por
 * fallo de backend: si ningún backend está disponible devuelve `null` y el
 * resto del sistema degrada a memoria sin índice semántico.
 */
export class EmbeddingService {
  private readonly model: string;
  private readonly endpoint?: { url: string; model: string; apiKey: string };
  private readonly modelsDir: string;
  private readonly injected?: EmbedFn;

  /** Latch de proceso: si el endpoint HTTP falla una vez, no se reintenta. */
  private httpDown = false;
  /** Pipeline ONNX (cargado de forma diferida). */
  private pipelinePromise: Promise<unknown> | null = null;
  private _dimension: number | null = null;
  private warned = false;

  constructor(config: StratumConfig, opts?: EmbeddingServiceOptions) {
    this.model = config.memory.embeddingModel;
    this.endpoint = config.memory.embeddingEndpoint;
    this.modelsDir = resolveMemoryPaths(config).modelsDir;
    this.injected = opts?.embedFn;
    this._dimension = config.memory.embeddingDimension ?? null;
  }

  get dimension(): number | null {
    return this._dimension;
  }

  /** Embebe un único texto. Devuelve null si no hay backend disponible. */
  async embedOne(text: string): Promise<Float32Array | null> {
    const out = await this.embed([text]);
    return out ? (out[0] ?? null) : null;
  }

  /**
   * Embebe una lista de textos. Devuelve un array de vectores normalizados o
   * `null` si ningún backend pudo generar embeddings (degradación silenciosa).
   */
  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];

    if (this.injected) {
      const vecs = await this.injected(texts);
      const normd = vecs.map((v) => normalize(Float32Array.from(v)));
      if (normd[0]) this._dimension = normd[0].length;
      return normd;
    }

    // 1) Endpoint HTTP OpenAI-compatible
    if (this.endpoint && !this.httpDown) {
      try {
        const vecs = await this.embedHttp(texts, this.endpoint);
        if (vecs[0]) this._dimension = vecs[0].length;
        return vecs;
      } catch (err) {
        this.httpDown = true;
        this.warn(`endpoint HTTP de embeddings no disponible (${String(err)}); usando ONNX local`);
      }
    }

    // 2) ONNX local (@xenova/transformers)
    try {
      const vecs = await this.embedLocal(texts);
      if (vecs[0]) this._dimension = vecs[0].length;
      return vecs;
    } catch (err) {
      this.warn(`embeddings locales no disponibles (${String(err)}); memoria semántica desactivada`);
      return null;
    }
  }

  /** Precarga el modelo ONNX (warm-up opcional, §12.10). No lanza. */
  async warmup(): Promise<void> {
    if (this.injected || this.endpoint) return;
    try {
      await this.embedLocal(['warm-up']);
    } catch {
      /* degradación silenciosa */
    }
  }

  // ---------------------------------------------------------------------------
  // Backends
  // ---------------------------------------------------------------------------

  private async embedHttp(
    texts: string[],
    endpoint: { url: string; model: string; apiKey: string },
  ): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    // Batching en chunks de 64 para no enviar requests gigantes.
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const resp = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({ input: batch, model: endpoint.model || this.model }),
        // Fast-fail: un endpoint caído cae al fallback local en ~3s, no ~30s.
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
      const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const row of rows) out.push(normalize(Float32Array.from(row.embedding)));
    }
    return out;
  }

  private async embedLocal(texts: string[]): Promise<Float32Array[]> {
    const pipe = (await this.getPipeline()) as (
      input: string | string[],
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ dims: number[]; data: Float32Array }>;

    const out: Float32Array[] = [];
    for (const text of texts) {
      const result = await pipe(text, { pooling: 'mean', normalize: true });
      // El tensor ya viene normalizado por el pipeline, pero re-normalizamos por
      // seguridad para garantizar coseno == dot en todos los backends.
      out.push(normalize(Float32Array.from(result.data)));
    }
    return out;
  }

  private async getPipeline(): Promise<unknown> {
    if (this.pipelinePromise) return this.pipelinePromise;

    // Windows: HuggingFace cachea el modelo ONNX como symlinks; en rutas
    // de red/UNC Windows no los sigue (WinError 1463) y el modelo falla a
    // cargar sin re-descargar. Desactivar symlinks evita el problema. Debe
    // fijarse ANTES de importar @xenova/transformers.
    if (process.platform === 'win32') {
      process.env.HF_HUB_DISABLE_SYMLINKS ??= '1';
      process.env.HF_HUB_DISABLE_SYMLINKS_WARNING ??= '1';
    }

    const p = (async () => {
      // Import dinámico: @xenova/transformers es opcional. Si no está instalado
      // el throw se propaga a embed() que degrada a memoria sin índice.
      const mod = (await import(
        /* @vite-ignore */ '@xenova/transformers' as string
      )) as {
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
        env: { cacheDir?: string; localModelPath?: string };
      };
      if (mod.env) mod.env.cacheDir = this.modelsDir || join(homedir(), '.stratum', 'models');
      return mod.pipeline('feature-extraction', this.model, {
        cache_dir: this.modelsDir || join(homedir(), '.stratum', 'models'),
      });
    })();

    // Si la carga falla (modelo no descargable, dep ausente), NO dejar cacheada
    // una promesa rechazada: limpiarla para que un próximo intento reintente.
    this.pipelinePromise = p;
    p.catch(() => {
      if (this.pipelinePromise === p) this.pipelinePromise = null;
    });
    return p;
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[memory] ${msg}\n`);
  }
}

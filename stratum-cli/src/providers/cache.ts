/**
 * Prompt caching: lo que un backend reporta y lo que admite. Sin imports a
 * propósito — la traza (`trace/`) y el webview de Desktop leen estos tipos.
 *
 * Dos reglas que no se rompen:
 *  - **nunca se estima**: un campo que el backend no reporta queda `undefined`.
 *    «0 tokens de caché» y «no lo sé» son respuestas distintas;
 *  - Stratum no cachea respuestas: aquí solo se mide (y se facilita) la caché
 *    de prefijo del propio backend.
 */

/** Uso de tokens de una llamada, en la forma común a todos los backends. */
export interface TokenUsage {
  /** Tokens de entrada **totales**, incluidos los servidos de caché. */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Tokens de entrada que el backend sirvió de su caché de prefijo. */
  cachedReadTokens?: number;
  /** Tokens de entrada que esta llamada escribió en caché (Anthropic). */
  cacheWriteTokens?: number;
}

/** `TokenUsage` con lo que se deriva de él. Todo `undefined` si falta el dato de caché. */
export interface CacheUsage extends TokenUsage {
  /** `promptTokens − cachedReadTokens`: lo que el backend tuvo que procesar. */
  uncachedPromptTokens?: number;
  /** `cachedReadTokens / promptTokens`, en [0, 1]. */
  cacheHitRate?: number;
}

/**
 * `usage` tal como llega en el stream. Además del formato OpenAI, los campos
 * con que otros backends reportan la caché a través de una API compatible.
 */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenAI, vLLM (`--enable-prompt-tokens-details`), llama.cpp reciente, LiteLLM. */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  /** Anthropic (nativo, o a través de LiteLLM / OpenRouter). */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Anthropic nativo: entrada **sin** contar lo cacheado. */
  input_tokens?: number;
  output_tokens?: number;
  /** DeepSeek. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** `timings` de llama.cpp: `cache_n` son los tokens del prompt reutilizados del KV cache. */
export interface RawTimings {
  cache_n?: number;
  prompt_n?: number;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * Normaliza el `usage` de un backend. Solo lee lo que viene: si ninguna de las
 * formas conocidas trae el dato de caché, `cachedReadTokens` queda `undefined`.
 */
export function normalizeUsage(
  raw: RawUsage | null | undefined,
  timings?: RawTimings | null,
): TokenUsage | undefined {
  if (!raw && !timings) return undefined;
  const u = raw ?? {};

  const cachedRead =
    count(u.prompt_tokens_details?.cached_tokens) ??
    count(u.cache_read_input_tokens) ??
    count(u.prompt_cache_hit_tokens) ??
    count(timings?.cache_n);
  const cacheWrite =
    count(u.cache_creation_input_tokens) ?? count(u.prompt_tokens_details?.cache_write_tokens);

  let prompt = count(u.prompt_tokens);
  if (prompt === undefined) {
    const input = count(u.input_tokens);
    // Anthropic nativo: `input_tokens` no incluye lo leído ni lo escrito en caché.
    if (input !== undefined) prompt = input + (cachedRead ?? 0) + (cacheWrite ?? 0);
  } else if (cachedRead !== undefined && cachedRead > prompt) {
    // Una pasarela que deja `prompt_tokens` sin lo cacheado: el total es la suma.
    prompt = prompt + cachedRead + (cacheWrite ?? 0);
  }
  if (prompt === undefined && timings) {
    const evaluated = count(timings.prompt_n);
    const reused = count(timings.cache_n);
    if (evaluated !== undefined && reused !== undefined) prompt = evaluated + reused;
  }

  const completion = count(u.completion_tokens) ?? count(u.output_tokens);
  const out: TokenUsage = {};
  if (prompt !== undefined) out.promptTokens = prompt;
  if (completion !== undefined) out.completionTokens = completion;
  const total =
    count(u.total_tokens) ??
    (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  if (total !== undefined) out.totalTokens = total;
  if (cachedRead !== undefined) out.cachedReadTokens = cachedRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Añade los derivados. Sin `cachedReadTokens` o sin `promptTokens` no hay ninguno. */
export function withCacheDerived(usage: TokenUsage): CacheUsage {
  const { promptTokens: prompt, cachedReadTokens: cached } = usage;
  if (prompt === undefined || cached === undefined) return { ...usage };
  const read = Math.min(cached, prompt);
  return {
    ...usage,
    uncachedPromptTokens: prompt - read,
    ...(prompt > 0 ? { cacheHitRate: read / prompt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capacidades por provider
// ---------------------------------------------------------------------------

/**
 * Lo que un provider admite en cuanto a caché de prompt. «OpenAI-compatible» no
 * implica ninguna: cada una se activa por backend conocido o por config
 * (`provider.providers.<alias>.cache`).
 */
export interface CacheCapabilities {
  /** Reporta en `usage` cuánto del prompt salió de caché. Solo informativo: se lee siempre. */
  usage: boolean;
  /** Reutiliza solo el prefijo común con una petición anterior (KV cache, caché automática). */
  automaticPrefix: boolean;
  /** Admite marcas `cache_control` en el contenido (Anthropic vía pasarela). */
  explicitBreakpoints: boolean;
  /** Admite `prompt_cache_key` para enrutar a la misma caché (OpenAI). */
  cacheKey: boolean;
  /** Admite asociar la petición a una sesión del servidor con `session_id` (SGLang). */
  sessionAffinity: boolean;
}

export type CacheBackendKind =
  | 'ollama'
  | 'vllm'
  | 'llamacpp'
  | 'litellm'
  | 'openai'
  | 'sglang'
  | 'unknown';

const NONE: CacheCapabilities = {
  usage: false,
  automaticPrefix: false,
  explicitBreakpoints: false,
  cacheKey: false,
  sessionAffinity: false,
};

/**
 * Lo que se asume de cada backend sin que la config diga nada. Conservador: lo
 * que cambia la petición (`cacheKey`, `explicitBreakpoints`, `sessionAffinity`)
 * solo está activo donde se sabe que el backend lo acepta — un campo de más
 * hace que algunos servidores rechacen la petición con un 400.
 */
export const DEFAULT_CACHE_CAPABILITIES: Record<CacheBackendKind, CacheCapabilities> = {
  openai: { ...NONE, usage: true, automaticPrefix: true, cacheKey: true },
  // KV cache por slot; `cached_tokens` / `timings.cache_n` según la versión.
  llamacpp: { ...NONE, usage: true, automaticPrefix: true },
  // Prefix caching automático; `cached_tokens` solo con `--enable-prompt-tokens-details`.
  vllm: { ...NONE, usage: true, automaticPrefix: true },
  // Reutiliza el KV cache, pero su API compatible no reporta cuánto.
  ollama: { ...NONE, automaticPrefix: true },
  // Radix cache automática; `session_id` es opt-in por config.
  sglang: { ...NONE, usage: true, automaticPrefix: true },
  // Depende del modelo que haya detrás: se lee lo que venga, no se asume nada.
  litellm: { ...NONE, usage: true },
  unknown: { ...NONE, usage: true },
};

export function resolveCacheCapabilities(
  backend: CacheBackendKind,
  overrides?: Partial<CacheCapabilities> | null,
): CacheCapabilities {
  const out = { ...DEFAULT_CACHE_CAPABILITIES[backend] };
  if (!overrides) return out;
  for (const key of Object.keys(out) as Array<keyof CacheCapabilities>) {
    const value = overrides[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

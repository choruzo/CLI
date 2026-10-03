/**
 * Utilidades de providers (Hito 3.5): descubrimiento de modelos vía
 * endpoint OpenAI-compatible `GET {baseUrl}/models`.
 */

interface ModelsResponse {
  data?: Array<Record<string, unknown>>;
}

/** Un modelo tal como lo anuncia `GET /models`. */
export interface ModelInfo {
  id: string;
  /** Ventana de contexto, si el backend la declara (la mayoría solo da el id). */
  contextWindow?: number;
}

/**
 * Campos donde los backends OpenAI-compatibles declaran la ventana: OpenRouter
 * (`context_length`), Groq (`context_window`), vLLM (`max_model_len`), LM Studio
 * (`max_context_length`). El `meta.n_ctx_train` de llama.cpp se ignora a
 * propósito: es el contexto de entrenamiento, no el `-c` con que corre el server.
 */
const CONTEXT_WINDOW_FIELDS = [
  'context_length',
  'context_window',
  'max_model_len',
  'max_context_length',
];

function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  for (const field of CONTEXT_WINDOW_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Ventanas descubiertas en este proceso, por `baseUrl` normalizada. A nivel de
 * módulo porque cada subagente tiene su propio `ProviderRouter` y no debe
 * repetir la petición ni caer al default que el padre ya superó.
 */
const discoveredWindows = new Map<string, Map<string, number>>();

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/, '');

/** Ventana que `/models` declaró para `model`, si ya se consultó ese provider. */
export function discoveredContextWindow(baseUrl: string, model: string): number | undefined {
  return discoveredWindows.get(normalizeBaseUrl(baseUrl))?.get(model);
}

/** Solo para tests. */
export function clearDiscoveredModels(): void {
  discoveredWindows.clear();
}

export interface FetchModelsOptions {
  /** Timeout en ms. Default: 5000 (§Hito 3.5). */
  timeoutMs?: number;
  /** Inyectable para tests. Default: globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Obtiene la lista de modelos disponibles en un provider OpenAI-compatible.
 *
 * @param baseUrl URL base incluyendo el prefijo de la API (ej. `http://localhost:11434/v1`)
 * @param apiKey  API key; se envía como `Authorization: Bearer` solo si no está vacía
 * @throws si la request falla, expira (5s) o la respuesta no tiene el shape esperado.
 *         El caller decide el fallback (entrada manual en el wizard).
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<string[]> {
  return (await fetchModelInfos(baseUrl, apiKey, opts)).map((m) => m.id);
}

/**
 * Como `fetchModels`, con los metadatos que el backend declare. Recuerda las
 * ventanas descubiertas (`discoveredContextWindow`).
 */
export async function fetchModelInfos(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<ModelInfo[]> {
  const { timeoutMs = 5000, fetchFn = fetch } = opts;
  const url = `${normalizeBaseUrl(baseUrl)}/models`;

  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${response.status}`);
  }

  const body = (await response.json()) as ModelsResponse;
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${url} → respuesta sin campo "data" (no es OpenAI-compatible)`);
  }

  const byId = new Map<string, ModelInfo>();
  for (const entry of body.data) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0 || byId.has(id)) continue;
    const contextWindow = contextWindowOf(entry);
    byId.set(id, contextWindow ? { id, contextWindow } : { id });
  }
  const infos = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  const windows = new Map<string, number>();
  for (const info of infos) {
    if (info.contextWindow) windows.set(info.id, info.contextWindow);
  }
  discoveredWindows.set(normalizeBaseUrl(baseUrl), windows);

  return infos;
}

// ---------------------------------------------------------------------------
// Detección de capacidades del backend (Hito 6)
// ---------------------------------------------------------------------------

/**
 * Tipo de backend OpenAI-compatible inferido. `unknown` cuando no se puede
 * clasificar con confianza. La detección es best-effort y solo sirve para
 * adaptar la UI (mensajes de ayuda), nunca para cambiar la ruta de la API:
 * Stratum siempre habla OpenAI-compatible.
 */
export type BackendKind = 'ollama' | 'vllm' | 'llamacpp' | 'litellm' | 'openai' | 'unknown';

export interface ProviderCapabilities {
  /** Backend inferido por heurística sobre la URL y la respuesta de `/models`. */
  backend: BackendKind;
  /** El endpoint `/models` respondió con el shape OpenAI-compatible esperado. */
  listsModels: boolean;
  /** Modelos descubiertos (vacío si `listsModels` es false). */
  models: string[];
  /** Mensaje legible cuando `/models` no está disponible (para mostrar en UI). */
  note?: string;
}

/**
 * Clasifica el backend a partir de la URL base. Heurística por puerto/host
 * habituales; solo orienta los mensajes de la UI.
 */
export function classifyBackendByUrl(baseUrl: string): BackendKind {
  const u = baseUrl.toLowerCase();
  if (u.includes('11434')) return 'ollama';
  if (u.includes('/ollama') || u.includes('ollama')) return 'ollama';
  if (u.includes(':4000') || u.includes('litellm')) return 'litellm';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes(':8000') || u.includes('vllm')) return 'vllm';
  if (u.includes(':8080') || u.includes('llama')) return 'llamacpp';
  return 'unknown';
}

/**
 * Prueba `GET {baseUrl}/models` y devuelve las capacidades detectadas.
 * Nunca lanza: ante cualquier fallo devuelve `listsModels: false` con una
 * nota explicativa. El caller decide el fallback (entrada manual de modelo).
 *
 * @param baseUrl URL base incluyendo el prefijo de la API (ej. `http://localhost:8080/v1`)
 * @param apiKey  API key opcional (Bearer)
 */
export async function detectCapabilities(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<ProviderCapabilities> {
  const backend = classifyBackendByUrl(baseUrl);
  try {
    const models = await fetchModels(baseUrl, apiKey, opts);
    if (models.length === 0) {
      return {
        backend,
        listsModels: false,
        models: [],
        note:
          `El endpoint ${baseUrl}/models respondió pero no devolvió modelos` +
          (backend === 'llamacpp'
            ? ' (llama.cpp server suele exponer solo el modelo cargado).'
            : '.'),
      };
    }
    return { backend, listsModels: true, models };
  } catch (err) {
    return {
      backend,
      listsModels: false,
      models: [],
      note:
        `No se pudo listar modelos en ${baseUrl}/models: ${String(err)}` +
        (backend === 'llamacpp'
          ? ' — llama.cpp server puede no implementar /models; escribe el modelo a mano.'
          : ' — escribe el modelo a mano.'),
    };
  }
}

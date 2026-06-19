/**
 * Utilidades de providers (Hito 3.5): descubrimiento de modelos vía
 * endpoint OpenAI-compatible `GET {baseUrl}/models`.
 */

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
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
  const { timeoutMs = 5000, fetchFn = fetch } = opts;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;

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

  const ids = body.data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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

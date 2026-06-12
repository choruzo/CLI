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

import type { ProviderConfig } from '../../config/schema.js';
import { fetchModels } from '../../providers/utils.js';

/**
 * Lógica pura del ProviderWizard (Hito 3.5) — separada del componente Ink
 * para poder testearla sin renderizar.
 */

export type ProviderTypeId = 'ollama' | 'litellm' | 'openai' | 'vllm' | 'other';

export interface ProviderTypePreset {
  id: ProviderTypeId;
  label: string;
  defaultBaseUrl: string;
  /** false → el wizard omite el paso de API key (ej. Ollama local). */
  requiresApiKey: boolean;
  /** apiKey por defecto cuando no se pide (Ollama acepta cualquier string). */
  defaultApiKey: string;
}

export const PROVIDER_TYPE_PRESETS: ProviderTypePreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    defaultApiKey: 'ollama',
  },
  {
    id: 'litellm',
    label: 'LiteLLM proxy',
    defaultBaseUrl: 'http://localhost:4000/v1',
    requiresApiKey: true,
    defaultApiKey: '',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    defaultApiKey: '',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    defaultBaseUrl: 'http://localhost:8000/v1',
    requiresApiKey: false,
    defaultApiKey: '',
  },
  {
    id: 'other',
    label: 'Otro (OpenAI-compatible)',
    defaultBaseUrl: '',
    requiresApiKey: true,
    defaultApiKey: '',
  },
];

/** Valida el alias del provider. Devuelve mensaje de error o null si es válido. */
export function validateAlias(name: string, existingNames: string[], allowExisting = false): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'El nombre no puede estar vacío';
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return 'Solo letras, números, guiones y guiones bajos';
  }
  if (!allowExisting && existingNames.includes(trimmed)) {
    return `Ya existe un provider llamado "${trimmed}"`;
  }
  return null;
}

/** Valida la base URL. Devuelve mensaje de error o null si es válida. */
export function validateBaseUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'La URL no puede estar vacía';
  try {
    new URL(trimmed);
    return null;
  } catch {
    return 'URL inválida (ej. http://localhost:11434/v1)';
  }
}

export interface ModelDiscovery {
  models: string[];
  /** true → el fetch falló y el wizard debe pedir el modelo a mano. */
  manualFallback: boolean;
  error?: string;
}

/**
 * Paso 5 del wizard: fetch de `/models` con fallback graceful a entrada manual.
 * Nunca lanza — el wizard decide la rama según `manualFallback`.
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  fetchFn?: typeof fetch,
): Promise<ModelDiscovery> {
  try {
    const models = await fetchModels(baseUrl, apiKey, fetchFn ? { fetchFn } : {});
    if (models.length === 0) {
      return { models: [], manualFallback: true, error: 'El endpoint /models no devolvió modelos' };
    }
    return { models, manualFallback: false };
  } catch (err) {
    return { models: [], manualFallback: true, error: String(err) };
  }
}

export interface WizardResult {
  name: string;
  config: ProviderConfig;
  makeDefault: boolean;
}

/** Construye el bloque ProviderConfig final que se escribirá en la config. */
export function buildProviderEntry(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
}): ProviderConfig {
  return {
    type: 'openai-compatible',
    baseUrl: params.baseUrl.trim().replace(/\/$/, ''),
    model: params.model.trim(),
    apiKey: params.apiKey,
    contextWindow: params.contextWindow ?? 32768,
  };
}

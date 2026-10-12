import type { StratumConfig } from '../config/schema.js';
import { fetchModelInfos, type FetchModelsOptions } from '../providers/utils.js';

/**
 * Resolución del modelo de arranque para un provider configurado solo con
 * `baseUrl` + `apiKey`. `chat` lo resuelve en la UI (selector de `/model`);
 * `run` e `init` no tienen a quién preguntar y pasan por aquí.
 */

/** `fetched`: ya se consultó `/models` (no hace falta repetirlo por la ventana). */
export type StartupModel = { ok: true; fetched: boolean } | { ok: false; error: string };

export interface StartupModelOptions extends FetchModelsOptions {
  /** `--provider`: alias a usar en vez del default. */
  provider?: string;
  /** `--model`: modelo para esta invocación (no se persiste). */
  model?: string;
}

/**
 * Deja resuelto en `config` (en memoria) el modelo del provider activo:
 * `--model` > el de la config > el único que exponga `/models`. Con varios
 * modelos y ninguno elegido devuelve un error que los lista.
 *
 * Un provider inexistente no es asunto de esta función: lo rechaza el
 * `ProviderRouter` con su propio mensaje.
 */
export async function resolveStartupModel(
  config: StratumConfig,
  opts: StartupModelOptions = {},
): Promise<StartupModel> {
  const alias = opts.provider ?? config.provider?.default;
  const entry = alias ? config.provider?.providers[alias] : undefined;
  if (!config.provider || !alias || !entry) return { ok: true, fetched: false };

  const requested = opts.model?.trim();
  if (requested) {
    config.provider.providers[alias] = { ...entry, model: requested };
    return { ok: true, fetched: false };
  }
  if (entry.model) return { ok: true, fetched: false };

  let ids: string[];
  try {
    ids = (await fetchModelInfos(entry.baseUrl, entry.apiKey, opts)).map((m) => m.id);
  } catch (err) {
    return {
      ok: false,
      error:
        `El provider "${alias}" no tiene modelo configurado y no se pudo consultar ` +
        `${entry.baseUrl}/models (${err instanceof Error ? err.message : String(err)}). ` +
        `Indica uno con --model <id>.`,
    };
  }

  // Un solo modelo (p. ej. llama.cpp, que expone el que tiene cargado): no hay
  // nada que elegir, y no fijarlo deja que siga al que se cargue mañana.
  if (ids.length === 1) {
    config.provider.providers[alias] = { ...entry, model: ids[0]! };
    return { ok: true, fetched: true };
  }
  if (ids.length === 0) {
    return {
      ok: false,
      error:
        `El provider "${alias}" no tiene modelo configurado y ${entry.baseUrl}/models ` +
        `no devolvió ninguno. Indica uno con --model <id>.`,
    };
  }
  return {
    ok: false,
    error:
      `El provider "${alias}" no tiene modelo configurado. Elige uno con --model <id>, ` +
      `o fíjalo con \`stratum provider models ${alias} --set <id>\`.\n` +
      `Modelos disponibles: ${ids.join(', ')}`,
  };
}

/**
 * Consulta `/models` para conocer la ventana del modelo activo cuando la
 * config no la fija. Nunca lanza: sin respuesta se queda el default.
 */
export async function discoverContextWindow(
  provider: { baseUrl: string; apiKey: string },
  opts: FetchModelsOptions = {},
): Promise<void> {
  try {
    await fetchModelInfos(provider.baseUrl, provider.apiKey, opts);
  } catch {
    // Best-effort.
  }
}

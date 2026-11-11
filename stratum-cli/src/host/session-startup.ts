import type { StratumConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { warnConfigDeprecations } from '../config/deprecation-warning.js';
import { ProviderRouter } from '../providers/router.js';
import { fetchModelInfos, type FetchModelsOptions } from '../providers/utils.js';
import { resolveSessionProfile } from '../agent/session-profile.js';
import { discoverContextWindow, resolveStartupModel } from './startup-model.js';

/**
 * Arranque de una sesión **sin terminal**: de un directorio a la `config` y el
 * `router` que necesita `SessionHost.create`. Es el mismo camino para quien
 * aloje sesiones —`stratum run`, el daemon, un test—, así que aquí no hay
 * ninguna interfaz: ni se pregunta, ni se imprime, ni se sale del proceso. Lo
 * que falla se devuelve con la etapa en la que falló y cada anfitrión lo cuenta
 * a su manera.
 *
 * Orden: config → modelo (`--model` > config > el único que exponga `/models`;
 * con varios **falla listándolos, nunca elige**) → provider → ventana de
 * contexto → perfil de sesión.
 */

export type SessionStartupStage = 'config' | 'model' | 'provider' | 'profile';

/**
 * Una sesión guardada que se montó con otro provider/modelo del que tenía
 * porque ese ya no existe. Quien la monta lo cuenta (aviso en la sesión y log).
 */
export interface StartupFallback {
  reason: 'provider-missing' | 'model-missing';
  saved: { provider?: string; model?: string };
  using: { provider: string; model: string };
}

export type SessionStartup =
  | { ok: true; config: StratumConfig; router: ProviderRouter; fallback?: StartupFallback }
  | { ok: false; stage: SessionStartupStage; error: string };

export interface SessionStartupOptions extends FetchModelsOptions {
  /** Directorio de la sesión: desde él se busca el `.stratumrc.json` de proyecto. */
  cwd: string;
  /** Config ya cargada (quien la necesitó antes, p. ej. para configurar el logging). */
  config?: StratumConfig;
  /** Alias del provider a usar en vez del default. */
  provider?: string;
  /** Modelo para esta sesión. No se persiste. */
  model?: string;
  /** Perfil de sesión pedido: solo se **comprueba** que exista. */
  sessionProfile?: string;
  /**
   * Sesión guardada que se vuelve a montar: su provider/modelo son los que
   * tenía, no una petición del usuario. Si ya no existen se monta con los de
   * la config y se devuelve en `fallback`.
   */
  restoring?: boolean;
  /**
   * Tiempo que se espera a que `/models` declare la ventana de contexto cuando
   * la config no la fija. `0` no espera.
   */
  contextWindowTimeoutMs?: number;
  /** Punto de inyección para tests (un router con un provider de guion). */
  makeRouter?: (config: StratumConfig, provider?: string) => ProviderRouter;
}

export async function resolveSessionStartup(opts: SessionStartupOptions): Promise<SessionStartup> {
  let config: StratumConfig;
  if (opts.config) config = opts.config;
  else {
    try {
      config = loadConfig(opts.cwd);
      // La config de la carpeta de la sesión (el daemon solo leyó la global).
      warnConfigDeprecations();
    } catch (err) {
      return {
        ok: false,
        stage: 'config',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Al restaurar, lo guardado que ya no existe se descarta (y se cuenta).
  let provider = opts.provider;
  let requestedModel = opts.model;
  let fetched = false;
  let reason: StartupFallback['reason'] | undefined;
  if (opts.restoring) {
    const providers = config.provider?.providers ?? {};
    if (provider && !providers[provider]) {
      provider = undefined;
      requestedModel = undefined;
      reason = 'provider-missing';
    } else if (requestedModel) {
      const entry = providers[provider ?? config.provider?.default ?? ''];
      if (entry && requestedModel !== entry.model) {
        try {
          const infos = await fetchModelInfos(entry.baseUrl, entry.apiKey, {
            timeoutMs: opts.contextWindowTimeoutMs ?? 3000,
            ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
          });
          fetched = true;
          if (infos.length > 0 && !infos.some((m) => m.id === requestedModel)) {
            requestedModel = undefined;
            reason = 'model-missing';
          }
        } catch {
          // No se sabe si sigue ahí: se conserva el guardado.
        }
      }
    }
  }
  const startOpts: SessionStartupOptions = { ...opts };
  if (provider) startOpts.provider = provider;
  else delete startOpts.provider;
  if (requestedModel) startOpts.model = requestedModel;
  else delete startOpts.model;

  const model = await resolveStartupModel(config, startOpts);
  if (!model.ok) return { ok: false, stage: 'model', error: model.error };
  fetched ||= model.fetched;

  let router: ProviderRouter;
  try {
    router = opts.makeRouter
      ? opts.makeRouter(config, startOpts.provider)
      : new ProviderRouter(config, startOpts.provider);
  } catch (err) {
    return { ok: false, stage: 'provider', error: String(err) };
  }

  // La ventana se fija al arrancar el turno: se espera (acotado) a lo que
  // declare `/models` si la config no la fija.
  const windowTimeout = opts.contextWindowTimeoutMs ?? 3000;
  if (windowTimeout > 0 && router.contextWindowIsDiscoverable && !fetched) {
    await discoverContextWindow(router.getActiveConfig(), {
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      timeoutMs: windowTimeout,
    });
  }

  if (opts.sessionProfile) {
    const check = resolveSessionProfile(opts.sessionProfile, config);
    if (!check.ok) return { ok: false, stage: 'profile', error: check.error };
  }

  if (!reason) return { ok: true, config, router };
  return {
    ok: true,
    config,
    router,
    fallback: {
      reason,
      saved: {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      },
      using: { provider: router.providerName, model: router.model },
    },
  };
}

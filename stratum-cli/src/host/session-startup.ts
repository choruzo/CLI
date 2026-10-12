import type { StratumConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { ProviderRouter } from '../providers/router.js';
import type { FetchModelsOptions } from '../providers/utils.js';
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

export type SessionStartup =
  | { ok: true; config: StratumConfig; router: ProviderRouter }
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
    } catch (err) {
      return {
        ok: false,
        stage: 'config',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const model = await resolveStartupModel(config, opts);
  if (!model.ok) return { ok: false, stage: 'model', error: model.error };

  let router: ProviderRouter;
  try {
    router = opts.makeRouter
      ? opts.makeRouter(config, opts.provider)
      : new ProviderRouter(config, opts.provider);
  } catch (err) {
    return { ok: false, stage: 'provider', error: String(err) };
  }

  // La ventana se fija al arrancar el turno: se espera (acotado) a lo que
  // declare `/models` si la config no la fija.
  const windowTimeout = opts.contextWindowTimeoutMs ?? 3000;
  if (windowTimeout > 0 && router.contextWindowIsDiscoverable && !model.fetched) {
    await discoverContextWindow(router.getActiveConfig(), {
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      timeoutMs: windowTimeout,
    });
  }

  if (opts.sessionProfile) {
    const check = resolveSessionProfile(opts.sessionProfile, config);
    if (!check.ok) return { ok: false, stage: 'profile', error: check.error };
  }

  return { ok: true, config, router };
}

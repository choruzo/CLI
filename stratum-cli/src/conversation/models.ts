/**
 * Qué modelo mantiene la memoria de sesión (M11). El extractor y el resumen
 * pueden ser el mismo modelo de la sesión (`same`) u otro provider de la
 * config, que se usa con **sus** credenciales: nunca se le pasa la clave del
 * provider principal, ni la del principal sale hacia él.
 *
 * **Frontera de privacidad.** Compactar manda contenido de la conversación
 * (mensajes, salidas de tools) al modelo de memoria. Si ese modelo es otro
 * provider y no está en esta máquina, la config tiene que decirlo
 * (`memory.session.allowRemote: true`); si no, no se compacta y se avisa. El
 * mismo provider de la sesión ya recibe esa conversación en cada turno.
 */
import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { IProvider } from '../providers/base.js';
import { providerClient } from '../providers/router.js';

export type MemoryRole = 'extractor' | 'summarizer';

export interface MemoryModel {
  role: MemoryRole;
  provider: IProvider;
  /** Alias del provider en la config. */
  providerName: string;
  model: string;
  /** ¿Es el provider de la sesión? Entonces no hay frontera nueva. */
  sameProvider: boolean;
}

export type MemoryModels =
  | { ok: true; extractor: MemoryModel; summarizer: MemoryModel }
  | { ok: false; reason: 'egress' | 'unknown-provider' | 'no-model'; message: string };

/** Lo que hace falta de la sesión: su provider activo y su modelo. */
export interface SessionModelSource {
  readonly providerName: string;
  readonly model: string;
  getActive(): IProvider;
}

/** `localhost`, `127.0.0.0/8`, `::1`: el modelo corre en esta máquina. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

function resolveOne(
  role: MemoryRole,
  config: StratumConfig,
  session: SessionModelSource,
): MemoryModel | Extract<MemoryModels, { ok: false }> {
  const wanted = config.memory.session[role];
  const providers = config.provider?.providers ?? {};
  const same = wanted.provider === 'same' || wanted.provider === session.providerName;
  if (same) {
    return {
      role,
      provider: session.getActive(),
      providerName: session.providerName,
      model: wanted.model === 'same' ? session.model : wanted.model,
      sameProvider: true,
    };
  }
  const entry: ProviderConfig | undefined = providers[wanted.provider];
  if (!entry) {
    return {
      ok: false,
      reason: 'unknown-provider',
      message: `memory.session.${role}.provider "${wanted.provider}" is not a configured provider`,
    };
  }
  if (!isLoopbackUrl(entry.baseUrl) && !config.memory.session.allowRemote) {
    return {
      ok: false,
      reason: 'egress',
      message:
        `memory.session.${role} would send conversation content to provider ` +
        `"${wanted.provider}", which is not on this machine; set ` +
        'memory.session.allowRemote to true to allow it',
    };
  }
  const model = wanted.model === 'same' ? entry.model : wanted.model;
  if (!model) {
    return {
      ok: false,
      reason: 'no-model',
      message: `memory.session.${role}: provider "${wanted.provider}" has no model configured`,
    };
  }
  return {
    role,
    // Su propio cliente, con su `apiKey`: nada del provider principal.
    provider: providerClient(entry),
    providerName: wanted.provider,
    model,
    sameProvider: false,
  };
}

/**
 * Resuelve el extractor y el resumen. Se llama en cada compactación: si la
 * sesión cambió de modelo, `same` sigue al modelo actual.
 */
export function resolveMemoryModels(
  config: StratumConfig,
  session: SessionModelSource,
): MemoryModels {
  const extractor = resolveOne('extractor', config, session);
  if ('ok' in extractor) return extractor;
  const summarizer = resolveOne('summarizer', config, session);
  if ('ok' in summarizer) return summarizer;
  return { ok: true, extractor, summarizer };
}

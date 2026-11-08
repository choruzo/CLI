/**
 * Qué modelo hace el dreaming (B4): `memory.dreaming.model`, aparte del de la
 * sesión. `same` sigue al modelo de quien lo pide; otro provider se usa con
 * **sus** credenciales (nunca la clave del principal) y, si no está en esta
 * máquina, exige `memory.dreaming.allowRemote`: una pasada manda contenido de
 * conversaciones.
 */
import type { StratumConfig } from '../../config/schema.js';
import { isLoopbackUrl, type SessionModelSource } from '../../conversation/models.js';
import type { IProvider } from '../../providers/base.js';
import { providerClient } from '../../providers/router.js';

export type DreamingModel =
  | { ok: true; provider: IProvider; providerName: string; model: string }
  | { ok: false; message: string };

export function resolveDreamingModel(
  config: StratumConfig,
  session: SessionModelSource,
): DreamingModel {
  const wanted = config.memory.dreaming.model;
  const same = wanted.provider === 'same' || wanted.provider === session.providerName;
  if (same) {
    return {
      ok: true,
      provider: session.getActive(),
      providerName: session.providerName,
      model: wanted.model === 'same' ? session.model : wanted.model,
    };
  }
  const entry = config.provider?.providers?.[wanted.provider];
  if (!entry) {
    return {
      ok: false,
      message: `memory.dreaming.model.provider "${wanted.provider}" is not a configured provider`,
    };
  }
  if (!isLoopbackUrl(entry.baseUrl) && !config.memory.dreaming.allowRemote) {
    return {
      ok: false,
      message:
        `dreaming would send conversation content to provider "${wanted.provider}", which is not on ` +
        'this machine; set memory.dreaming.allowRemote to true to allow it',
    };
  }
  const model = wanted.model === 'same' ? entry.model : wanted.model;
  if (!model) {
    return {
      ok: false,
      message: `memory.dreaming.model: provider "${wanted.provider}" has no model configured`,
    };
  }
  return { ok: true, provider: providerClient(entry), providerName: wanted.provider, model };
}

/**
 * M20 — de un conector del catálogo y su estado a lo que dice el protocolo
 * (`connectors.*`, `docs/protocol.md` §29). Sin ningún valor de secreto: solo
 * el nombre de los que pide.
 */
import type { ConnectorManifest } from '../connectors/manifest.js';
import { secretsStatusOf, type ConnectorSecretsState } from '../connectors/secrets.js';
import type { EnabledConnector } from '../connectors/store.js';
import type { ConnectorsBoxStatus } from '../box/manager.js';
import type { ProtocolConnector, ProtocolConnectorsBox } from '../protocol/model.js';

export function toProtocolConnector(
  manifest: ConnectorManifest,
  enabled: EnabledConnector | undefined,
  /** `connector-secrets.json`, leído una vez por listado. Solo se mira qué nombres hay. */
  secrets: ConnectorSecretsState,
): ProtocolConnector {
  const at = enabled ? Date.parse(enabled.enabledAt) : NaN;
  const missing = new Set(secretsStatusOf(manifest, secrets).missing);
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    hosts: [...manifest.hosts],
    needs: manifest.secrets.map((s) => ({
      name: s.name,
      description: s.description,
      configured: !missing.has(s.name),
    })),
    tools: manifest.tools.map((t) => ({ name: t.name, readOnly: t.readOnly, summary: t.summary })),
    enabled: enabled !== undefined,
    enabledAt: Number.isFinite(at) ? at : null,
  };
}

export function toProtocolConnectorsBox(status: ConnectorsBoxStatus): ProtocolConnectorsBox {
  return { state: status.state, reason: status.reason ?? null };
}

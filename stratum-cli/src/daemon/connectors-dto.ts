/**
 * M20 — de un conector del catálogo y su estado a lo que dice el protocolo
 * (`connectors.*`, `docs/protocol.md` §29). Sin ningún valor de secreto: solo
 * el nombre de los que pide.
 */
import type { ConnectorManifest } from '../connectors/manifest.js';
import type { EnabledConnector } from '../connectors/store.js';
import type { ConnectorsBoxStatus } from '../box/manager.js';
import type { ProtocolConnector, ProtocolConnectorsBox } from '../protocol/model.js';

export function toProtocolConnector(
  manifest: ConnectorManifest,
  enabled: EnabledConnector | undefined,
): ProtocolConnector {
  const at = enabled ? Date.parse(enabled.enabledAt) : NaN;
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    hosts: [...manifest.hosts],
    needs: manifest.secrets.map((s) => ({ name: s.name, description: s.description })),
    tools: manifest.tools.map((t) => ({ name: t.name, readOnly: t.readOnly, summary: t.summary })),
    enabled: enabled !== undefined,
    enabledAt: Number.isFinite(at) ? at : null,
  };
}

export function toProtocolConnectorsBox(status: ConnectorsBoxStatus): ProtocolConnectorsBox {
  return { state: status.state, reason: status.reason ?? null };
}

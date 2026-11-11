/**
 * M20 — los conectores activos de una sesión del `companion`, listos para
 * montar: qué servers MCP lanzar (en la caja de conectores), qué tools son de
 * solo lectura y qué skills se suman a la sesión. Lo pide `SessionHost` al
 * empezar cada turno, así que activar o desactivar un conector se nota en el
 * turno siguiente (`docs/PRD_STRATUM_DOT.md` §23.11).
 */
import { BoxConfigSchema, type BoxConfig } from '../config/schema.js';
import { connectorLaunches, type ConnectorLaunchDeps } from '../box/connectors.js';
import type { DynamicMcpServer } from '../tools/mcp/manager.js';
import type { SkillEntry } from '../skills/registry.js';
import { loadConnectorCatalog, type CatalogEntry, type ConnectorCatalog } from './catalog.js';
import { readOnlyToolsOf } from './manifest.js';
import { connectorsFile, readConnectorsFile } from './store.js';

export interface ActiveConnectors {
  servers: DynamicMcpServer[];
  /** `mcp.readOnlyTools` de los conectores: `{ <id>: [tool…] }`. */
  readOnlyTools: Record<string, string[]>;
  /** La skill de cada conector; `SessionHost` solo suma las de los que conectaron. */
  skills: { id: string; skill: SkillEntry }[];
  warnings: string[];
}

export interface ActiveConnectorsSource {
  resolve(): Promise<ActiveConnectors>;
}

let bundled: ConnectorCatalog | null = null;
/** El catálogo del paquete, leído una vez por proceso. */
export function bundledCatalog(): ConnectorCatalog {
  return (bundled ??= loadConnectorCatalog());
}

export interface ActiveConnectorsOptions {
  /** Datos del `companion` (`connectors.json` vive ahí). */
  dataDir: string;
  box: BoxConfig | undefined;
  catalog?: ConnectorCatalog;
  launch?: ConnectorLaunchDeps;
}

export function activeConnectorsSource(opts: ActiveConnectorsOptions): ActiveConnectorsSource {
  return { resolve: () => resolveActiveConnectors(opts) };
}

export async function resolveActiveConnectors(
  opts: ActiveConnectorsOptions,
): Promise<ActiveConnectors> {
  const out: ActiveConnectors = { servers: [], readOnlyTools: {}, skills: [], warnings: [] };
  const state = readConnectorsFile(connectorsFile(opts.dataDir));
  if (state.state === 'absent') return out;
  if (state.state !== 'ok') {
    // Falla cerrado: un fichero que no se entiende no activa nada.
    out.warnings.push(
      state.state === 'newer'
        ? 'Connectors are off: connectors.json is from a newer Stratum.'
        : 'Connectors are off: connectors.json is not valid.',
    );
    return out;
  }
  if (state.enabled.length === 0) return out;
  const catalog = opts.catalog ?? bundledCatalog();
  const entries: CatalogEntry[] = [];
  for (const { id } of state.enabled) {
    const entry = catalog.get(id);
    if (!entry) {
      out.warnings.push(`Connector "${id}" is enabled but is not in this Stratum's catalog.`);
      continue;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return out;
  const box = opts.box ?? BoxConfigSchema.parse({});
  const launched = await connectorLaunches(
    box,
    entries.map((e) => e.manifest),
    opts.launch,
  );
  if (!launched.ok) {
    out.warnings.push(`Connectors are unavailable: ${launched.reason}`);
    return out;
  }
  out.servers = launched.launches;
  for (const { manifest, skill } of entries) {
    const ro = readOnlyToolsOf(manifest);
    if (ro.length > 0) out.readOnlyTools[manifest.id] = ro;
    if (skill) out.skills.push({ id: manifest.id, skill });
  }
  return out;
}

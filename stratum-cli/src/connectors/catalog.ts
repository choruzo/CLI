/**
 * M20 — el catálogo de conectores: los que trae **este** paquete
 * (`stratum-cli/connectors/<id>/`). Solo conectores propios: ni npm, ni
 * terceros, ni una ruta de la config (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Cada carpeta tiene su `connector.json` y su `SKILL.md`; el código del server
 * no está aquí, sino dentro de la imagen de la caja
 * (`/opt/stratum/connectors/<id>/server.mjs`).
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseSkill, type SkillEntry } from '../skills/registry.js';
import { getLogger } from '../logging/index.js';
import { CONNECTOR_ID_RE, parseConnectorManifest, type ConnectorManifest } from './manifest.js';

const log = getLogger('connectors');

/** Fichero que identifica la carpeta de conectores del paquete. */
const CATALOG_MARKER = '.stratum-connectors';

/**
 * `connectors/` del paquete. El módulo puede estar en `dist/` (bundle) o en
 * `src/connectors/` (tsx, tests): se sube hasta dar con la carpeta, como
 * `bundledSkillsDir`. Sin la marca encontraría `src/connectors/`.
 */
export function bundledConnectorsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'connectors');
    if (existsSync(join(candidate, CATALOG_MARKER))) return candidate;
    dir = dirname(dir);
  }
  return null;
}

export interface CatalogEntry {
  manifest: ConnectorManifest;
  /** La skill del conector; `null` si falta o no se pudo leer. */
  skill: SkillEntry | null;
}

export interface ConnectorCatalog {
  readonly entries: readonly CatalogEntry[];
  get(id: string): CatalogEntry | undefined;
  /** Carpetas que no se cargaron, y por qué (para `stratum connectors list`). */
  readonly problems: readonly string[];
}

/**
 * Lee el catálogo. Un manifiesto inválido deja fuera **ese** conector, nunca
 * los demás; su carpeta debe llamarse como su `id`.
 */
export function loadConnectorCatalog(
  dir: string | null = bundledConnectorsDir(),
): ConnectorCatalog {
  const entries: CatalogEntry[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  if (dir) {
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && CONNECTOR_ID_RE.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch (err) {
      problems.push(`connectors folder unreadable: ${(err as Error).message}`);
    }
  }
  for (const name of names) {
    const file = join(dir!, name, 'connector.json');
    if (!existsSync(file)) continue;
    let manifest: ConnectorManifest;
    try {
      manifest = parseConnectorManifest(JSON.parse(readFileSync(file, 'utf-8')), file);
    } catch (err) {
      problems.push(`${name}: ${(err as Error).message}`);
      log.warn('connector manifest rejected', { connector: name, err });
      continue;
    }
    if (manifest.id !== name) {
      problems.push(`${name}: its manifest id is "${manifest.id}"; the folder must match it.`);
      continue;
    }
    entries.push({ manifest, skill: readSkill(join(dir!, name, 'SKILL.md'), name) });
  }
  const byId = new Map(entries.map((e) => [e.manifest.id, e]));
  return { entries, problems, get: (id) => byId.get(id) };
}

function readSkill(path: string, id: string): SkillEntry | null {
  if (!existsSync(path)) return null;
  try {
    const entry = parseSkill(path, readFileSync(path, 'utf-8'), 'builtin', `connectors/${id}`);
    return entry ? { ...entry, presets: ['companion'] } : null;
  } catch (err) {
    log.warn('connector skill unreadable', { connector: id, err });
    return null;
  }
}

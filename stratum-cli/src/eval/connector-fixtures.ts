/**
 * M20 — los conectores de un escenario (`setup.connectors`), servidos por su
 * **server de fixtures** (`connector-servers/<id>/fixture-server.ts`: datos y
 * reloj fijos) como un server MCP del `companion` en la config global del HOME
 * del escenario. Es config normal de la persona (`companion.mcp.servers`): el
 * runtime no tiene ningún camino propio para los evals, y un conector de
 * verdad sigue lanzándose solo en la caja de conectores.
 *
 * Las fixtures viven en el código fuente, así que estos escenarios solo corren
 * desde un checkout de Stratum (con tsx o con `dist/` construido en él); desde
 * un paquete instalado se saltan.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { bundledCatalog } from '../connectors/active.js';
import { readOnlyToolsOf } from '../connectors/manifest.js';
import type { FixtureConnector } from './scenario.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Desde el código fuente (tsx, Vitest) o desde `dist/` (todo en un `index.js`). */
const FROM_SOURCE = import.meta.url.endsWith('.ts');

interface FixtureSpec {
  /** Entrada del server: el `.ts` con tsx, o su bundle en `dist/eval-connectors/`. */
  entry: string;
  /** Carpeta de fixtures que recibe en `env`. */
  fixtures: string;
  envVar: string;
}

/** Sube desde `dist/` (o `src/eval/`) hasta el checkout que tenga esa carpeta. */
function findInCheckout(rel: string): string | null {
  let dir = HERE;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function fixtureSpec(id: FixtureConnector): FixtureSpec | null {
  const fixtures = findInCheckout(join('src', 'connector-servers', id, 'fixtures'));
  if (!fixtures) return null;
  const entry = FROM_SOURCE
    ? join(HERE, '..', 'connector-servers', id, 'fixture-server.ts')
    : join(HERE, 'eval-connectors', `${id}.js`);
  if (!existsSync(entry)) return null;
  return { entry, fixtures, envVar: `STRATUM_${id.toUpperCase()}_FIXTURES` };
}

/** Motivo por el que los conectores del escenario no pueden servirse aquí, o null. */
export function connectorFixturesProblem(ids: readonly FixtureConnector[]): string | null {
  const missing = ids.filter((id) => !fixtureSpec(id));
  if (missing.length === 0) return null;
  return `requiere un checkout de Stratum con las fixtures de ${missing.join(', ')} (y dist/ construido si no es con tsx)`;
}

/**
 * Las entradas de `companion.mcp.servers` para esos conectores. `runtime` es
 * cómo se lanza Node en el escenario (el `SpawnSpec` de la CLI sin su entrada:
 * con tsx, lleva su loader).
 */
export function connectorFixtureServers(
  ids: readonly FixtureConnector[],
  runtime: { command: string; args: string[] },
): Record<string, unknown>[] {
  const catalog = bundledCatalog();
  return ids.map((id) => {
    const spec = fixtureSpec(id);
    const manifest = catalog.get(id)?.manifest;
    if (!spec || !manifest) throw new Error(`conector ${id}: sin server de fixtures o manifiesto`);
    return {
      name: id,
      command: runtime.command,
      args: [...runtime.args, spec.entry],
      env: { [spec.envVar]: spec.fixtures },
      // Las mismas declaraciones que en producción: lo que no lee, se confirma.
      readOnlyTools: readOnlyToolsOf(manifest),
    };
  });
}

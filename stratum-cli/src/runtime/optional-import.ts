/**
 * Carga de dependencias opcionales y nativas (`better-sqlite3`, `sqlite-vec`,
 * `@xenova/transformers`) con un único punto de indirección.
 *
 * En la CLI es un `import()` normal. En el sidecar de Stratum Desktop, empaquetado
 * como Node SEA (Single Executable Application), `import()` no está disponible en
 * el script principal y el `require` inyectado solo resuelve módulos internos de
 * Node. El sidecar instala entonces un resolvedor (`setOptionalModuleLoader`)
 * que carga los paquetes desde el `node_modules` que viaja en los resources de
 * Tauri, con los `.node` compilados para esa plataforma.
 *
 * El resultado se normaliza a la forma de un namespace ESM (`default` = export
 * CommonJS), que es lo que esperan los consumidores escritos para `import()`.
 */

export type OptionalModuleLoader = (specifier: string) => unknown;

let loader: OptionalModuleLoader | null = null;

/** Instala (o retira, con `null`) el resolvedor alternativo. Solo lo usa el sidecar. */
export function setOptionalModuleLoader(fn: OptionalModuleLoader | null): void {
  loader = fn;
}

export async function importOptional<T>(specifier: string): Promise<T> {
  if (!loader) return (await import(/* @vite-ignore */ specifier)) as T;
  return toNamespace(loader(specifier)) as T;
}

/**
 * `require()` de un paquete CommonJS devuelve el `module.exports` a secas; el de
 * un paquete ESM (require(esm), Node ≥ 22.12) devuelve ya su namespace.
 */
export function toNamespace(mod: unknown): unknown {
  if (mod !== null && typeof mod === 'object') {
    if ((mod as Record<symbol, unknown>)[Symbol.toStringTag] === 'Module') return mod;
    return { ...(mod as Record<string, unknown>), default: mod };
  }
  // Un export CommonJS que es una función o clase (better-sqlite3 exporta el constructor).
  return { default: mod };
}

/**
 * Descubrimiento de plugins (PL1): de los orígenes a una lista de candidatos,
 * sin `import()` —ningún código de plugin corre aquí—. Orígenes, en orden de
 * carga (= orden de los hooks):
 *
 *   1. `--plugin <ruta>` (repetible; lo pidió el usuario en esta invocación)
 *   2. `plugins.entries` de la config **global**
 *   3. `~/.stratum/plugins/` (ficheros sueltos y subcarpetas de un nivel)
 *
 * Los orígenes de proyecto (config y `.stratum/plugins/` del repo) no se cargan
 * hasta que haya confianza de proyecto (PL4): un id declarado solo en la config
 * de proyecto queda en `skipped` con su motivo.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { expandHome } from '../config/paths.js';
import type { PluginsConfig } from '../config/schema.js';

export type PluginSource = 'flag' | 'config' | 'directory';

export interface PluginCandidate {
  /** Ruta real (`realpath`) del módulo a importar. */
  entry: string;
  source: PluginSource;
  /** Id que se espera: la clave de la config, o el nombre del fichero o carpeta. */
  expectedId?: string;
  options: Record<string, unknown>;
}

export interface PluginSkip {
  source: PluginSource | 'project';
  id?: string;
  entry?: string;
  reason: string;
}

export interface DiscoverOptions {
  /** Rutas de `--plugin`, relativas a `cwd`. */
  flagPaths: readonly string[];
  /** `plugins.entries` de la config global. */
  globalEntries: PluginsConfig['entries'];
  /** Directorio contra el que se resuelven las rutas relativas de la config global. */
  globalConfigDir: string;
  /** `~/.stratum/plugins/`; `null` no lo recorre. */
  pluginsDir: string | null;
  /** Ids de `plugins.entries` que solo declara la config de proyecto. */
  projectOnlyIds: readonly string[];
  cwd: string;
  /** El Node que corre quita tipos de TypeScript (`process.features.typescript`). */
  typescript: boolean;
}

export interface Discovery {
  candidates: PluginCandidate[];
  skipped: PluginSkip[];
  /** Ids con `enabled: false` en la config global: no se cargan ni por directorio. */
  disabled: ReadonlySet<string>;
}

const JS_EXTENSIONS = new Set(['.js', '.mjs']);
const TS_EXTENSIONS = new Set(['.ts', '.mts']);

function isPluginFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext);
}

/** `null` si es un `.ts` en un Node que no sabe quitarle los tipos. */
function typescriptProblem(entry: string, typescript: boolean): string | null {
  if (typescript || !TS_EXTENSIONS.has(extname(entry).toLowerCase())) return null;
  return (
    'plugin en TypeScript: este Node no quita tipos de forma nativa (hace falta Node ≥ 22.18). ' +
    'Compílalo a .js o actualiza Node.'
  );
}

/** ¿Está `child` dentro de `parent`? Ambas rutas ya reales. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Entry de una carpeta de plugin: `package.json` (`stratum.plugin` o `main`) o
 * `index.js`/`index.mjs`/`index.ts`. El entry resuelto por `realpath` tiene que
 * quedar **dentro** de la carpeta: un symlink no la saca de ella.
 */
export function resolveFolderEntry(folder: string): { entry: string } | { reason: string } {
  let declared: string | undefined;
  const pkgPath = join(folder, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        main?: unknown;
        stratum?: { plugin?: unknown };
      };
      const fromStratum = pkg.stratum?.plugin;
      if (typeof fromStratum === 'string') declared = fromStratum;
      else if (typeof pkg.main === 'string') declared = pkg.main;
    } catch (err) {
      return {
        reason: `package.json ilegible: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const tries = declared ? [declared] : ['index.js', 'index.mjs', 'index.ts'];
  for (const name of tries) {
    const candidate = resolve(folder, name);
    if (!existsSync(candidate)) continue;
    let real: string;
    let realFolder: string;
    try {
      real = realpathSync(candidate);
      realFolder = realpathSync(folder);
    } catch (err) {
      return {
        reason: `no se pudo resolver el entry: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!isInside(realFolder, real))
      return { reason: `el entry "${name}" sale de la carpeta del plugin` };
    if (!statSync(real).isFile()) return { reason: `el entry "${name}" no es un fichero` };
    return { entry: real };
  }
  return {
    reason: declared
      ? `el entry declarado "${declared}" no existe`
      : 'sin entry: falta package.json (stratum.plugin o main) o index.js',
  };
}

/** Un fichero o una carpeta de plugin, a su entry real. */
function resolveEntry(path: string): { entry: string } | { reason: string } {
  if (!existsSync(path)) return { reason: 'no existe' };
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isDirectory()) return resolveFolderEntry(path);
  if (!isPluginFile(path)) return { reason: 'no es un .js, .mjs ni .ts' };
  try {
    return { entry: realpathSync(path) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

function idFromName(name: string): string {
  return basename(name, extname(name)).toLowerCase();
}

export function discoverPlugins(opts: DiscoverOptions): Discovery {
  const candidates: PluginCandidate[] = [];
  const skipped: PluginSkip[] = [];
  const disabled = new Set(
    Object.entries(opts.globalEntries)
      .filter(([, e]) => e.enabled === false)
      .map(([id]) => id),
  );

  const accept = (
    resolved: { entry: string } | { reason: string },
    base: Omit<PluginCandidate, 'entry'>,
    shown: string,
  ): void => {
    if ('reason' in resolved) {
      skipped.push({
        source: base.source,
        id: base.expectedId,
        entry: shown,
        reason: resolved.reason,
      });
      return;
    }
    const ts = typescriptProblem(resolved.entry, opts.typescript);
    if (ts) {
      skipped.push({ source: base.source, id: base.expectedId, entry: resolved.entry, reason: ts });
      return;
    }
    candidates.push({ ...base, entry: resolved.entry });
  };

  // 1. `--plugin`: explícito, así que ni `enabled: false` lo apaga.
  for (const raw of opts.flagPaths) {
    const path = resolve(opts.cwd, expandHome(raw));
    accept(resolveEntry(path), { source: 'flag', options: {} }, path);
  }

  // 2. `plugins.entries` de la config global.
  for (const [id, entry] of Object.entries(opts.globalEntries)) {
    if (entry.enabled === false) continue;
    if (entry.package && !entry.path) {
      skipped.push({
        source: 'config',
        id,
        reason: `paquete "${entry.package}": la instalación de paquetes todavía no existe (PL3)`,
      });
      continue;
    }
    if (!entry.path) {
      skipped.push({ source: 'config', id, reason: 'la entrada no tiene "path"' });
      continue;
    }
    const path = resolve(opts.globalConfigDir, expandHome(entry.path));
    accept(
      resolveEntry(path),
      { source: 'config', expectedId: id, options: entry.options ?? {} },
      path,
    );
  }

  // 3. `~/.stratum/plugins/`: alfabético, un nivel, sin ocultos ni `node_modules`.
  if (opts.pluginsDir && existsSync(opts.pluginsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(opts.pluginsDir).sort();
    } catch (err) {
      skipped.push({
        source: 'directory',
        entry: opts.pluginsDir,
        reason: `no se pudo leer: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = join(opts.pluginsDir, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (!isDir && !isPluginFile(name)) continue;
      const expectedId = isDir ? name.toLowerCase() : idFromName(name);
      // Apagado en la config: ni se importa (importar ya ejecuta su código).
      if (disabled.has(expectedId)) {
        skipped.push({
          source: 'directory',
          id: expectedId,
          entry: path,
          reason: 'desactivado en la config',
        });
        continue;
      }
      // Las opciones de `plugins.entries.<id>` llegan también a uno descubierto aquí.
      const options = opts.globalEntries[expectedId]?.options ?? {};
      accept(resolveEntry(path), { source: 'directory', expectedId, options }, path);
    }
  }

  // Los de proyecto esperan a la confianza de proyecto.
  for (const id of opts.projectOnlyIds) {
    skipped.push({
      source: 'project',
      id,
      reason:
        'declarado en la config de proyecto: los plugins de proyecto aún no se cargan (necesitan confianza de proyecto, PL4)',
    });
  }

  return { candidates, skipped, disabled };
}

/** Directorio de la config global (contra él se resuelven sus rutas relativas). */
export function configDirOf(globalConfigPath: string): string {
  return dirname(globalConfigPath);
}

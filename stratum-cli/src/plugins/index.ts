/**
 * Punto de entrada único de los plugins (PL1): de la config y los flags a un
 * `PluginHost` con lo que se pudo cargar y el porqué de lo que no. Nunca lanza:
 * un plugin roto no impide arrancar, queda en el informe.
 *
 * La config de plugins sale **solo de la capa global** (`~/.stratum/.stratumrc.json`):
 * un `plugins` en la config de proyecto no carga código hasta la confianza de
 * proyecto (PL4).
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { GLOBAL_CONFIG_PATH, readConfigFile, validateConfigLayer } from '../config/loader.js';
import { findWorktreeRoot } from '../config/paths.js';
import type { PluginsConfig, StratumConfig } from '../config/schema.js';
import { PluginsConfigSchema } from '../config/schema.js';
import { getLogger } from '../logging/index.js';
import { configDirOf, discoverPlugins } from './discover.js';
import { PluginHost } from './host.js';
import { loadPluginModule } from './load-module.js';

export { PluginHost } from './host.js';
export type { PluginReport, VetoRequest, PluginVeto } from './host.js';

const log = getLogger('plugins');

export interface LoadPluginsOptions {
  /** Directorio de la sesión (rutas relativas de `--plugin`, `project.cwd`). */
  cwd: string;
  /** Config ya cargada (fusionada): solo se mira qué ids declara el proyecto. */
  config: StratumConfig;
  /** `--no-plugins`. */
  disabled?: boolean;
  /** `--plugin <ruta>` (repetible). */
  paths?: readonly string[];
  /** Versión de Stratum que ve el plugin. */
  version?: string;
  /** Inyectables para tests. */
  globalConfigPath?: string;
  /** `null` no recorre ningún directorio. */
  pluginsDir?: string | null;
}

/** Opciones de carga que deciden quien aloja la sesión (flags de `run`/`chat`). */
export interface PluginLoadRequest {
  disabled?: boolean;
  paths?: readonly string[];
}

export function defaultPluginsDir(): string {
  return join(homedir(), '.stratum', 'plugins');
}

/** La sección `plugins` de la config global, validada; los defaults si no hay. */
function globalPluginsConfig(path: string): PluginsConfig {
  if (!existsSync(path)) return PluginsConfigSchema.parse({});
  return validateConfigLayer(path, readConfigFile(path), path).plugins;
}

/** ¿El Node que corre quita tipos de TypeScript de forma nativa? */
function nodeStripsTypes(): boolean {
  return Boolean((process.features as { typescript?: unknown }).typescript);
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginHost> {
  const globalPath = opts.globalConfigPath ?? GLOBAL_CONFIG_PATH;
  let global: PluginsConfig;
  try {
    global = globalPluginsConfig(globalPath);
  } catch (err) {
    // `loadConfig` ya habría fallado con esta config; aquí, por si se llama sola.
    log.warn('global plugins config unreadable', { err });
    const host = PluginHost.empty(false);
    host.noteSkipped({
      source: 'config',
      reason: `la config global no es válida: ${err instanceof Error ? err.message : String(err)}`,
    });
    return host;
  }
  if (opts.disabled || !global.enabled) return PluginHost.empty(false);

  const host = new PluginHost(
    {
      hookTimeoutMs: global.hookTimeoutMs,
      setupTimeoutMs: global.setupTimeoutMs,
      batchTimeoutMs: global.batchTimeoutMs,
    },
    { cwd: opts.cwd, worktree: findWorktreeRoot(opts.cwd).worktree, version: opts.version ?? '' },
  );

  // `STRATUM_NO_PLUGINS=1` (tests, evals) no carga los plugins del usuario: ni
  // su config global ni su `~/.stratum/plugins/`. Lo explícito sí: `--plugin` y
  // una config o un directorio que se pasen a propósito.
  const userPlugins = process.env.STRATUM_NO_PLUGINS !== '1';
  const globalEntries = userPlugins || opts.globalConfigPath !== undefined ? global.entries : {};
  const pluginsDir =
    opts.pluginsDir !== undefined ? opts.pluginsDir : userPlugins ? defaultPluginsDir() : null;
  const projectOnlyIds = Object.keys(opts.config.plugins?.entries ?? {}).filter(
    (id) => !(id in global.entries),
  );
  const discovery = discoverPlugins({
    flagPaths: opts.paths ?? [],
    globalEntries,
    globalConfigDir: configDirOf(globalPath),
    pluginsDir,
    projectOnlyIds,
    cwd: opts.cwd,
    typescript: nodeStripsTypes(),
  });
  for (const skip of discovery.skipped) host.noteSkipped(skip);

  const entries = new Map<string, string>();
  for (const candidate of discovery.candidates) {
    const loaded = await loadPluginModule(candidate.entry);
    if (!loaded.ok) {
      host.noteSkipped({
        source: candidate.source,
        ...(candidate.expectedId ? { id: candidate.expectedId } : {}),
        entry: candidate.entry,
        reason: loaded.reason,
      });
      continue;
    }
    const { plugin } = loaded;
    const skip = (reason: string): void =>
      host.noteSkipped({ source: candidate.source, id: plugin.id, entry: candidate.entry, reason });
    if (candidate.source === 'config' && candidate.expectedId !== plugin.id) {
      skip(
        `el plugin se llama "${plugin.id}" y la config lo declara como "${candidate.expectedId}"`,
      );
      continue;
    }
    if (candidate.source !== 'flag' && discovery.disabled.has(plugin.id)) {
      skip('desactivado en la config');
      continue;
    }
    const first = entries.get(plugin.id);
    if (first !== undefined) {
      if (first !== candidate.entry) skip(`id duplicado: ya se cargó desde ${first}`);
      continue;
    }
    entries.set(plugin.id, candidate.entry);
    await host.add(plugin, {
      source: candidate.source,
      entry: candidate.entry,
      options: candidate.options,
    });
  }
  return host;
}

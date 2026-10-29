import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { loadPlugins } from '../../plugins/index.js';
import { formatPluginsReport, pluginsToJson } from '../../plugins/report.js';
import { cliVersion } from '../version.js';

/**
 * `stratum plugin list`: qué plugins cargaría una sesión aquí y por qué no los
 * demás. Carga de verdad (corre el `setup` de cada uno, como al abrir una
 * sesión) y los cierra al terminar.
 */
const pluginList = new Command('list')
  .description('List the plugins a session would load here, and why the others are skipped')
  .option('--json', 'output as JSON')
  .option(
    '--plugin <path>',
    'also load this plugin file or folder (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (opts: { json?: boolean; plugin?: string[] }) => {
    const cwd = process.cwd();
    const plugins = await loadPlugins({
      cwd,
      config: loadConfig(cwd),
      version: cliVersion(),
      paths: opts.plugin ?? [],
    });
    const report = plugins.report();
    await plugins.dispose('closed');
    process.stdout.write(`${opts.json ? pluginsToJson(report) : formatPluginsReport(report)}\n`);
  });

export const pluginCommand = new Command('plugin')
  .description(
    'Inspect in-process plugins (~/.stratum/plugins, plugins.entries in the global config)',
  )
  .addCommand(pluginList);

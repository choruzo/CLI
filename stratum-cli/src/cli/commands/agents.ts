import { Command } from 'commander';
import { ProfileLoader } from '../../agent/profiles.js';
import { formatProfilesReport, profilesToJson } from '../../agent/profiles-report.js';
import { findWorktreeRoot } from '../../agent/system-prompt.js';

/**
 * `stratum agents` — perfiles de agente (Hito 15). Mismos roots que
 * `StratumAgent` (raíz del worktree + cwd): lo que lista es lo que el chat
 * cargaría desde este directorio.
 */
const listSub = new Command('list')
  .description('List agent profiles (global and project), including invalid ones')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const loader = new ProfileLoader([findWorktreeRoot(cwd).worktree, cwd]);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          profilesToJson(loader.list(), loader.invalidProfiles(), loader.warnings()),
          null,
          2,
        ) + '\n',
      );
      return;
    }
    process.stdout.write(
      formatProfilesReport(loader.list(), loader.invalidProfiles(), {
        warnings: loader.warnings(),
      }) + '\n',
    );
  });

export const agentsCommand = new Command('agents')
  .description('Inspect agent profiles from ~/.stratum/agents and <project>/.stratum/agents')
  .addCommand(listSub);

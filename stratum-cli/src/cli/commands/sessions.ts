import { Command } from 'commander';

const sessionsList = new Command('list')
  .description('List saved sessions')
  .option('--last <n>', 'show only the last N sessions', '10')
  .action(() => {
    process.stderr.write('stratum sessions list is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

const sessionsResume = new Command('resume')
  .description('Resume a saved session')
  .argument('<id>', 'session ID to resume')
  .action(() => {
    process.stderr.write('stratum sessions resume is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

const sessionsDelete = new Command('delete')
  .description('Delete a saved session')
  .argument('<id>', 'session ID to delete')
  .action(() => {
    process.stderr.write('stratum sessions delete is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

const sessionsPrune = new Command('prune')
  .description('Remove sessions older than a given age')
  .option('--older <duration>', 'remove sessions older than this duration (e.g. 30d)', '30d')
  .action(() => {
    process.stderr.write('stratum sessions prune is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

export const sessionsCommand = new Command('sessions')
  .description('Manage saved conversation sessions')
  .addCommand(sessionsList)
  .addCommand(sessionsResume)
  .addCommand(sessionsDelete)
  .addCommand(sessionsPrune);

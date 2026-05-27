import { Command } from 'commander';

export const runCommand = new Command('run')
  .description('Run a one-shot task with the agent')
  .argument('<task>', 'task to execute')
  .option('--provider <name>', 'use a specific provider from config')
  .option('--allow-destructive', 'approve all destructive operations without prompting')
  .option('--deny-destructive', 'block all destructive operations automatically')
  .action(() => {
    process.stderr.write('stratum run is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

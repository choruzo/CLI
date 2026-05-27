import { Command } from 'commander';

export const chatCommand = new Command('chat')
  .description('Start an interactive REPL session with the agent')
  .option('--provider <name>', 'use a specific provider from config')
  .option('--resume <session-id>', 'resume a previous session')
  .action(() => {
    process.stderr.write('stratum chat is not yet implemented. Coming in Hito 1.\n');
    process.exit(1);
  });

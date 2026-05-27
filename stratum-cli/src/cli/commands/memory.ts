import { Command } from 'commander';

const memoryList = new Command('list').description('List stored decisions').action(() => {
  process.stderr.write('stratum memory list is not yet implemented. Coming in Hito 5.\n');
  process.exit(1);
});

const memorySearch = new Command('search')
  .description('Semantic search through stored decisions')
  .argument('<query>', 'search query')
  .action(() => {
    process.stderr.write('stratum memory search is not yet implemented. Coming in Hito 5.\n');
    process.exit(1);
  });

const memoryForget = new Command('forget')
  .description('Remove a stored decision')
  .argument('<id>', 'decision ID to remove')
  .action(() => {
    process.stderr.write('stratum memory forget is not yet implemented. Coming in Hito 5.\n');
    process.exit(1);
  });

const memoryShow = new Command('show').description('Show the active STRATUM.md content').action(() => {
  process.stderr.write('stratum memory show is not yet implemented. Coming in Hito 2.\n');
  process.exit(1);
});

export const memoryCommand = new Command('memory')
  .description('Manage agent memory and stored decisions')
  .addCommand(memoryList)
  .addCommand(memorySearch)
  .addCommand(memoryForget)
  .addCommand(memoryShow);

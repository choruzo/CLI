import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { renderMemoryShow } from '../../memory/show.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';
import type { DecisionRecord } from '../../memory/decisions.js';

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${String(err)}\n`);
    process.exit(1);
  }
}

function formatDecision(d: DecisionRecord, score?: number): string {
  const date = d.timestamp.slice(0, 10);
  const head =
    `${d.id}  [${d.type}/${d.importance}]` + (score !== undefined ? `  score ${score.toFixed(2)}` : '');
  const tags = d.tags.length ? `\n  tags: ${d.tags.join(', ')}` : '';
  return `${head}\n  ${date} — ${d.title}\n  ${d.content}${tags}`;
}

const memoryList = new Command('list').description('List stored decisions').action(() => {
  const config = loadConfigOrExit();
  const decisions = getDecisionMemory(config).list();
  if (decisions.length === 0) {
    process.stdout.write('No hay decisiones almacenadas.\n');
    return;
  }
  const sorted = [...decisions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  process.stdout.write(sorted.map((d) => formatDecision(d)).join('\n\n') + '\n');
});

const memorySearch = new Command('search')
  .description('Semantic search through stored decisions')
  .argument('<query>', 'search query')
  .option('-k, --top <n>', 'number of results', (v) => parseInt(v, 10))
  .action(async (query: string, opts: { top?: number }) => {
    const config = loadConfigOrExit();
    const results = await getDecisionMemory(config).search(query, opts.top);
    if (results.length === 0) {
      process.stdout.write('Sin resultados relevantes.\n');
      return;
    }
    process.stdout.write(results.map((r) => formatDecision(r.record, r.score)).join('\n\n') + '\n');
  });

const memoryForget = new Command('forget')
  .description('Remove a stored decision')
  .argument('<id>', 'decision ID to remove')
  .action(async (id: string) => {
    const config = loadConfigOrExit();
    const removed = await getDecisionMemory(config).remove(id);
    if (removed) {
      process.stdout.write(`Decisión ${id} eliminada.\n`);
    } else {
      process.stderr.write(`No se encontró la decisión ${id}.\n`);
      process.exit(1);
    }
  });

const memoryShow = new Command('show')
  .description('Show the active STRATUM.md content')
  .action(() => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${String(err)}\n`);
      process.exit(1);
    }

    const output = renderMemoryShow(config);
    process.stdout.write(output + '\n');
  });

export const memoryCommand = new Command('memory')
  .description('Manage agent memory and stored decisions')
  .addCommand(memoryList)
  .addCommand(memorySearch)
  .addCommand(memoryForget)
  .addCommand(memoryShow);

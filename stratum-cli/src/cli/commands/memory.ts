import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { renderMemoryShow } from '../../memory/show.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';
import type { DecisionRecord } from '../../memory/decisions.js';
import type { StratumConfig } from '../../config/schema.js';
import {
  assistantDataDir,
  buildAssistantConfig,
  importLegacyGlobalDecisions,
  legacyGlobalDecisionsDir,
} from '../../host/assistant.js';

/**
 * La memoria sobre la que actúa un subcomando: la del proyecto del directorio
 * actual o, con `--global`, la del asistente (la única global), importando
 * antes, una sola vez, las decisiones globales antiguas de la CLI.
 */
function memoryConfig(config: StratumConfig, global: boolean | undefined): StratumConfig {
  if (!global) return config;
  const dataDir = assistantDataDir();
  importLegacyGlobalDecisions(dataDir, legacyGlobalDecisionsDir());
  return buildAssistantConfig(config, dataDir);
}

const GLOBAL_HELP = "use the assistant's global memory instead of this project's";

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function formatDecision(d: DecisionRecord, score?: number): string {
  const date = d.timestamp.slice(0, 10);
  const head =
    `${d.id}  [${d.type}/${d.importance}]` +
    (score !== undefined ? `  score ${score.toFixed(2)}` : '');
  const tags = d.tags.length ? `\n  tags: ${d.tags.join(', ')}` : '';
  return `${head}\n  ${date} — ${d.title}\n  ${d.content}${tags}`;
}

const memoryList = new Command('list')
  .description('List stored decisions')
  .option('-g, --global', GLOBAL_HELP)
  .action((opts: { global?: boolean }) => {
    const config = memoryConfig(loadConfigOrExit(), opts.global);
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
  .option('-g, --global', GLOBAL_HELP)
  .action(async (query: string, opts: { top?: number; global?: boolean }) => {
    const config = memoryConfig(loadConfigOrExit(), opts.global);
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
  .option('-g, --global', GLOBAL_HELP)
  .action(async (id: string, opts: { global?: boolean }) => {
    const config = memoryConfig(loadConfigOrExit(), opts.global);
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
  .option('-g, --global', "show the global STRATUM.md (the assistant's) instead of this project's")
  .action((opts: { global?: boolean }) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    const output = renderMemoryShow(config, process.cwd(), opts.global ? 'global' : 'project');
    process.stdout.write(output + '\n');
  });

export const memoryCommand = new Command('memory')
  .description('Manage agent memory and stored decisions')
  .addCommand(memoryList)
  .addCommand(memorySearch)
  .addCommand(memoryForget)
  .addCommand(memoryShow);

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
import { buildCompanionConfig, companionDataDir } from '../../host/companion.js';

interface MemoryScopeFlags {
  global?: boolean;
  companion?: boolean;
}

/**
 * La memoria sobre la que actúa un subcomando: la del proyecto del directorio
 * actual; con `--global`, la del asistente (la única global), importando
 * antes, una sola vez, las decisiones globales antiguas de la CLI; con
 * `--companion`, la del asistente de Stratum Dot (M14).
 */
function memoryConfig(config: StratumConfig, flags: MemoryScopeFlags): StratumConfig {
  if (flags.global && flags.companion) {
    process.stderr.write('--global y --companion no se combinan: son memorias distintas.\n');
    process.exit(1);
  }
  if (flags.companion) return buildCompanionConfig(config, companionDataDir());
  if (!flags.global) return config;
  const dataDir = assistantDataDir();
  importLegacyGlobalDecisions(dataDir, legacyGlobalDecisionsDir());
  return buildAssistantConfig(config, dataDir);
}

const GLOBAL_HELP = "use the assistant's global memory instead of this project's";
const COMPANION_HELP =
  "use the memory of Stratum Dot's assistant (companion) instead of this project's";

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
  .option('--companion', COMPANION_HELP)
  .action((opts: MemoryScopeFlags) => {
    const config = memoryConfig(loadConfigOrExit(), opts);
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
  .option('--companion', COMPANION_HELP)
  .action(async (query: string, opts: { top?: number } & MemoryScopeFlags) => {
    const config = memoryConfig(loadConfigOrExit(), opts);
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
  .option('--companion', COMPANION_HELP)
  .action(async (id: string, opts: MemoryScopeFlags) => {
    const config = memoryConfig(loadConfigOrExit(), opts);
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
  .option('--companion', "show the STRATUM.md of Stratum Dot's assistant instead of this project's")
  .action((opts: MemoryScopeFlags) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    // `--companion` es una memoria «global» con otra ruta (`buildCompanionConfig`).
    const output = opts.companion
      ? renderMemoryShow(memoryConfig(config, opts), process.cwd(), 'global')
      : renderMemoryShow(config, process.cwd(), opts.global ? 'global' : 'project');
    process.stdout.write(output + '\n');
  });

export const memoryCommand = new Command('memory')
  .description('Manage agent memory and stored decisions')
  .addCommand(memoryList)
  .addCommand(memorySearch)
  .addCommand(memoryForget)
  .addCommand(memoryShow);

import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { renderMemoryShow } from '../../memory/show.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';
import {
  MEMORY_SECTIONS,
  presentedType,
  summaryOf,
  type DecisionRecord,
  type MemorySection,
  type MemoryTaxonomy,
} from '../../memory/decisions.js';
import type { StratumConfig } from '../../config/schema.js';
import { findWorktreeRoot } from '../../config/paths.js';
import { defaultSessionsDir } from '../../daemon/session-archive.js';
import { applyProposal, rejectProposal } from '../../memory/dreaming/apply.js';
import { dream } from '../../memory/dreaming/dream.js';
import { openDreamingFiles } from '../../memory/dreaming/files.js';
import { formatProposal } from '../../memory/dreaming/format.js';
import { resolveDreamingModel } from '../../memory/dreaming/model.js';
import { ProviderRouter } from '../../providers/router.js';
import { redactText } from '../../security/redact-output.js';
import { listSources } from '../../transcripts/search.js';
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

/** `--global` y `--companion` son memorias con secciones (M19); la del proyecto, no. */
function taxonomyOf(flags: MemoryScopeFlags): MemoryTaxonomy {
  return flags.global || flags.companion ? 'sections' : 'code';
}

function formatDecision(d: DecisionRecord, taxonomy: MemoryTaxonomy, score?: number): string {
  const date = d.timestamp.slice(0, 10);
  const head =
    `${d.id}  [${presentedType(d.type, taxonomy)}/${d.importance}]` +
    (score !== undefined ? `  score ${score.toFixed(2)}` : '');
  const tags = d.tags.length ? `\n  tags: ${d.tags.join(', ')}` : '';
  // El resumen propio, si lo hay: el de reserva repetiría el contenido justo debajo.
  const summary = taxonomy === 'sections' && d.summary?.trim() ? `\n  ${summaryOf(d)}` : '';
  return `${head}\n  ${date} — ${d.title}${summary}\n  ${d.content}${tags}`;
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
    process.stdout.write(
      sorted.map((d) => formatDecision(d, taxonomyOf(opts))).join('\n\n') + '\n',
    );
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
    process.stdout.write(
      results.map((r) => formatDecision(r.record, taxonomyOf(opts), r.score)).join('\n\n') + '\n',
    );
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

const memoryReclassify = new Command('reclassify')
  .description('Move a memory to another section (assistant and companion memories only)')
  .argument('<id>', 'decision ID')
  .argument('<section>', `one of: ${MEMORY_SECTIONS.join(', ')}`)
  .option('-g, --global', "the assistant's global memory")
  .option('--companion', "the memory of Stratum Dot's assistant (companion)")
  .action(async (id: string, section: string, opts: MemoryScopeFlags) => {
    if (!opts.global && !opts.companion) {
      process.stderr.write(
        'Solo las memorias con secciones se reclasifican: usa --global o --companion.\n',
      );
      process.exit(1);
    }
    if (!(MEMORY_SECTIONS as readonly string[]).includes(section)) {
      process.stderr.write(
        `Sección desconocida «${section}». Usa: ${MEMORY_SECTIONS.join(', ')}.\n`,
      );
      process.exit(1);
    }
    const config = memoryConfig(loadConfigOrExit(), opts);
    const updated = await getDecisionMemory(config).reclassify(id, {
      type: section as MemorySection,
    });
    if (updated) {
      process.stdout.write(`Decisión ${id} movida a ${section}.\n`);
    } else {
      process.stderr.write(`No se encontró la decisión ${id}.\n`);
      process.exit(1);
    }
  });

/** Qué memoria, con qué clasificación y qué conversaciones mira dreaming (M19 fase 5). */
function dreamingTarget(config: StratumConfig, flags: MemoryScopeFlags) {
  const memory = memoryConfig(config, flags);
  if (flags.companion) {
    return { memory, taxonomy: 'sections' as const, scope: { agent: 'companion' as const } };
  }
  if (flags.global) {
    return { memory, taxonomy: 'sections' as const, scope: { agent: 'assistant' as const } };
  }
  return {
    memory,
    taxonomy: 'code' as const,
    scope: { cwd: findWorktreeRoot(process.cwd()).worktree },
  };
}

const memoryDream = new Command('dream')
  .description(
    'Review the memory against recent conversations and PROPOSE changes (never writes the memory)',
  )
  .option('-g, --global', GLOBAL_HELP)
  .option('--companion', COMPANION_HELP)
  .option('--force', 'review the notes even without new conversations')
  .action(async (opts: MemoryScopeFlags & { force?: boolean }) => {
    const config = loadConfigOrExit();
    const target = dreamingTarget(config, opts);
    let router;
    try {
      router = new ProviderRouter(config);
    } catch (err) {
      process.stderr.write(`Provider error: ${String(err)}\n`);
      process.exit(1);
    }
    const model = resolveDreamingModel(config, router);
    if (!model.ok) {
      process.stderr.write(`${model.message}\n`);
      process.exit(1);
    }
    const files = openDreamingFiles(target.memory);
    const memory = getDecisionMemory(target.memory);
    const result = await dream({
      notes: () => memory.list(),
      proposals: files.proposals,
      state: files.state,
      taxonomy: target.taxonomy,
      sources: listSources(defaultSessionsDir(), target.scope),
      provider: model.provider,
      providerName: model.providerName,
      model: model.model,
      config: config.memory.dreaming,
      redact: (text) => redactText(text, target.memory),
      ...(opts.force ? { force: true } : {}),
    });
    if (!result.ok) {
      const quiet = result.reason === 'nothing-new' || result.reason === 'budget';
      process.stderr.write(`${result.message}\n`);
      process.exit(quiet ? 0 : 1);
    }
    const { considered } = result;
    process.stdout.write(
      `Pasada ${result.dreamId}: ${considered.notes} notas y ${considered.messages} mensajes de ` +
        `${considered.sessions} conversaciones → ${result.proposals.length} propuestas` +
        `${result.discarded > 0 ? ` (${result.discarded} descartadas por no valer)` : ''}` +
        `${result.tokens !== null ? `, ${result.tokens} tokens` : ''}.\n`,
    );
    if (result.proposals.length > 0) {
      process.stdout.write(`\n${result.proposals.map(formatProposal).join('\n\n')}\n`);
      process.stdout.write(
        '\nNada se ha aplicado. Revísalas con `stratum memory proposals apply <id>` o `reject <id>`.\n',
      );
    }
  });

const proposalsList = new Command('list')
  .description('List pending dreaming proposals')
  .option('-g, --global', GLOBAL_HELP)
  .option('--companion', COMPANION_HELP)
  .action((opts: MemoryScopeFlags) => {
    const files = openDreamingFiles(memoryConfig(loadConfigOrExit(), opts));
    const pending = files.proposals.pending();
    process.stdout.write(
      pending.length === 0
        ? 'No hay propuestas pendientes.\n'
        : `${pending.map(formatProposal).join('\n\n')}\n`,
    );
  });

const proposalsApply = new Command('apply')
  .description('Apply a dreaming proposal (this is what changes the memory)')
  .argument('<id>', 'proposal ID')
  .option('-g, --global', GLOBAL_HELP)
  .option('--companion', COMPANION_HELP)
  .action(async (id: string, opts: MemoryScopeFlags) => {
    const target = dreamingTarget(loadConfigOrExit(), opts);
    const result = await applyProposal(id, {
      memory: getDecisionMemory(target.memory),
      proposals: openDreamingFiles(target.memory).proposals,
      taxonomy: target.taxonomy,
    });
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    if (!result.ok) process.exit(1);
  });

const proposalsReject = new Command('reject')
  .description('Reject a dreaming proposal (the memory is not touched)')
  .argument('<id>', 'proposal ID')
  .option('-g, --global', GLOBAL_HELP)
  .option('--companion', COMPANION_HELP)
  .action((id: string, opts: MemoryScopeFlags) => {
    const result = rejectProposal(id, {
      proposals: openDreamingFiles(memoryConfig(loadConfigOrExit(), opts)).proposals,
    });
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    if (!result.ok) process.exit(1);
  });

const memoryProposals = new Command('proposals')
  .description('Review what dreaming proposed')
  .addCommand(proposalsList, { isDefault: true })
  .addCommand(proposalsApply)
  .addCommand(proposalsReject);

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
  .addCommand(memoryReclassify)
  .addCommand(memoryDream)
  .addCommand(memoryProposals)
  .addCommand(memoryShow);

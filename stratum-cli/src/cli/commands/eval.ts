import { Command } from 'commander';
import { cpus } from 'os';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { resolveStartupModel } from '../startup-model.js';
import { compareResults, DEFAULT_THRESHOLDS } from '../../eval/compare.js';
import { formatComparison, formatEvalReport, formatScenarioList } from '../../eval/report.js';
import { runEval, type EvalProvider } from '../../eval/runner.js';
import {
  bundledScenariosDir,
  filterScenarios,
  loadScenarios,
  projectScenariosDir,
  SCENARIO_GROUPS,
  type LoadedScenario,
} from '../../eval/scenario.js';
import { evalsDir, listRunIds, resolveResult } from '../../eval/store.js';

/**
 * `stratum eval` — ejecuta escenarios reproducibles con `stratum run`, los
 * puntúa a partir del workspace y de la traza, y compara ejecuciones. Todo
 * queda en local (`~/.stratum/evals/`). Formato y métricas: `docs/eval.md`.
 */

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function discover(opts: { scenarios?: string }): LoadedScenario[] {
  const bundled = bundledScenariosDir();
  const dirs = opts.scenarios
    ? [opts.scenarios]
    : [...(bundled ? [bundled] : []), projectScenariosDir(process.cwd())];
  const set = loadScenarios(dirs);
  for (const error of set.errors) process.stderr.write(`[eval] ${error}\n`);
  return set.scenarios;
}

function select(all: LoadedScenario[], ids: string[], opts: { group: string[] }): LoadedScenario[] {
  const unknownGroup = opts.group.find((g) => !(SCENARIO_GROUPS as readonly string[]).includes(g));
  if (unknownGroup)
    fail(`--group: "${unknownGroup}" no existe. Grupos: ${SCENARIO_GROUPS.join(', ')}.`);
  const unknownId = ids.find((id) => !all.some((s) => s.id === id));
  if (unknownId) fail(`No existe el escenario "${unknownId}". Usa "stratum eval list".`);
  return filterScenarios(all, { ids, groups: opts.group });
}

const thresholdsOf = (opts: { threshold?: string }): typeof DEFAULT_THRESHOLDS => {
  if (opts.threshold === undefined) return DEFAULT_THRESHOLDS;
  const value = Number(opts.threshold);
  if (!(value >= 0)) fail(`--threshold: "${opts.threshold}" no es un porcentaje válido.`);
  return {
    relative: value / 100,
    timeRelative: Math.max(value / 100, DEFAULT_THRESHOLDS.timeRelative),
  };
};

const listSub = new Command('list')
  .description('List the available scenarios')
  .option('--group <name>', 'only this group (repeatable)', collect, [])
  .option('--scenarios <dir>', 'load scenarios from this folder instead of the default ones')
  .option('--json', 'machine-readable output')
  .action((opts: { group: string[]; scenarios?: string; json?: boolean }) => {
    const scenarios = select(discover(opts), [], opts);
    if (opts.json) {
      const rows = scenarios.map(({ id, group, title, script, requires, file }) => ({
        id,
        group,
        title,
        scripted: script !== undefined,
        requires: requires ?? null,
        file,
      }));
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    process.stdout.write(formatScenarioList(scenarios));
  });

interface RunOpts {
  group: string[];
  scenarios?: string;
  mock?: boolean;
  provider?: string;
  model?: string;
  out?: string;
  label?: string;
  concurrency?: string;
  keep?: boolean;
  json?: boolean;
  baseline?: string;
  threshold?: string;
}

const runSub = new Command('run')
  .description('Run scenarios and score them from the workspace and the session trace')
  .argument('[ids...]', 'scenario ids (default: all)')
  .option('--group <name>', 'only this group (repeatable)', collect, [])
  .option('--scenarios <dir>', 'load scenarios from this folder instead of the default ones')
  .option('--mock', 'scripted model: deterministic, measures the runtime rather than the model')
  .option('--provider <name>', 'provider from the config (live mode)')
  .option('--model <id>', 'model of the provider (live mode)')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--label <text>', 'name for this run, shown in reports and comparisons')
  .option('--concurrency <n>', 'scenarios in parallel (default: 1 live, up to 4 with --mock)')
  .option('--keep', 'keep the temporary workspace of each scenario')
  .option('--baseline <ref>', 'compare against a previous run; exit 1 on regression')
  .option('--threshold <pct>', 'relative change that counts as a regression (default: 20)')
  .option('--json', 'print the result JSON instead of the report')
  .action(async (ids: string[], opts: RunOpts) => {
    const scenarios = select(discover(opts), ids, opts);
    if (scenarios.length === 0) fail('No hay escenarios que ejecutar.');
    const dir = evalsDir(opts.out);
    const thresholds = thresholdsOf(opts);
    // La base se resuelve antes de ejecutar: una referencia mala no debe
    // descubrirse tras media hora de escenarios (y `latest` es la anterior).
    const baseline = opts.baseline ? resolveOrFail(opts.baseline, dir) : null;

    let provider: EvalProvider | undefined;
    if (!opts.mock) {
      const config = loadConfig();
      const startup = await resolveStartupModel(config, opts);
      if (!startup.ok) fail(startup.error);
      let router: ProviderRouter;
      try {
        router = new ProviderRouter(config, opts.provider);
      } catch (err) {
        return fail(
          `Provider error: ${err instanceof Error ? err.message : String(err)}\n` +
            'Sin provider configurado puedes ejecutar los escenarios con guion: stratum eval run --mock',
        );
      }
      provider = { name: router.providerName, entry: router.getActiveConfig() };
    }

    const concurrency = opts.concurrency
      ? Math.max(1, parseInt(opts.concurrency, 10) || 1)
      : opts.mock
        ? Math.min(4, cpus().length)
        : 1;

    let done = 0;
    const run = await runEval({
      scenarios,
      mode: opts.mock ? 'mock' : 'live',
      provider,
      outDir: dir,
      stratumVersion: VERSION,
      label: opts.label,
      concurrency,
      keep: opts.keep,
      onResult: (r) => {
        done++;
        process.stderr.write(
          `[${done}/${scenarios.length}] ${r.status.toUpperCase().padEnd(5)} ${r.id}\n`,
        );
      },
    });

    const comparison = baseline ? compareResults(baseline.result, run.result, thresholds) : null;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(comparison ? { result: run.result, comparison } : run.result, null, 2) +
          '\n',
      );
    } else {
      process.stdout.write('\n' + formatEvalReport(run.result, run.dir));
      if (comparison) process.stdout.write('\n' + formatComparison(comparison));
    }

    const s = run.result.summary.overall;
    // `exitCode` y no `process.exit`: con stdout en una tubería, salir en el acto
    // trunca el informe que se acaba de escribir.
    if (s.failed + s.errored > 0 || comparison?.verdict === 'regression') process.exitCode = 1;
  });

function resolveOrFail(ref: string, dir: string): ReturnType<typeof resolveResult> {
  try {
    return resolveResult(ref, dir);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const reportSub = new Command('report')
  .description('Show the report of a saved run')
  .argument('[ref]', 'latest | previous | <runId> | path to result.json', 'latest')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--json', 'print the result JSON')
  .action((ref: string, opts: { out?: string; json?: boolean }) => {
    const stored = resolveOrFail(ref, evalsDir(opts.out));
    process.stdout.write(
      opts.json
        ? JSON.stringify(stored.result, null, 2) + '\n'
        : formatEvalReport(stored.result, stored.dir),
    );
  });

const runsSub = new Command('runs')
  .description('List the saved runs')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .action((opts: { out?: string }) => {
    const dir = evalsDir(opts.out);
    const ids = listRunIds(dir);
    if (ids.length === 0) {
      process.stdout.write('No hay ejecuciones guardadas.\n');
      return;
    }
    for (const id of ids) {
      try {
        const { result } = resolveResult(id, dir);
        const s = result.summary.overall;
        process.stdout.write(
          `${id}  ${s.passed}/${s.total - s.skipped}  v${result.stratumVersion}  ` +
            `${result.mode === 'mock' ? 'guion' : result.provider.model}` +
            `${result.label ? `  ${result.label}` : ''}\n`,
        );
      } catch {
        process.stdout.write(`${id}  (ilegible)\n`);
      }
    }
  });

const compareSub = new Command('compare')
  .description('Compare two runs; exits 1 if the second one regressed')
  .argument('<base>', 'latest | previous | <runId> | path to result.json')
  .argument('[head]', 'the run to judge against the base', 'latest')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--threshold <pct>', 'relative change that counts as a regression (default: 20)')
  .option('--json', 'machine-readable output')
  .action(
    (
      baseRef: string,
      headRef: string,
      opts: { out?: string; threshold?: string; json?: boolean },
    ) => {
      const dir = evalsDir(opts.out);
      const comparison = compareResults(
        resolveOrFail(baseRef, dir).result,
        resolveOrFail(headRef, dir).result,
        thresholdsOf(opts),
      );
      process.stdout.write(
        opts.json ? JSON.stringify(comparison, null, 2) + '\n' : formatComparison(comparison),
      );
      if (comparison.verdict === 'regression') process.exitCode = 1;
    },
  );

export const evalCommand = new Command('eval')
  .description('Run reproducible scenarios, score them from the trace and compare runs')
  .addCommand(runSub)
  .addCommand(listSub)
  .addCommand(reportSub)
  .addCommand(runsSub)
  .addCommand(compareSub);

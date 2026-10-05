import { Command } from 'commander';
import { readFileSync } from 'fs';
import { cpus } from 'os';
import { loadConfig } from '../../config/loader.js';
import { stripBom } from '../../config/json-text.js';
import { ProviderRouter } from '../../providers/router.js';
import { resolveStartupModel } from '../startup-model.js';
import {
  compareResults,
  parseToleranceObject,
  parseToleranceSpec,
  type ToleranceOverrides,
} from '../../eval/compare.js';
import {
  formatBaselineList,
  formatComparison,
  formatEvalReport,
  formatScenarioList,
  scenarioWarnings,
} from '../../eval/report.js';
import { runEval, type EvalProvider } from '../../eval/runner.js';
import {
  bundledScenariosDir,
  DIFFICULTIES,
  filterScenarios,
  loadScenarios,
  projectScenariosDir,
  SCENARIO_GROUPS,
  type LoadedScenario,
} from '../../eval/scenario.js';
import {
  baselineNameProblem,
  DEFAULT_BASELINE_NAME,
  deleteBaseline,
  evalsDir,
  listBaselines,
  listRunIds,
  readBaseline,
  resolveResult,
  saveBaseline,
} from '../../eval/store.js';

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

interface SelectOpts {
  group: string[];
  difficulty: string[];
}

function select(all: LoadedScenario[], ids: string[], opts: SelectOpts): LoadedScenario[] {
  const unknownGroup = opts.group.find((g) => !(SCENARIO_GROUPS as readonly string[]).includes(g));
  if (unknownGroup)
    fail(`--group: "${unknownGroup}" no existe. Grupos: ${SCENARIO_GROUPS.join(', ')}.`);
  const unknownLevel = opts.difficulty.find(
    (d) => !(DIFFICULTIES as readonly string[]).includes(d),
  );
  if (unknownLevel)
    fail(`--difficulty: "${unknownLevel}" no existe. Niveles: ${DIFFICULTIES.join(', ')}.`);
  const unknownId = ids.find((id) => !all.some((s) => s.id === id));
  if (unknownId) fail(`No existe el escenario "${unknownId}". Usa "stratum eval list".`);
  return filterScenarios(all, { ids, groups: opts.group, difficulties: opts.difficulty });
}

interface ToleranceOpts {
  tolerance: string[];
  tolerances?: string;
  threshold?: string;
}

/**
 * Tolerancias pedidas en la línea de comandos, de menor a mayor precedencia:
 * `--threshold` (compatibilidad), `--tolerances <fichero>`, `--tolerance`.
 * Lo que no se indica queda en el default del modo (o en el del baseline).
 */
function tolerancesOf(opts: ToleranceOpts): ToleranceOverrides {
  const out: ToleranceOverrides = {};
  const add = (layer: ToleranceOverrides): void => {
    for (const [metric, t] of Object.entries(layer)) {
      const key = metric as keyof ToleranceOverrides;
      out[key] = { ...out[key], ...t };
    }
  };
  try {
    if (opts.threshold !== undefined) {
      const pct = Number(opts.threshold);
      if (!(pct >= 0)) fail(`--threshold: "${opts.threshold}" no es un porcentaje válido.`);
      add(parseToleranceSpec(`tokens=${pct}% llmCalls=${pct}% toolCalls=${pct}%`));
    }
    if (opts.tolerances !== undefined) {
      add(parseToleranceObject(JSON.parse(stripBom(readFileSync(opts.tolerances, 'utf8')))));
    }
    for (const spec of opts.tolerance) add(parseToleranceSpec(spec));
  } catch (err) {
    fail(`Tolerancias: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

const TOLERANCE_HELP =
  'change to ignore, e.g. tokens=30%,2k duration=100%,10s toolErrors=1 (repeatable)';

function resolveOrFail(ref: string, dir: string): ReturnType<typeof resolveResult> {
  try {
    return resolveResult(ref, dir);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function saveBaselineOrFail(
  dir: string,
  name: string,
  result: Parameters<typeof saveBaseline>[2],
  opts: { note?: string; tolerances: ToleranceOverrides },
): void {
  const problem = baselineNameProblem(name);
  if (problem) fail(`Baseline: ${problem}.`);
  const s = result.summary.overall;
  const saved = saveBaseline(dir, name, result, opts);
  process.stderr.write(
    `Baseline «${name}» ${saved.replaced ? 'reemplazado' : 'guardado'}: ` +
      `${s.passed}/${s.total - s.skipped} PASS, ${result.mode === 'mock' ? 'guion' : result.provider.model}, ` +
      `${result.env?.git ? `commit ${result.env.git.commit}${result.env.git.dirty ? ' con cambios sin commit' : ''}` : 'sin commit'}\n` +
      `  ${saved.file}\n`,
  );
  if (s.errored > 0) {
    process.stderr.write(
      `  Aviso: ${s.errored} escenario(s) en ERROR. Un baseline con errores del banco de ` +
        'pruebas no deja comparar esos escenarios.\n',
    );
  }
}

const listSub = new Command('list')
  .description('List the available scenarios')
  .option('--group <name>', 'only this group (repeatable)', collect, [])
  .option('--difficulty <level>', 'basic | intermediate | adversarial (repeatable)', collect, [])
  .option('--scenarios <dir>', 'load scenarios from this folder instead of the default ones')
  .option('--json', 'machine-readable output')
  .action((opts: SelectOpts & { scenarios?: string; json?: boolean }) => {
    const scenarios = select(discover(opts), [], opts);
    for (const warning of scenarioWarnings(scenarios)) {
      process.stderr.write(`[eval] aviso: ${warning}\n`);
    }
    if (opts.json) {
      const rows = scenarios.map(({ id, group, difficulty, title, script, requires, file }) => ({
        id,
        group,
        difficulty,
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

interface RunOpts extends SelectOpts, ToleranceOpts {
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
  saveBaseline?: string | true;
  note?: string;
}

const runSub = new Command('run')
  .description('Run scenarios and score them from the workspace and the session trace')
  .argument('[ids...]', 'scenario ids (default: all)')
  .option('--group <name>', 'only this group (repeatable)', collect, [])
  .option('--difficulty <level>', 'basic | intermediate | adversarial (repeatable)', collect, [])
  .option('--scenarios <dir>', 'load scenarios from this folder instead of the default ones')
  .option('--mock', 'scripted model: deterministic, measures the runtime rather than the model')
  .option('--provider <name>', 'provider from the config (live mode)')
  .option('--model <id>', 'model of the provider (live mode)')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--label <text>', 'name for this run, shown in reports and comparisons')
  .option('--concurrency <n>', 'scenarios in parallel (default: 1 live, up to 4 with --mock)')
  .option('--keep', 'keep the temporary workspace of each scenario')
  .option('--baseline <ref>', 'compare against a baseline or a previous run; exit 1 on regression')
  .option(
    '--save-baseline [name]',
    `save this run as a named baseline (default name: ${DEFAULT_BASELINE_NAME})`,
  )
  .option('--note <text>', 'note stored with --save-baseline')
  .option('--tolerance <spec>', TOLERANCE_HELP, collect, [])
  .option(
    '--tolerances <file>',
    'JSON file with tolerances: { "tokens": { "pct": 0.3, "abs": 500 } }',
  )
  .option('--threshold <pct>', 'shortcut: relative tolerance for tokens and call counts')
  .option('--json', 'print the result JSON instead of the report')
  .action(async (ids: string[], opts: RunOpts) => {
    const scenarios = select(discover(opts), ids, opts);
    if (scenarios.length === 0) fail('No hay escenarios que ejecutar.');
    const dir = evalsDir(opts.out);
    const tolerances = tolerancesOf(opts);
    const saveAs =
      opts.saveBaseline === undefined
        ? null
        : opts.saveBaseline === true
          ? DEFAULT_BASELINE_NAME
          : opts.saveBaseline;
    if (saveAs !== null) {
      const problem = baselineNameProblem(saveAs);
      if (problem) fail(`--save-baseline: ${problem}.`);
    }
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

    const comparison = baseline ? compareResults(baseline.result, run.result, tolerances) : null;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(comparison ? { result: run.result, comparison } : run.result, null, 2) +
          '\n',
      );
    } else {
      process.stdout.write('\n' + formatEvalReport(run.result, run.dir));
      if (comparison) process.stdout.write('\n' + formatComparison(comparison));
    }
    if (saveAs !== null) {
      saveBaselineOrFail(dir, saveAs, run.result, { note: opts.note, tolerances });
    }

    // `exitCode` y no `process.exit`: con stdout en una tubería, salir en el acto
    // trunca el informe que se acaba de escribir. Con una base, manda la
    // comparación: un fallo que ya estaba en ella no es noticia.
    const s = run.result.summary.overall;
    const bad = comparison ? comparison.verdict === 'regression' : s.failed + s.errored > 0;
    if (bad) process.exitCode = 1;
  });

const reportSub = new Command('report')
  .description('Show the report of a saved run or baseline')
  .argument('[ref]', 'latest | previous | <runId> | <baseline> | path to result.json', 'latest')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--json', 'print the result JSON')
  .action((ref: string, opts: { out?: string; json?: boolean }) => {
    const stored = resolveOrFail(ref, evalsDir(opts.out));
    process.stdout.write(
      opts.json
        ? JSON.stringify(stored.result, null, 2) + '\n'
        : formatEvalReport(stored.result, stored.result.baseline ? undefined : stored.dir),
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
  .argument('<base>', 'latest | previous | <runId> | <baseline> | path to result.json')
  .argument('[head]', 'the run to judge against the base (current = latest)', 'latest')
  .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
  .option('--tolerance <spec>', TOLERANCE_HELP, collect, [])
  .option(
    '--tolerances <file>',
    'JSON file with tolerances: { "tokens": { "pct": 0.3, "abs": 500 } }',
  )
  .option('--threshold <pct>', 'shortcut: relative tolerance for tokens and call counts')
  .option('--json', 'machine-readable output')
  .action(
    (baseRef: string, headRef: string, opts: ToleranceOpts & { out?: string; json?: boolean }) => {
      const dir = evalsDir(opts.out);
      const comparison = compareResults(
        resolveOrFail(baseRef, dir).result,
        resolveOrFail(headRef, dir).result,
        tolerancesOf(opts),
      );
      process.stdout.write(
        opts.json ? JSON.stringify(comparison, null, 2) + '\n' : formatComparison(comparison),
      );
      if (comparison.verdict === 'regression') process.exitCode = 1;
    },
  );

const baselineSub = new Command('baseline')
  .description('Named reference runs to compare against')
  .addCommand(
    new Command('save')
      .description('Save a run as a named baseline (a copy: the run can be deleted afterwards)')
      .argument('[name]', 'baseline name', DEFAULT_BASELINE_NAME)
      .argument('[ref]', 'run to save: latest | previous | <runId> | path', 'latest')
      .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
      .option('--note <text>', 'why this run is the reference')
      .option('--tolerance <spec>', `stored with the baseline; ${TOLERANCE_HELP}`, collect, [])
      .option('--tolerances <file>', 'JSON file with tolerances stored with the baseline')
      .action(
        (name: string, ref: string, opts: ToleranceOpts & { out?: string; note?: string }) => {
          const dir = evalsDir(opts.out);
          const { result } = resolveOrFail(ref, dir);
          saveBaselineOrFail(dir, name, result, {
            note: opts.note,
            tolerances: tolerancesOf(opts),
          });
        },
      ),
  )
  .addCommand(
    new Command('list')
      .description('List the saved baselines')
      .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
      .option('--json', 'machine-readable output')
      .action((opts: { out?: string; json?: boolean }) => {
        const dir = evalsDir(opts.out);
        const results = listBaselines(dir).flatMap((name) => {
          try {
            return [readBaseline(dir, name).result];
          } catch (err) {
            process.stderr.write(`[eval] ${err instanceof Error ? err.message : String(err)}\n`);
            return [];
          }
        });
        if (opts.json) {
          const rows = results.map(({ scenarios: _scenarios, ...meta }) => meta);
          process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
          return;
        }
        process.stdout.write(formatBaselineList(results));
      }),
  )
  .addCommand(
    new Command('delete')
      .description('Delete a baseline')
      .argument('<name>', 'baseline name')
      .option('--out <dir>', 'results folder (default: ~/.stratum/evals)')
      .action((name: string, opts: { out?: string }) => {
        if (!deleteBaseline(evalsDir(opts.out), name)) fail(`No existe el baseline "${name}".`);
        process.stdout.write(`Baseline «${name}» borrado.\n`);
      }),
  );

export const evalCommand = new Command('eval')
  .description('Run reproducible scenarios, score them from the trace and compare runs')
  .addCommand(runSub)
  .addCommand(listSub)
  .addCommand(reportSub)
  .addCommand(runsSub)
  .addCommand(compareSub)
  .addCommand(baselineSub);

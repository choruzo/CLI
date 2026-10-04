/**
 * Runner de `stratum eval`. Cada escenario se ejecuta con `stratum run` como
 * proceso hijo —el mismo binario, sin instrumentación propia— en un HOME y un
 * proyecto temporales; lo que se puntúa es lo que dejó: el workspace, la salida
 * y la traza de `src/trace/`, que es la única fuente de las métricas.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { execa } from 'execa';
import type { ProviderConfig } from '../config/schema.js';
import { readTraceFile } from '../trace/read.js';
import { evaluateChecks, findUnsafeActions, type EvalMode } from './checks.js';
import { buildTraceModel, computeMetrics } from './metrics.js';
import { MOCK_MODEL, startMockLlm, type MockLlm } from './mock-llm.js';
import { EVAL_RESULT_VERSION, summarize, type EvalResult, type ScenarioResult } from './result.js';
import type { LoadedScenario } from './scenario.js';
import { startSshFixture, type SshFixture } from './ssh-fixture.js';

/** Variable por la que el hijo recibe la API key: nunca se escribe en disco. */
const API_KEY_ENV = 'STRATUM_EVAL_API_KEY';

export interface EvalProvider {
  name: string;
  /** Entrada del provider ya resuelta (con modelo y la key expandida). */
  entry: ProviderConfig;
}

export interface SpawnSpec {
  command: string;
  /** Argumentos hasta el entry de la CLI incluido; el runner añade `run …`. */
  args: string[];
}

export interface EvalRunOptions {
  scenarios: readonly LoadedScenario[];
  mode: EvalMode;
  /** Obligatorio en modo `live`. */
  provider?: EvalProvider;
  /** Carpeta de resultados: se crea `<outDir>/runs/<runId>/`. */
  outDir: string;
  stratumVersion: string;
  label?: string;
  concurrency?: number;
  /** Conserva el workspace y el HOME temporales de cada escenario. */
  keep?: boolean;
  /** Cómo lanzar la CLI. Por defecto, el proceso actual. */
  spawn?: SpawnSpec;
  now?: () => number;
  onStart?: (scenario: LoadedScenario) => void;
  onResult?: (result: ScenarioResult) => void;
}

export interface EvalRun {
  result: EvalResult;
  /** Carpeta del resultado (`result.json`, trazas y salidas). */
  dir: string;
  file: string;
}

/** La CLI tal como se está ejecutando ahora (dist, o tsx en desarrollo). */
export function currentCliSpawn(): SpawnSpec {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1] ?? ''] };
}

export function makeRunId(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function onPath(command: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, command + ext))) return true;
  }
  return false;
}

/** Motivo por el que el escenario no se puede ejecutar aquí, o null. */
export function skipReason(scenario: LoadedScenario, mode: EvalMode): string | null {
  if (mode === 'mock' && !scenario.script) return 'sin guion (solo corre contra un modelo real)';
  const platforms = scenario.requires?.platform;
  if (platforms && !platforms.includes(process.platform as 'win32' | 'linux' | 'darwin')) {
    return `requiere ${platforms.join('/')} (esto es ${process.platform})`;
  }
  const missing = scenario.requires?.commands?.filter((c) => !onPath(c)) ?? [];
  if (missing.length > 0) return `falta en el PATH: ${missing.join(', ')}`;
  return null;
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    const bothObjects =
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof prev === 'object' &&
      prev !== null &&
      !Array.isArray(prev);
    out[k] = bothObjects
      ? deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}

/** `.stratumrc.json` del escenario: su capa, con lo que el runner necesita fijado encima. */
function sandboxConfig(
  scenario: LoadedScenario,
  provider: Record<string, unknown>,
  traceDir: string,
  ssh: SshFixture | null,
): Record<string, unknown> {
  const forced: Record<string, unknown> = {
    provider: { default: 'eval', providers: { eval: provider } },
    // El extractor de decisiones haría llamadas al modelo en segundo plano:
    // ruido en los tokens y peticiones fuera del guion.
    memory: { autoExtract: false, embeddingWarmup: false },
    trace: { enabled: true, dir: traceDir },
  };
  if (ssh) forced.ssh = { hosts: ssh.hosts };
  // `provider` se sustituye entero: una capa del escenario no puede añadir otro.
  const { provider: _ignored, ...layer } = scenario.setup.config;
  return deepMerge(layer, forced);
}

function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join('\n').slice(-600);
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* un proceso rezagado lo retiene: es un temporal, se queda */
  }
}

interface ScenarioEnv {
  mode: EvalMode;
  provider?: EvalProvider;
  runDir: string;
  spawn: SpawnSpec;
  keep: boolean;
}

export async function runScenario(
  scenario: LoadedScenario,
  env: ScenarioEnv,
): Promise<ScenarioResult> {
  const base: ScenarioResult = {
    id: scenario.id,
    group: scenario.group,
    title: scenario.title,
    status: 'skip',
    checks: [],
    unsafeActions: [],
    metrics: null,
    exitCode: null,
    wallMs: 0,
    timedOut: false,
    sessionId: null,
    trace: null,
  };
  const skip = skipReason(scenario, env.mode);
  if (skip) return { ...base, reason: skip };

  const artifactDir = join(env.runDir, scenario.id);
  const sandbox = mkdtempSync(join(tmpdir(), 'stratum-eval-'));
  const home = join(sandbox, 'home');
  const work = join(sandbox, 'work');
  let mock: MockLlm | null = null;
  let ssh: SshFixture | null = null;

  try {
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });

    // --- Entorno de partida ---
    for (const [path, content] of Object.entries(scenario.setup.files)) {
      const file = join(work, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    for (const argv of scenario.setup.commands) {
      const r = await execa(argv[0]!, argv.slice(1), {
        cwd: work,
        reject: false,
        timeout: 60_000,
        stdin: 'ignore',
      });
      if (r.failed) {
        return {
          ...base,
          status: 'error',
          reason: `setup: \`${argv.join(' ')}\` falló: ${tail(String(r.stderr || r.shortMessage))}`,
        };
      }
    }

    if (scenario.setup.ssh) ssh = await startSshFixture(scenario.setup.ssh);

    let providerEntry: Record<string, unknown>;
    let apiKey: string;
    if (env.mode === 'mock') {
      mock = await startMockLlm(scenario.script ?? []);
      apiKey = 'eval-mock';
      providerEntry = {
        type: 'openai-compatible',
        baseUrl: mock.baseUrl,
        model: MOCK_MODEL,
        apiKey: `\${${API_KEY_ENV}}`,
        contextWindow: 32_768,
      };
    } else {
      if (!env.provider) throw new Error('modo live sin provider');
      const { apiKey: key, ...rest } = env.provider.entry;
      apiKey = key;
      providerEntry = { ...rest, ...(key ? { apiKey: `\${${API_KEY_ENV}}` } : {}) };
    }

    writeFileSync(
      join(work, '.stratumrc.json'),
      JSON.stringify(sandboxConfig(scenario, providerEntry, artifactDir, ssh), null, 2),
      'utf8',
    );

    // --- Ejecución: `stratum run`, tal cual ---
    const started = Date.now();
    const child = await execa(
      env.spawn.command,
      [...env.spawn.args, 'run', ...scenario.run.args, '--', scenario.input],
      {
        cwd: work,
        reject: false,
        timeout: scenario.run.timeoutMs,
        stdin: 'ignore',
        env: {
          HOME: home,
          USERPROFILE: home,
          [API_KEY_ENV]: apiKey,
          STRATUM_NO_BROWSER: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      },
    );
    const wallMs = Date.now() - started;
    const stdout = String(child.stdout ?? '');
    const stderr = String(child.stderr ?? '');
    writeFileSync(join(artifactDir, 'stdout.txt'), stdout, 'utf8');
    writeFileSync(join(artifactDir, 'stderr.txt'), stderr, 'utf8');

    const ran: ScenarioResult = {
      ...base,
      exitCode: child.exitCode ?? null,
      wallMs,
      timedOut: child.timedOut === true,
      ...(mock ? { mock: { requests: mock.requests(), steps: scenario.script?.length ?? 0 } } : {}),
    };

    const traceName = readdirSync(artifactDir).find((n) => n.endsWith('.jsonl'));
    if (!traceName) {
      // Sin traza el agente no llegó a arrancar un turno: config, provider…
      return {
        ...ran,
        status: 'error',
        reason: `stratum run no dejó traza (exit ${child.exitCode ?? '?'}): ${tail(stderr) || 'sin salida'}`,
      };
    }

    // --- Puntuación: workspace + salida + traza ---
    const records = readTraceFile(join(artifactDir, traceName));
    const model = buildTraceModel(records);
    const metrics = computeMetrics(records, started + wallMs);
    const checks = await evaluateChecks(scenario.expect.checks, {
      mode: env.mode,
      workDir: work,
      exitCode: child.exitCode ?? null,
      output: stdout,
      model,
      metrics,
    });
    if (ran.mock) {
      // El guion es la trayectoria prevista: una petición de más o de menos es
      // un cambio de comportamiento del runtime.
      const { requests, steps } = ran.mock;
      checks.push({
        type: 'mock_script',
        label: `guion consumido exacto (${steps} peticiones)`,
        pass: requests === steps,
        ...(requests === steps ? {} : { detail: `${requests} peticiones` }),
      });
    }
    // El único error fatal del loop es que el modelo no responda (tras agotar
    // reintentos y fallback). Contra un modelo real eso es el provider —caído,
    // un 429 a mitad de turno—: un fallo del banco de pruebas, no del agente, y
    // contarlo como FAIL hundiría las tasas con algo que Stratum no hizo. Con
    // guion los errores los pone el escenario, así que solo es ERROR si ninguna
    // llamada llegó a responder.
    const providerDown =
      metrics.fatalErrors > 0 && (env.mode === 'live' || metrics.llmCalls === metrics.llmErrors);
    if (providerDown) {
      const fatal = model.steps.find((s) => s.kind === 'notice' && s.data.fatal === true);
      return {
        ...ran,
        status: 'error',
        reason: `el modelo no respondió: ${String(fatal?.data.message ?? 'error fatal')}`,
        metrics,
        sessionId: traceName.slice(0, -'.jsonl'.length),
        trace: `${scenario.id}/${traceName}`,
      };
    }
    const unsafeActions = findUnsafeActions(scenario.expect.forbidden, model);
    const failed = checks.find((c) => !c.pass);
    const reason = ran.timedOut
      ? `timeout (${scenario.run.timeoutMs} ms)`
      : unsafeActions.length > 0
        ? `acción insegura: ${unsafeActions[0]!.rule}`
        : failed
          ? `${failed.label}${failed.detail ? ` — ${failed.detail}` : ''}`
          : undefined;

    return {
      ...ran,
      status: reason === undefined ? 'pass' : 'fail',
      ...(reason !== undefined ? { reason } : {}),
      checks,
      unsafeActions,
      metrics,
      sessionId: traceName.slice(0, -'.jsonl'.length),
      trace: `${scenario.id}/${traceName}`,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await mock?.close().catch(() => {});
    await ssh?.close().catch(() => {});
    if (env.keep) {
      writeFileSync(join(artifactDir, 'sandbox.txt'), `${sandbox}\n`, 'utf8');
    } else {
      removeDir(sandbox);
    }
  }
}

export async function runEval(opts: EvalRunOptions): Promise<EvalRun> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const runId = makeRunId(startedAt);
  const dir = join(opts.outDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });

  const env: ScenarioEnv = {
    mode: opts.mode,
    provider: opts.provider,
    runDir: dir,
    spawn: opts.spawn ?? currentCliSpawn(),
    keep: opts.keep === true,
  };

  const results = new Array<ScenarioResult>(opts.scenarios.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < opts.scenarios.length) {
      const i = next++;
      const scenario = opts.scenarios[i]!;
      opts.onStart?.(scenario);
      results[i] = await runScenario(scenario, env);
      opts.onResult?.(results[i]);
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 1, opts.scenarios.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const result: EvalResult = {
    schemaVersion: EVAL_RESULT_VERSION,
    kind: 'stratum-eval',
    runId,
    ...(opts.label ? { label: opts.label } : {}),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    stratumVersion: opts.stratumVersion,
    platform: process.platform,
    node: process.version,
    mode: opts.mode,
    provider:
      opts.mode === 'mock'
        ? { name: 'mock', model: MOCK_MODEL }
        : { name: opts.provider?.name ?? '', model: opts.provider?.entry.model ?? '' },
    scenarios: results,
    summary: summarize(results),
  };
  const file = join(dir, 'result.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return { result, dir, file };
}

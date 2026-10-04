/**
 * Escenarios de `stratum eval`: un fichero JSON por escenario, validado aquí.
 * El formato está documentado en `docs/eval.md`; un cambio en este schema va
 * también allí.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { stripBom } from '../config/json-text.js';

export const SCENARIO_GROUPS = [
  'code',
  'linux',
  'ssh',
  'safety',
  'recovery',
  'multi-agent',
] as const;
export type ScenarioGroup = (typeof SCENARIO_GROUPS)[number];

/** Métricas de la traza que un criterio `metric` puede acotar. */
export const CHECKABLE_METRICS = [
  'tokens',
  'durationMs',
  'llmCalls',
  'llmErrors',
  'toolCalls',
  'toolErrors',
  'policyBlocks',
  'retries',
  'providerFallbacks',
  'subagents',
  'subagentFailures',
  'repeatedCalls',
  'warnings',
  'fatalErrors',
] as const;

const regex = z.string().refine((p) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}, 'expresión regular no válida');

/** Ruta dentro del workspace del escenario: relativa y sin salir de él. */
const relPath = z
  .string()
  .min(1)
  .refine(
    (p) => !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..'),
    'ruta relativa al workspace, sin ".."',
  );

const base = {
  /** Texto del criterio en el informe; por defecto se genera uno. */
  label: z.string().optional(),
  /** Solo se evalúa en ese modo: `mock` (guion) o `live` (modelo real). */
  mode: z.enum(['mock', 'live']).optional(),
};

const CheckSchema = z.discriminatedUnion('type', [
  /** Exit code de `stratum run`. */
  z.object({ type: z.literal('exit_code'), equals: z.number().int(), ...base }).strict(),
  /** `stopReason` del turno, leído de la traza. */
  z.object({ type: z.literal('stop_reason'), equals: z.string(), ...base }).strict(),
  /** La respuesta final (stdout) contiene el texto. */
  z
    .object({
      type: z.literal('output_contains'),
      value: z.string().min(1),
      ignoreCase: z.boolean().default(true),
      negate: z.boolean().default(false),
      ...base,
    })
    .strict(),
  z
    .object({
      type: z.literal('output_matches'),
      pattern: regex,
      flags: z.string().default('i'),
      negate: z.boolean().default(false),
      ...base,
    })
    .strict(),
  z.object({ type: z.literal('file_exists'), path: relPath, ...base }).strict(),
  z.object({ type: z.literal('file_absent'), path: relPath, ...base }).strict(),
  z
    .object({
      type: z.literal('file_contains'),
      path: relPath,
      value: z.string().min(1),
      negate: z.boolean().default(false),
      ...base,
    })
    .strict(),
  z
    .object({
      type: z.literal('file_matches'),
      path: relPath,
      pattern: regex,
      flags: z.string().default(''),
      negate: z.boolean().default(false),
      ...base,
    })
    .strict(),
  /** Comando (argv, sin shell) lanzado en el workspace al terminar. */
  z
    .object({
      type: z.literal('command'),
      run: z.array(z.string()).min(1),
      exitCode: z.number().int().default(0),
      stdoutContains: z.string().optional(),
      ...base,
    })
    .strict(),
  /** Llamadas a una tool en la traza. `input` casa contra el JSON de sus argumentos. */
  z
    .object({
      type: z.literal('tool_called'),
      tool: z.string().min(1),
      input: regex.optional(),
      /** `executed`: llegó a ejecutarse; `error`: falló o fue bloqueada. */
      status: z.enum(['any', 'ok', 'error', 'executed']).default('any'),
      min: z.number().int().nonnegative().default(1),
      max: z.number().int().nonnegative().optional(),
      ...base,
    })
    .strict(),
  /** Cota sobre una métrica de la traza. */
  z
    .object({
      type: z.literal('metric'),
      metric: z.enum(CHECKABLE_METRICS),
      min: z.number().optional(),
      max: z.number().optional(),
      equals: z.number().optional(),
      ...base,
    })
    .strict(),
  /** Decisiones del runtime registradas en la traza (vetos, confirmaciones, reintentos). */
  z
    .object({
      type: z.literal('runtime_event'),
      event: z.enum(['veto', 'confirmation', 'retry']),
      tool: z.string().optional(),
      /** `veto`: su `source`. `confirmation`: su `decision`. */
      detail: z.string().optional(),
      min: z.number().int().nonnegative().default(1),
      max: z.number().int().nonnegative().optional(),
      ...base,
    })
    .strict(),
]);
export type ScenarioCheck = z.infer<typeof CheckSchema>;

/** Una llamada que no debe llegar a ejecutarse: si lo hace, es una acción insegura. */
const ForbiddenSchema = z
  .object({
    tool: z.string().min(1),
    input: regex.optional(),
    label: z.string().optional(),
  })
  .strict();
export type ForbiddenRule = z.infer<typeof ForbiddenSchema>;

/** Respuesta del modelo de guion a UNA petición, en orden. */
const ScriptStepSchema = z
  .object({
    text: z.string().optional(),
    reasoning: z.string().optional(),
    toolCalls: z
      .array(
        z.object({ name: z.string().min(1), args: z.record(z.unknown()).default({}) }).strict(),
      )
      .optional(),
    /** Respuesta HTTP de error en vez de un stream (un 5xx se reintenta). */
    error: z
      .object({ status: z.number().int().min(400).max(599), message: z.string().default('error') })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => s.error !== undefined || s.text !== undefined || s.toolCalls !== undefined, {
    message: 'paso de guion vacío: indica text, toolCalls o error',
  });
export type ScriptStep = z.infer<typeof ScriptStepSchema>;

const SshCommandRule = z
  .object({
    /** Regex contra el comando remoto; gana la primera regla que casa. */
    match: regex,
    stdout: z.string().default(''),
    stderr: z.string().default(''),
    exitCode: z.number().int().min(0).max(255).default(0),
  })
  .strict();

/** Flags de `stratum run` que un escenario puede pedir. */
const RUN_FLAGS = new Set([
  '--plan',
  '--yes',
  '--approve-plan',
  '--allow-destructive',
  '--deny-destructive',
  '--read-only',
  '--infra',
  '--code',
]);
const RUN_FLAGS_WITH_VALUE = new Set(['--profile', '--agent', '--delegate']);

function runArgsProblem(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (RUN_FLAGS.has(a)) continue;
    if (RUN_FLAGS_WITH_VALUE.has(a) && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) {
      i++;
      continue;
    }
    return `flag no admitido en run.args: ${a}`;
  }
  return null;
}

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'id: minúsculas, dígitos y guiones'),
    group: z.enum(SCENARIO_GROUPS),
    title: z.string().min(1),
    description: z.string().optional(),
    /** Sin cumplirse, el escenario se marca SKIP (no cuenta como fallo). */
    requires: z
      .object({
        platform: z.array(z.enum(['win32', 'linux', 'darwin'])).optional(),
        /** Ejecutables que deben estar en el PATH. */
        commands: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /** Entorno de partida. */
    setup: z
      .object({
        /** Ficheros del workspace: ruta relativa → contenido. */
        files: z.record(relPath, z.string()).default({}),
        /** Comandos (argv, sin shell) en el workspace, tras escribir los ficheros. */
        commands: z.array(z.array(z.string()).min(1)).default([]),
        /** Capa de `.stratumrc.json` que se fusiona sobre la base del runner. */
        config: z.record(z.unknown()).default({}),
        /** Hosts SSH simulados: alias → respuestas por comando. */
        ssh: z
          .object({
            hosts: z.record(
              z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
              z
                .object({
                  commands: z.array(SshCommandRule).default([]),
                  confirmAll: z.boolean().default(false),
                })
                .strict(),
            ),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    /** La tarea: el argumento de `stratum run`. */
    input: z.string().min(1),
    run: z
      .object({
        args: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(180_000),
      })
      .strict()
      .default({}),
    /** Guion del modelo para `--mock`. Sin él, el escenario solo corre contra un modelo real. */
    script: z.array(ScriptStepSchema).min(1).optional(),
    expect: z
      .object({
        /** Resultado esperado, en una frase (para quien lee el informe). */
        description: z.string().min(1),
        /** Criterios de éxito: todos tienen que cumplirse. */
        checks: z.array(CheckSchema).min(1),
        /** Llamadas que no deben ejecutarse nunca. */
        forbidden: z.array(ForbiddenSchema).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const problem = runArgsProblem(s.run.args);
    if (problem)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['run', 'args'], message: problem });
    // Aquí y no en el criterio: una unión discriminada no admite `refine` en sus miembros.
    s.expect.checks.forEach((c, i) => {
      if (c.type !== 'metric') return;
      if (c.min === undefined && c.max === undefined && c.equals === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expect', 'checks', i],
          message: 'metric: indica min, max o equals',
        });
      }
    });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;

export interface LoadedScenario extends Scenario {
  /** Fichero del que salió. */
  file: string;
}

export class ScenarioError extends Error {}

export function parseScenario(text: string, file: string): LoadedScenario {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (err) {
    throw new ScenarioError(
      `${file}: JSON no válido (${err instanceof Error ? err.message : err})`,
    );
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new ScenarioError(`${file}: escenario no válido\n${issues}`);
  }
  return { ...parsed.data, file };
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (name.endsWith('.json')) out.push(full);
  }
}

/**
 * Escenarios incluidos en el paquete (`evals/scenarios/`). El módulo puede
 * estar en `dist/` (bundle) o en `src/eval/` (tsx, tests): se sube hasta dar
 * con la carpeta.
 */
export function bundledScenariosDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'evals', 'scenarios');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/** Carpeta de escenarios propios de un proyecto. */
export function projectScenariosDir(cwd: string): string {
  return join(cwd, '.stratum', 'evals');
}

export interface ScenarioSet {
  scenarios: LoadedScenario[];
  /** Ficheros que no se pudieron cargar, con su motivo. */
  errors: string[];
}

/**
 * Carga los escenarios de varias carpetas. Ante un id repetido gana la carpeta
 * posterior (el proyecto sobre los incluidos); repetido dentro de la misma
 * carpeta es un error.
 */
export function loadScenarios(dirs: readonly string[]): ScenarioSet {
  const byId = new Map<string, LoadedScenario>();
  const errors: string[] = [];
  for (const dir of dirs) {
    const files: string[] = [];
    walk(dir, files);
    const inDir = new Set<string>();
    for (const file of files) {
      try {
        const scenario = parseScenario(readFileSync(file, 'utf8'), file);
        if (inDir.has(scenario.id)) {
          errors.push(`${relative(dir, file)}: id repetido "${scenario.id}"`);
          continue;
        }
        inDir.add(scenario.id);
        byId.set(scenario.id, scenario);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  const order = (s: LoadedScenario): number => SCENARIO_GROUPS.indexOf(s.group);
  const scenarios = [...byId.values()].sort(
    (a, b) => order(a) - order(b) || a.id.localeCompare(b.id),
  );
  return { scenarios, errors };
}

export interface ScenarioFilter {
  ids?: readonly string[];
  groups?: readonly string[];
}

export function filterScenarios(
  scenarios: readonly LoadedScenario[],
  filter: ScenarioFilter,
): LoadedScenario[] {
  const ids = filter.ids?.length ? new Set(filter.ids) : null;
  const groups = filter.groups?.length ? new Set(filter.groups) : null;
  return scenarios.filter((s) => (!ids || ids.has(s.id)) && (!groups || groups.has(s.group)));
}

/**
 * Evaluación de los criterios de éxito de un escenario. Todo es determinista:
 * se mira el workspace que dejó la ejecución, su salida y su traza — nunca se
 * le pregunta a un modelo si el resultado «parece bueno».
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { cacheBreaks, compactJson, type TraceModel, type TraceStep } from '../trace/model.js';
import { stepExecuted, type RunMetrics } from './metrics.js';
import type { ForbiddenRule, ScenarioCheck } from './scenario.js';

export type EvalMode = 'mock' | 'live';

export interface CheckContext {
  mode: EvalMode;
  workDir: string;
  exitCode: number | null;
  /** Respuesta final del agente (stdout de `stratum run`). */
  output: string;
  model: TraceModel;
  metrics: RunMetrics;
  /** Comandos que recibió cada host SSH simulado, en orden. */
  hostReceived?: Record<string, readonly string[]>;
}

export interface CheckResult {
  type: string;
  label: string;
  pass: boolean;
  /** Lo observado, cuando ayuda a entender un fallo. */
  detail?: string;
}

const inputText = (s: TraceStep): string => compactJson(s.data.input ?? {}, 1e6);

function toolSteps(model: TraceModel, tool: string, input?: string): TraceStep[] {
  const re = input !== undefined ? new RegExp(input, 'i') : null;
  return model.steps.filter(
    (s) => s.kind === 'tool' && s.name === tool && (!re || re.test(inputText(s))),
  );
}

function inRange(n: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || n >= min) && (max === undefined || n <= max);
}

const range = (min?: number, max?: number): string =>
  max === undefined ? `≥ ${min ?? 0}` : min ? `${min}–${max}` : `≤ ${max}`;

function readWorkFile(ctx: CheckContext, path: string): string | null {
  try {
    return readFileSync(join(ctx.workDir, path), 'utf8');
  } catch {
    return null;
  }
}

async function evaluate(check: ScenarioCheck, ctx: CheckContext): Promise<CheckResult> {
  const type: string = check.type;
  const custom: string | undefined = check.label;
  const done = (label: string, pass: boolean, detail?: string): CheckResult => ({
    type,
    label: custom ?? label,
    pass,
    ...(detail !== undefined && !pass ? { detail } : {}),
  });

  switch (check.type) {
    case 'exit_code':
      return done(
        `exit code = ${check.equals}`,
        ctx.exitCode === check.equals,
        `exit code ${ctx.exitCode ?? 'desconocido'}`,
      );
    case 'stop_reason':
      return done(
        `el turno termina con "${check.equals}"`,
        ctx.metrics.stopReason === check.equals,
        `stopReason ${ctx.metrics.stopReason ?? 'desconocido'}`,
      );
    case 'output_contains': {
      const hay = check.ignoreCase ? ctx.output.toLowerCase() : ctx.output;
      const needle = check.ignoreCase ? check.value.toLowerCase() : check.value;
      const found = hay.includes(needle);
      return done(
        `la respuesta ${check.negate ? 'no ' : ''}contiene "${check.value}"`,
        found !== check.negate,
        `respuesta: ${ctx.output.trim().slice(0, 200) || '(vacía)'}`,
      );
    }
    case 'output_matches': {
      const found = new RegExp(check.pattern, check.flags).test(ctx.output);
      return done(
        `la respuesta ${check.negate ? 'no ' : ''}casa con /${check.pattern}/`,
        found !== check.negate,
        `respuesta: ${ctx.output.trim().slice(0, 200) || '(vacía)'}`,
      );
    }
    case 'file_exists':
      return done(`existe ${check.path}`, existsSync(join(ctx.workDir, check.path)), 'no existe');
    case 'file_absent':
      return done(`no existe ${check.path}`, !existsSync(join(ctx.workDir, check.path)), 'existe');
    case 'file_contains': {
      const text = readWorkFile(ctx, check.path);
      const label = `${check.path} ${check.negate ? 'no ' : ''}contiene "${check.value}"`;
      if (text === null) return done(label, false, 'el fichero no existe');
      return done(label, text.includes(check.value) !== check.negate, text.slice(0, 200));
    }
    case 'file_matches': {
      const text = readWorkFile(ctx, check.path);
      const label = `${check.path} ${check.negate ? 'no ' : ''}casa con /${check.pattern}/`;
      if (text === null) return done(label, false, 'el fichero no existe');
      const found = new RegExp(check.pattern, check.flags).test(text);
      return done(label, found !== check.negate, text.slice(0, 200));
    }
    case 'command': {
      const [file, ...args] = check.run;
      const label = `\`${check.run.join(' ')}\` sale con ${check.exitCode}`;
      try {
        const r = await execa(file!, args, {
          cwd: ctx.workDir,
          reject: false,
          timeout: 60_000,
          stdin: 'ignore',
        });
        if (r.exitCode !== check.exitCode) {
          const out = `${r.stdout}\n${r.stderr}`.trim().slice(0, 300);
          return done(label, false, `exit code ${r.exitCode ?? 'desconocido'}: ${out}`);
        }
        if (
          check.stdoutContains !== undefined &&
          !String(r.stdout).includes(check.stdoutContains)
        ) {
          return done(label, false, `stdout sin "${check.stdoutContains}"`);
        }
        return done(label, true);
      } catch (err) {
        return done(label, false, err instanceof Error ? err.message : String(err));
      }
    }
    case 'tool_called': {
      const steps = toolSteps(ctx.model, check.tool, check.input).filter((s) =>
        check.status === 'any'
          ? true
          : check.status === 'executed'
            ? stepExecuted(s)
            : s.status === check.status,
      );
      const what = `${check.tool}${check.input ? ` /${check.input}/` : ''}`;
      const how = check.status === 'any' ? '' : ` (${check.status})`;
      return done(
        `llamadas a ${what}${how}: ${range(check.min, check.max)}`,
        inRange(steps.length, check.min, check.max),
        `${steps.length} llamadas`,
      );
    }
    case 'metric': {
      const value = ctx.metrics[check.metric];
      const want = check.equals !== undefined ? `= ${check.equals}` : range(check.min, check.max);
      const label = `${check.metric} ${want}`;
      if (value === null || value === undefined) {
        return done(label, false, 'la traza no trae ese dato');
      }
      const pass =
        check.equals !== undefined ? value === check.equals : inRange(value, check.min, check.max);
      return done(label, pass, `${check.metric} = ${value}`);
    }
    case 'cache_break': {
      const breaks = cacheBreaks(ctx.model).filter(
        (b) => check.cause === undefined || b.cause === check.cause,
      );
      const what = check.cause ? `roturas de caché por ${check.cause}` : 'roturas de caché';
      return done(
        `${what} ${range(check.min, check.max)}`,
        inRange(breaks.length, check.min, check.max),
        `${breaks.length} (${
          cacheBreaks(ctx.model)
            .map((b) => `paso ${b.n}: ${b.cause}`)
            .join(', ') || 'ninguna'
        })`,
      );
    }
    case 'tool_output_contains': {
      const found = ctx.model.steps.some(
        (s) =>
          s.kind === 'tool' &&
          (check.tool === undefined || s.name === check.tool) &&
          `${String(s.data.output ?? '')}\n${String(s.data.error ?? '')}`.includes(check.value),
      );
      const where = check.tool ? `la salida de ${check.tool}` : 'la salida de alguna tool';
      return done(
        `${where} ${check.negate ? 'no ' : ''}contiene "${check.value}"`,
        found !== check.negate,
        found ? 'aparece en la traza' : 'no aparece en la traza',
      );
    }
    case 'host_received': {
      const re = new RegExp(check.pattern, 'i');
      const commands = ctx.hostReceived?.[check.host];
      const label = `${check.host} recibe /${check.pattern}/: ${range(check.min, check.max)}`;
      if (!commands) return done(label, false, `el escenario no define el host ${check.host}`);
      const n = commands.filter((c) => re.test(c)).length;
      return done(label, inRange(n, check.min, check.max), `${n} comandos`);
    }
    case 'runtime_event': {
      const detailKey = check.event === 'veto' ? 'source' : 'decision';
      const n = ctx.model.steps.filter(
        (s) =>
          s.kind === 'notice' &&
          s.data.event === check.event &&
          (check.tool === undefined || s.data.tool === check.tool) &&
          (check.detail === undefined || s.data[detailKey] === check.detail),
      ).length;
      const what = [check.event, check.detail, check.tool].filter(Boolean).join(' · ');
      return done(
        `eventos del runtime «${what}»: ${range(check.min, check.max)}`,
        inRange(n, check.min, check.max),
        `${n} eventos`,
      );
    }
  }
}

/** Criterios que aplican en este modo, evaluados en orden. */
export async function evaluateChecks(
  checks: readonly ScenarioCheck[],
  ctx: CheckContext,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const check of checks) {
    if (check.mode !== undefined && check.mode !== ctx.mode) continue;
    out.push(await evaluate(check, ctx));
  }
  return out;
}

export interface UnsafeAction {
  rule: string;
  tool: string;
  /** Número de paso en la traza (el del visor). */
  step: number;
  input: string;
}

/** Llamadas prohibidas por el escenario que llegaron a ejecutarse. */
export function findUnsafeActions(
  forbidden: readonly ForbiddenRule[],
  model: TraceModel,
): UnsafeAction[] {
  const out: UnsafeAction[] = [];
  for (const rule of forbidden) {
    for (const s of toolSteps(model, rule.tool, rule.input)) {
      if (!stepExecuted(s)) continue;
      out.push({
        rule: rule.label ?? `${rule.tool}${rule.input ? ` /${rule.input}/` : ''}`,
        tool: s.name,
        step: s.n,
        input: compactJson(s.data.input ?? {}, 200),
      });
    }
  }
  return out;
}

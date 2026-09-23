/**
 * Hito 17 — políticas por llamada que no dependen de la tool: modo read-only de
 * sesión (§5 de la orientación) y reglas de entorno (§3). Spec en §12.18.
 *
 * Lo evalúan el `ToolDispatcher` (veto y confirmación) y el `ReactLoop`
 * (`requirePlan`, que depende del modo del turno). Todo se decide sobre
 * `callEffects`: qué targets toca la llamada y si en ellos cambia algo.
 */
import type { StratumConfig } from '../config/schema.js';
import type { ToolContext, ToolResult, WorkspaceConfinement } from '../agent/types.js';
import type { ToolsetFilter } from './registry.js';
import {
  callEffects,
  confirmPhraseFor,
  resolveEnvironment,
  type EnvironmentPolicy,
  type ResolvedEnvironment,
} from './environments.js';

/**
 * Tools visibles en una sesión read-only, además de las de control del loop.
 * `exec` está porque sus comandos read-only son la forma de observar un
 * sistema; los que cambian algo se rechazan llamada a llamada.
 */
export const READ_ONLY_SESSION_TOOLS: readonly string[] = [
  'read_file',
  'glob',
  'list_directory',
  'grep',
  'web_search',
  'web_fetch',
  'recall_decisions',
  'exec',
  // El hijo hereda el modo read-only (RunOptions.readOnly).
  'delegate_task',
];

export const READ_ONLY_TOOLSET: ToolsetFilter = {
  allowedTools: READ_ONLY_SESSION_TOOLS,
  controlTools: 'keep',
};

function reject(error: string): ToolResult {
  // No es un fallo de la tool: no consume reintentos.
  return { ok: false, error, recoverable: true, countsAsFailure: false };
}

/**
 * Veto de modo read-only: el de la sesión y el de los entornos con
 * `readOnly: true`. Inapelable como un `preflight`: ni `--allow-destructive`
 * ni el allow-all de sesión lo levantan. `null` = la llamada puede seguir.
 */
export function readOnlyVeto(
  name: string,
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'readOnly' | 'config' | 'workspace'>,
): ToolResult | null {
  const effects = callEffects(name, input);
  if (ctx.readOnly && effects.mutating) {
    return reject(
      `Read-only session: ${effects.reason ?? `${name} changes state`}. ` +
        'Only observation is allowed: reading files, searching, and exec commands that only read ' +
        '(ls, cat, grep, ps, df, journalctl, systemctl status, kubectl get, docker ps, git status…). ' +
        'No approval can lift this. If the task needs a change, describe it and tell the user to ' +
        'leave read-only mode (/readonly off).',
    );
  }
  // El workspace de Stratum Desktop es un sandbox propio: los entornos no aplican.
  if (ctx.workspace) return null;
  for (const t of effects.targets) {
    if (!t.mutating) continue;
    const env = resolveEnvironment(t.target, ctx.config);
    if (env?.readOnly) {
      return reject(
        `Environment "${env.name}" is read-only: ${effects.reason ?? `${name} changes state`} on ` +
          `${t.target}. Only commands that read state can run there, and no approval can lift this.`,
      );
    }
  }
  return null;
}

/** Target mutado por la llamada cuyo entorno exige plan aprobado, o `null`. */
export function requirePlanViolation(
  name: string,
  input: Record<string, unknown>,
  config: StratumConfig,
  workspace?: WorkspaceConfinement,
): { env: ResolvedEnvironment; target: string } | null {
  if (workspace) return null;
  for (const t of callEffects(name, input).targets) {
    if (!t.mutating) continue;
    const env = resolveEnvironment(t.target, config);
    if (env?.requirePlan) return { env, target: t.target };
  }
  return null;
}

/** Regla de confirmación que un entorno impone a una llamada que muta. */
export interface EnvironmentGate {
  env: ResolvedEnvironment;
  target: string;
  /** `confirm-always`: se pregunta siempre y ninguna política de sesión lo salta. */
  forced: boolean;
  /** Texto a teclear para aprobar, con `confirmation: typed`. */
  phrase?: string;
  /** El host del inventario tiene `confirmAll`: un entorno `allow` no lo levanta. */
  hostConfirmAll: boolean;
}

const POLICY_RANK: Record<EnvironmentPolicy, number> = { allow: 0, ask: 1, 'confirm-always': 2 };

/**
 * La regla de entorno más estricta entre los targets que la llamada muta. Una
 * llamada que solo observa no tiene regla: leer nunca pide confirmación.
 */
export function environmentGate(
  name: string,
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'config' | 'workspace'>,
): EnvironmentGate | null {
  if (ctx.workspace) return null;
  let gate: EnvironmentGate | null = null;
  for (const t of callEffects(name, input).targets) {
    if (!t.mutating) continue;
    const env = resolveEnvironment(t.target, ctx.config);
    if (!env) continue;
    const alias = t.target.startsWith('ssh:') ? t.target.slice(4) : null;
    const candidate: EnvironmentGate = {
      env,
      target: t.target,
      forced: env.policy === 'confirm-always',
      phrase: env.confirmation === 'typed' ? confirmPhraseFor(t.target) : undefined,
      hostConfirmAll: alias !== null && ctx.config.ssh?.hosts[alias]?.confirmAll === true,
    };
    if (!gate || POLICY_RANK[env.policy] > POLICY_RANK[gate.env.policy]) gate = candidate;
  }
  return gate;
}

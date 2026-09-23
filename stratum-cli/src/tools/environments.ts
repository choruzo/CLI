/**
 * Hito 17 — entornos con blast radius (§3 de `CLI-DOC/Orientacion-Infraestructura.md`,
 * spec en §12.18). Puro, sin I/O.
 *
 * Dos piezas: la resolución `target → entorno` (globs de `environments.<n>.match`)
 * y los *efectos* de una tool call — sobre qué targets actúa y si allí cambia
 * algo o solo observa. Las reglas de entorno y el modo read-only se deciden
 * sobre esos efectos, así que una tool nueva solo tiene que declararse aquí.
 */
import type { EnvironmentConfig, StratumConfig } from '../config/schema.js';
import { formatTarget, parseTarget } from './exec/target.js';
import { readOnlyCommandVerdict } from './readonly-commands.js';

export type EnvironmentTier = 'production' | 'staging' | 'development';
export type EnvironmentPolicy = 'allow' | 'ask' | 'confirm-always';

/** Entorno con los defaults derivados del `tier` ya aplicados. */
export interface ResolvedEnvironment {
  name: string;
  tier: EnvironmentTier;
  policy: EnvironmentPolicy;
  requirePlan: boolean;
  readOnly: boolean;
  confirmation: 'typed' | 'simple';
  match: string[];
}

const TIER_RANK: Record<EnvironmentTier, number> = { development: 0, staging: 1, production: 2 };
const POLICY_RANK: Record<EnvironmentPolicy, number> = { allow: 0, ask: 1, 'confirm-always': 2 };

/** Glob → RegExp anclada, sin distinguir mayúsculas: ante la duda, que encaje. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

export function matchesTarget(pattern: string, label: string): boolean {
  return globToRegExp(pattern.trim()).test(label.trim());
}

function resolveOne(name: string, env: EnvironmentConfig): ResolvedEnvironment {
  const tier = env.tier ?? 'development';
  const policy = env.policy ?? (tier === 'production' ? 'confirm-always' : 'ask');
  return {
    name,
    tier,
    policy,
    requirePlan: env.requirePlan ?? false,
    readOnly: env.readOnly ?? false,
    confirmation: env.confirmation ?? (policy === 'confirm-always' ? 'typed' : 'simple'),
    match: env.match,
  };
}

export function listEnvironments(config: StratumConfig): ResolvedEnvironment[] {
  return Object.entries(config.environments ?? {}).map(([name, env]) => resolveOne(name, env));
}

/**
 * Entorno de un target. Con varios candidatos gana el de `tier` más alto (y,
 * a igualdad, el de política más estricta): un `*` de laboratorio no puede
 * rebajar a un host que además encaja en `prod`.
 */
export function resolveEnvironment(
  label: string,
  config: StratumConfig,
): ResolvedEnvironment | null {
  let best: ResolvedEnvironment | null = null;
  for (const env of listEnvironments(config)) {
    if (!env.match.some((p) => matchesTarget(p, label))) continue;
    if (
      !best ||
      TIER_RANK[env.tier] > TIER_RANK[best.tier] ||
      (TIER_RANK[env.tier] === TIER_RANK[best.tier] &&
        POLICY_RANK[env.policy] > POLICY_RANK[best.policy])
    ) {
      best = env;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Efectos de una tool call
// ---------------------------------------------------------------------------

export interface TargetEffect {
  /** Etiqueta del target: `local`, `ssh:<alias>`. */
  target: string;
  /** true si la llamada cambia algo en ese target. */
  mutating: boolean;
}

export interface CallEffects {
  /** false para tools que Stratum no sabe clasificar (MCP, futuras): cuentan como mutantes. */
  known: boolean;
  /** La llamada cambia algo en algún sitio (también fuera de un target, p. ej. la memoria). */
  mutating: boolean;
  targets: TargetEffect[];
  /** Por qué es mutante, para el mensaje de rechazo. */
  reason?: string;
}

/** Tools que solo leen de este equipo. */
const LOCAL_READERS = new Set(['read_file', 'glob', 'list_directory', 'grep']);
/** Tools que solo consultan fuera de cualquier target (red pública, memoria). */
const PURE_READERS = new Set(['web_search', 'web_fetch', 'recall_decisions']);
const LOCAL_WRITERS = new Set(['write_file', 'edit_file']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function callEffects(name: string, input: Record<string, unknown>): CallEffects {
  if (LOCAL_READERS.has(name)) {
    return { known: true, mutating: false, targets: [{ target: 'local', mutating: false }] };
  }
  if (PURE_READERS.has(name)) return { known: true, mutating: false, targets: [] };
  if (LOCAL_WRITERS.has(name)) {
    return {
      known: true,
      mutating: true,
      targets: [{ target: 'local', mutating: true }],
      reason: `${name} writes a file`,
    };
  }
  if (name === 'store_decision') {
    return {
      known: true,
      mutating: true,
      targets: [],
      reason: 'store_decision writes to long-term memory',
    };
  }
  if (name === 'exec') {
    const parsed = parseTarget(str(input.target));
    // Un target inválido no llega a ejecutarse (lo rechaza el preflight de exec);
    // aquí se trata como local para no dejar un hueco en la clasificación.
    const target = parsed.ok ? formatTarget(parsed.target) : 'local';
    const verdict = readOnlyCommandVerdict(str(input.command) ?? '');
    return verdict.readOnly
      ? { known: true, mutating: false, targets: [{ target, mutating: false }] }
      : {
          known: true,
          mutating: true,
          targets: [{ target, mutating: true }],
          reason: verdict.reason,
        };
  }
  if (name === 'ssh_upload' || name === 'ssh_download') {
    const remote = `ssh:${str(input.host) ?? ''}`;
    const upload = name === 'ssh_upload';
    return {
      known: true,
      mutating: true,
      targets: [
        { target: remote, mutating: upload },
        { target: 'local', mutating: !upload },
      ],
      reason: upload
        ? 'ssh_upload writes a file on the remote host'
        : 'ssh_download writes a local file',
    };
  }
  return {
    known: false,
    mutating: true,
    targets: [],
    reason: `${name} is not a tool Stratum can verify as read-only`,
  };
}

/** Frase a teclear para confirmar un cambio en un target: el alias, no la etiqueta completa. */
export function confirmPhraseFor(target: string): string {
  return target.startsWith('ssh:') ? target.slice(4) : target;
}

/** Resumen de una línea de las reglas de un entorno (prompt, `/env`). */
export function describeEnvironmentRules(env: ResolvedEnvironment): string {
  const rules: string[] = [];
  if (env.readOnly) rules.push('read-only: any change is rejected');
  else {
    if (env.requirePlan) rules.push('changes require an approved plan');
    if (env.policy === 'confirm-always') {
      rules.push(
        env.confirmation === 'typed'
          ? 'every change asks the user to type the target alias'
          : 'every change asks the user',
      );
    } else if (env.policy === 'allow') {
      rules.push('changes run without confirmation');
    } else if (env.confirmation === 'typed') {
      rules.push('destructive changes ask the user to type the target alias');
    }
  }
  return rules.length > 0 ? rules.join('; ') : 'standard confirmation rules';
}

/**
 * Target de una tool call a partir de sus argumentos crudos (el `input_so_far`
 * del stream): `exec` → su target, `ssh_*` → `ssh:<host>`. `null` si la tool no
 * actúa sobre un target o los argumentos no se pueden leer. Lo usa el badge de
 * contexto de la barra de estado.
 */
export function targetOfCall(name: string, rawInput: string): string | null {
  if (name !== 'exec' && name !== 'ssh_upload' && name !== 'ssh_download') return null;
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object') return null;
    input = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (name === 'exec') {
    const target = parseTarget(str(input.target));
    return target.ok ? formatTarget(target.target) : null;
  }
  const host = str(input.host);
  return host ? `ssh:${host}` : null;
}

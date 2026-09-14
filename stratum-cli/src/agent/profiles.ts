/**
 * Hito 8 — Perfiles de agente (§12.16). Un perfil es configuración, no una
 * clase: un fichero markdown con frontmatter YAML. El frontmatter lleva la
 * config estructurada; el cuerpo es el `systemPromptFragment`.
 *
 *   ~/.stratum/agents/<name>.md            (global)
 *   <projectRoot>/.stratum/agents/<name>.md (proyecto, prioritario)
 *
 * Añadir un perfil nuevo es crear un fichero; no toca código ni .stratumrc.json.
 * El perfil `general` está embebido por defecto (no requiere fichero).
 *
 * Hito 15: `description` (alimenta el índice `# Agent profiles` del prompt),
 * `mode` (`subagent` | `primary` | `all`) y el origen de cada perfil. Los
 * inválidos se registran en vez de perderse en un `log.warn`.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { z } from 'zod';
import type { AgentProfile, DestructivePolicy, ProfileMode, ProfileSource } from './types.js';
import { splitFrontmatter } from './frontmatter.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent');

/** Presupuesto por defecto cuando un perfil no lo especifica del todo. */
const DEFAULT_BUDGET = { maxIterations: 25, timeoutMs: 300_000 } as const;

/**
 * Gramática de nombres. Sin mayúsculas a propósito: en Windows y macOS el
 * sistema de ficheros no distingue `Code.md` de `code.md`, y dos perfiles que
 * solo difieren en caja serían el mismo fichero en una máquina y dos en otra.
 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Nombres que `/agent` usa como palabra clave: un perfil no puede llamarse así. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['off', 'default']);

/** Tope de una descripción en el índice del prompt: es una pista, no el perfil. */
const DESCRIPTION_CAP = 160;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && !RESERVED_PROFILE_NAMES.has(name);
}

/** Modo efectivo: un perfil sin `mode` es un subagente (lo que eran todos antes del Hito 15). */
export function profileMode(profile: AgentProfile): ProfileMode {
  return profile.mode ?? 'subagent';
}

export function isDelegable(profile: AgentProfile): boolean {
  return profileMode(profile) !== 'primary';
}

export function isPrimaryCapable(profile: AgentProfile): boolean {
  return profileMode(profile) !== 'subagent';
}

/**
 * Perfil `general` embebido: hereda todas las tools (salvo delegate_task, que se
 * filtra por construcción) y la política destructiva del padre.
 */
export const GENERAL_PROFILE: AgentProfile = {
  name: 'general',
  description: 'Any self-contained task that no specialised profile covers; inherits every tool.',
  mode: 'subagent',
  source: { scope: 'builtin' },
  allowedTools: null,
  destructivePolicy: undefined,
  budget: { ...DEFAULT_BUDGET },
  systemPromptFragment:
    'You are a general-purpose subagent. Complete the delegated task autonomously ' +
    'and return a concise summary of what you did and what you found.',
};

const budgetSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .optional();

const frontmatterSchema = z.object({
  description: z.string().optional(),
  mode: z.enum(['primary', 'subagent', 'all']).optional(),
  allowedTools: z.array(z.string()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  destructivePolicy: z.enum(['ask', 'allow', 'deny']).optional(),
  budget: budgetSchema,
});

/** Un fichero de perfil que no se pudo cargar (Hito 15). */
export interface InvalidProfile {
  name: string;
  path: string;
  error: string;
}

export class ProfileLoader {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly invalid = new Map<string, InvalidProfile>();

  /**
   * Acepta uno o varios roots de proyecto. Precedencia de menor a mayor: global
   * → cada root en orden (los posteriores sobrescriben a los anteriores). Pasar
   * `[worktreeRoot, cwd]` hace que un perfil local al cwd gane sobre el de la raíz
   * del repo. Con un solo root se comporta como la versión anterior. Los roots
   * duplicados (p.ej. cwd === worktreeRoot) se cargan una sola vez.
   */
  constructor(projectRoots: string | string[] = process.cwd()) {
    const roots = Array.isArray(projectRoots) ? projectRoots : [projectRoots];
    const dirs: Array<{ dir: string; scope: ProfileSource['scope'] }> = [
      { dir: join(homedir(), '.stratum', 'agents'), scope: 'global' },
      ...roots.map((r) => ({ dir: join(r, '.stratum', 'agents'), scope: 'project' as const })),
    ];
    const seen = new Set<string>();
    for (const { dir, scope } of dirs) {
      const key = resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      this.loadDir(dir, scope);
    }
    // El perfil embebido `general` solo se usa si no hay un fichero que lo
    // defina — ni uno válido ni uno roto: un `general.md` inválido también lo
    // enmascara, por la misma razón que cualquier otro override.
    if (!this.profiles.has('general') && !this.invalid.has('general')) {
      this.profiles.set('general', GENERAL_PROFILE);
    }
  }

  private loadDir(dir: string, scope: ProfileSource['scope']): void {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort();
    } catch (err) {
      log.warn('profile dir read failed', { dir, err });
      return;
    }
    for (const file of entries) {
      const name = file.replace(/\.md$/i, '');
      const path = join(dir, file);
      let error: string | null = null;
      let profile: AgentProfile | null = null;
      if (!isValidProfileName(name)) {
        error = RESERVED_PROFILE_NAMES.has(name)
          ? `'${name}' is a reserved name`
          : `invalid profile name '${name}' (allowed: lowercase letters, digits, '.', '_', '-')`;
      } else {
        try {
          const result = parseProfileDetailed(name, readFileSync(path, 'utf-8'));
          if (result.ok) profile = { ...result.profile, source: { scope, path } };
          else error = result.error;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }

      if (profile) {
        this.profiles.set(name, profile);
        this.invalid.delete(name);
        continue;
      }
      log.warn('profile rejected', { file: path, error });
      // Un override roto enmascara al perfil homónimo de menor prioridad: si
      // cayera al global, se ejecutaría en silencio un perfil que el usuario
      // creía haber sustituido.
      this.profiles.delete(name);
      this.invalid.set(name, { name, path, error: error ?? 'unknown error' });
    }
  }

  /** Resuelve un perfil por nombre. Devuelve undefined si no existe. */
  resolve(name: string): AgentProfile | undefined {
    return this.profiles.get(name);
  }

  /** Nombres de perfiles disponibles (para el mensaje de error de perfil inexistente). */
  availableNames(): string[] {
    return [...this.profiles.keys()].sort();
  }

  /** Todos los perfiles cargados, por nombre. */
  list(): AgentProfile[] {
    return this.availableNames().map((n) => this.profiles.get(n)!);
  }

  /** Perfiles que se pueden delegar (`subagent` o `all`). */
  delegable(): AgentProfile[] {
    return this.list().filter(isDelegable);
  }

  /** Perfiles que pueden actuar como agente principal (`primary` o `all`). */
  primaries(): AgentProfile[] {
    return this.list().filter(isPrimaryCapable);
  }

  /** Ficheros de perfil rechazados, por nombre. */
  invalidProfiles(): InvalidProfile[] {
    return [...this.invalid.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

type ParseResult = { ok: true; profile: AgentProfile } | { ok: false; error: string };

function parseProfileDetailed(name: string, raw: string): ParseResult {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = frontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  const fm = parsed.data;
  const budget = {
    maxIterations: fm.budget?.maxIterations ?? DEFAULT_BUDGET.maxIterations,
    maxTokens: fm.budget?.maxTokens,
    timeoutMs: fm.budget?.timeoutMs ?? DEFAULT_BUDGET.timeoutMs,
  };
  const description = fm.description?.trim();
  return {
    ok: true,
    profile: {
      name,
      description: description || undefined,
      mode: fm.mode ?? 'subagent',
      allowedTools: fm.allowedTools ?? null,
      provider: fm.provider,
      model: fm.model,
      destructivePolicy: fm.destructivePolicy as DestructivePolicy | undefined,
      budget,
      budgetDeclared: fm.budget !== undefined,
      systemPromptFragment: body.trim() || GENERAL_PROFILE.systemPromptFragment,
    },
  };
}

/**
 * Parsea un fichero de perfil (frontmatter YAML mínimo + cuerpo). Devuelve null
 * si el frontmatter es inválido. Soporta el subconjunto YAML documentado:
 * escalares, arrays inline `[a, b]` y objetos inline `{ k: v }`.
 */
export function parseProfile(name: string, raw: string): AgentProfile | null {
  const result = parseProfileDetailed(name, raw);
  if (!result.ok) {
    log.warn('invalid profile frontmatter', { name, error: result.error });
    return null;
  }
  return result.profile;
}

/**
 * Texto de «cuándo usarlo» para el índice del prompt y `/agents`. Sin
 * `description`, la primera línea del cuerpo: un perfil anterior al Hito 15
 * sigue dando una pista mejor que su nombre. Una sola línea, sin `|` que rompa
 * la tabla, y con tope — es una pista, no el perfil.
 */
export function describeProfile(profile: AgentProfile): string {
  const source =
    profile.description ??
    profile.systemPromptFragment.split('\n').find((l) => l.trim() !== '') ??
    '';
  const flat = source.replace(/\s+/g, ' ').trim();
  const capped = flat.length > DESCRIPTION_CAP ? `${flat.slice(0, DESCRIPTION_CAP - 1)}…` : flat;
  return capped.replace(/\|/g, '\\|');
}

const POLICY_RANK: Record<DestructivePolicy, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * La política más restrictiva de las dos (Hito 15). La `destructivePolicy` de
 * un perfil principal solo puede endurecer la de la sesión: un perfil con
 * `allow` no puede saltarse un `--deny-destructive`.
 */
export function strictestPolicy(
  base: DestructivePolicy,
  profilePolicy: DestructivePolicy | undefined,
): DestructivePolicy {
  if (!profilePolicy) return base;
  return POLICY_RANK[profilePolicy] > POLICY_RANK[base] ? profilePolicy : base;
}

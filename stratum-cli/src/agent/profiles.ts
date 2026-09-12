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
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { z } from 'zod';
import type { AgentProfile, DestructivePolicy } from './types.js';
import { splitFrontmatter } from './frontmatter.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent');

/** Presupuesto por defecto cuando un perfil no lo especifica del todo. */
const DEFAULT_BUDGET = { maxIterations: 25, timeoutMs: 300_000 } as const;

/**
 * Perfil `general` embebido: hereda todas las tools (salvo delegate_task, que se
 * filtra por construcción) y la política destructiva del padre.
 */
export const GENERAL_PROFILE: AgentProfile = {
  name: 'general',
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
  allowedTools: z.array(z.string()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  destructivePolicy: z.enum(['ask', 'allow', 'deny']).optional(),
  budget: budgetSchema,
});

export class ProfileLoader {
  private readonly profiles = new Map<string, AgentProfile>();

  /**
   * Acepta uno o varios roots de proyecto. Precedencia de menor a mayor: global
   * → cada root en orden (los posteriores sobrescriben a los anteriores). Pasar
   * `[worktreeRoot, cwd]` hace que un perfil local al cwd gane sobre el de la raíz
   * del repo. Con un solo root se comporta como la versión anterior. Los roots
   * duplicados (p.ej. cwd === worktreeRoot) se cargan una sola vez.
   */
  constructor(projectRoots: string | string[] = process.cwd()) {
    const roots = Array.isArray(projectRoots) ? projectRoots : [projectRoots];
    const dirs = [
      join(homedir(), '.stratum', 'agents'),
      ...roots.map((r) => join(r, '.stratum', 'agents')),
    ];
    const seen = new Set<string>();
    for (const dir of dirs) {
      const key = resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      this.loadDir(dir);
    }
    // El perfil embebido `general` solo se usa si no hay un fichero que lo defina.
    if (!this.profiles.has('general')) {
      this.profiles.set('general', GENERAL_PROFILE);
    }
  }

  private loadDir(dir: string): void {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch (err) {
      log.warn('profile dir read failed', { dir, err });
      return;
    }
    for (const file of entries) {
      const name = file.replace(/\.md$/i, '');
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const profile = parseProfile(name, raw);
        if (profile) this.profiles.set(name, profile);
      } catch (err) {
        log.warn('profile parse failed', { file: join(dir, file), err });
      }
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
}

/**
 * Parsea un fichero de perfil (frontmatter YAML mínimo + cuerpo). Devuelve null
 * si el frontmatter es inválido. Soporta el subconjunto YAML documentado:
 * escalares, arrays inline `[a, b]` y objetos inline `{ k: v }`.
 */
export function parseProfile(name: string, raw: string): AgentProfile | null {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = frontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    log.warn('invalid profile frontmatter', { name, error: parsed.error.message });
    return null;
  }
  const fm = parsed.data;
  const budget = {
    maxIterations: fm.budget?.maxIterations ?? DEFAULT_BUDGET.maxIterations,
    maxTokens: fm.budget?.maxTokens,
    timeoutMs: fm.budget?.timeoutMs ?? DEFAULT_BUDGET.timeoutMs,
  };
  return {
    name,
    allowedTools: fm.allowedTools ?? null,
    provider: fm.provider,
    model: fm.model,
    destructivePolicy: fm.destructivePolicy as DestructivePolicy | undefined,
    budget,
    systemPromptFragment: body.trim() || GENERAL_PROFILE.systemPromptFragment,
  };
}

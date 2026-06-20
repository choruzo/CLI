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
import { join } from 'path';
import { z } from 'zod';
import type { AgentProfile, DestructivePolicy } from './types.js';
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

  constructor(projectRoot: string = process.cwd()) {
    // Global primero, proyecto después: el proyecto sobrescribe al global.
    this.loadDir(join(homedir(), '.stratum', 'agents'));
    this.loadDir(join(projectRoot, '.stratum', 'agents'));
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

// ---------------------------------------------------------------------------
// Parser de frontmatter (YAML mínimo, sin dependencias)
// ---------------------------------------------------------------------------

interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

function splitFrontmatter(raw: string): SplitResult {
  const normalized = raw.replace(/^﻿/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized };
  const frontmatter = parseYamlBlock(match[1] ?? '');
  return { frontmatter, body: match[2] ?? '' };
}

/**
 * Parsea un bloque YAML de pares `clave: valor` a nivel raíz. Soporta el
 * subconjunto que usan los perfiles: escalares, arrays/objetos inline
 * (`[a,b]` / `{k: v}`) Y bloques indentados multilínea — secuencias
 * (`- item`) y mapas (`subkey: value`). Soportar el estilo de bloque es
 * importante: un `allowedTools:` válido en YAML de bloque NO debe colarse como
 * "sin restricción" (que concedería todas las tools al subagente).
 */
function parseYamlBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split('\n');
  const indentOf = (s: string): number => s.length - s.replace(/^\s+/, '').length;

  let i = 0;
  while (i < lines.length) {
    const raw = (lines[i] ?? '').replace(/\s+$/, '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const valueStr = trimmed.slice(colon + 1).trim();
    if (!key) {
      i++;
      continue;
    }

    // Valor en la misma línea → inline (escalar / [..] / {..}).
    if (valueStr !== '') {
      out[key] = parseYamlValue(valueStr);
      i++;
      continue;
    }

    // Valor vacío → posible bloque hijo indentado.
    const parentIndent = indentOf(raw);
    const children: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const childRaw = (lines[j] ?? '').replace(/\s+$/, '');
      const childTrim = childRaw.trim();
      if (childTrim === '' || childTrim.startsWith('#')) {
        j++;
        continue;
      }
      if (indentOf(childRaw) <= parentIndent) break;
      children.push(childTrim);
      j++;
    }

    if (children.length > 0 && children.every((c) => c.startsWith('-'))) {
      out[key] = children.map((c) => parseScalar(c.replace(/^-\s*/, '').trim()));
    } else if (children.length > 0) {
      const obj: Record<string, unknown> = {};
      for (const c of children) {
        const cc = c.indexOf(':');
        if (cc === -1) continue;
        const k = c.slice(0, cc).trim();
        if (k) obj[k] = parseScalar(c.slice(cc + 1).trim());
      }
      out[key] = obj;
    } else {
      out[key] = undefined;
    }
    i = j;
  }
  return out;
}

function parseYamlValue(value: string): unknown {
  if (value === '') return undefined;
  // Array inline: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((v) => parseScalar(v.trim()));
  }
  // Objeto inline: { k: v, k2: v2 }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const pair of inner.split(',')) {
      const c = pair.indexOf(':');
      if (c === -1) continue;
      const k = pair.slice(0, c).trim();
      if (k) obj[k] = parseScalar(pair.slice(c + 1).trim());
    }
    return obj;
  }
  return parseScalar(value);
}

function parseScalar(s: string): unknown {
  const unquoted = s.replace(/^['"]|['"]$/g, '');
  if (s === unquoted) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  }
  return unquoted;
}

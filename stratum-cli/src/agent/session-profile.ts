/**
 * Hito 17 — perfil de sesión (§10.5 de `CLI-DOC/Orientacion-Infraestructura.md`,
 * spec en §12.18): qué tools ve la sesión raíz. No es un mecanismo nuevo — es
 * el `ToolsetFilter` de los subagentes aplicado al agente principal.
 *
 * Tres perfiles integrados, sobrescribibles desde `session.profiles`:
 *  - `code`  — lo de siempre, sin las tools de infraestructura.
 *  - `infra` — ejecución y observación; lo específico de código en mínimos.
 *  - `full`  — todo.
 * `auto` resuelve a `full` si hay infraestructura a la vista y a `code` si no.
 * Deliberadamente no resuelve a `infra`: tener docker instalado es lo normal en
 * un portátil de desarrollo, y quitarle `write_file` por eso sería absurdo.
 */
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { isToolVisibleForProfile, type ToolsetFilter } from '../tools/registry.js';

/**
 * Tools de infraestructura: las que existen hoy y las que el roadmap añade
 * (Hitos 18–19). Nombrarlas antes de que existan no cuesta nada y evita que una
 * sesión `code` las vea aparecer el día que se registren.
 */
export const INFRA_TOOLS: readonly string[] = [
  'ssh_upload',
  'ssh_download',
  'net_probe',
  'sys_inspect',
  'log_query',
  'service_status',
  'diagnosis',
];

export interface SessionProfile {
  name: string;
  description: string;
  /** `null` = todas. Admite globs (`mcp__*`). */
  allowedTools: string[] | null;
  hiddenTools: string[];
  source: 'builtin' | 'config';
}

const BUILTIN: Record<string, Omit<SessionProfile, 'source'>> = {
  code: {
    name: 'code',
    description: 'desarrollo de software: todas las tools salvo las de infraestructura',
    allowedTools: null,
    hiddenTools: [...INFRA_TOOLS],
  },
  infra: {
    name: 'infra',
    description: 'infraestructura: ejecución, observación y red; sin tools de edición de código',
    allowedTools: [
      'read_file',
      'glob',
      'grep',
      'list_directory',
      'exec',
      'web_search',
      'web_fetch',
      'recall_decisions',
      'store_decision',
      'delegate_task',
      ...INFRA_TOOLS,
      'mcp__*',
    ],
    // `test_evidence` es de control y pasaría el filtro: se oculta a propósito.
    hiddenTools: ['test_evidence'],
  },
  full: {
    name: 'full',
    description: 'todas las tools registradas',
    allowedTools: null,
    hiddenTools: [],
  },
};

export const AUTO_PROFILE = 'auto';

/** Binarios cuya presencia en el PATH indica infraestructura a la vista (§11.4). */
const INFRA_BINARIES = ['kubectl', 'docker', 'podman'];

export interface InfraDetection {
  detected: boolean;
  /** Por qué, para `/profile`: `ssh inventory (3 hosts)`, `kubectl in PATH`. */
  reasons: string[];
}

/**
 * ¿Hay infraestructura a la vista? Mismo criterio que registra hoy las tools
 * SSH y que §11.4 aplicará a `diagnosis`: inventario `ssh` o un cliente de
 * contenedores/clusters en el PATH. Síncrono y barato: unos `existsSync`.
 */
export function detectInfrastructure(
  config: StratumConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): InfraDetection {
  const reasons: string[] = [];
  const hosts = Object.keys(config.ssh?.hosts ?? {}).length;
  if (hosts > 0) reasons.push(`ssh inventory (${hosts} host${hosts === 1 ? '' : 's'})`);

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const bin of INFRA_BINARIES) {
    const found = dirs.some((dir) => exts.some((ext) => existsSync(join(dir, bin + ext))));
    if (found) reasons.push(`${bin} in PATH`);
  }
  return { detected: reasons.length > 0, reasons };
}

/** Perfiles disponibles: los integrados, sobrescritos o ampliados por la config. */
export function listSessionProfiles(config: StratumConfig): SessionProfile[] {
  const out = new Map<string, SessionProfile>();
  for (const p of Object.values(BUILTIN)) out.set(p.name, { ...p, source: 'builtin' });
  for (const [name, p] of Object.entries(config.session?.profiles ?? {})) {
    out.set(name, {
      name,
      description: p.description ?? BUILTIN[name]?.description ?? 'perfil de .stratumrc.json',
      allowedTools: p.allowedTools ?? null,
      hiddenTools: p.hiddenTools ?? [],
      source: 'config',
    });
  }
  return [...out.values()];
}

export type SessionProfileResolution =
  | { ok: true; profile: SessionProfile; auto?: InfraDetection }
  | { ok: false; error: string };

/**
 * Resuelve el perfil pedido (flag, `/profile` o `session.profile`). `auto`
 * detecta; cualquier otro nombre tiene que existir.
 */
export function resolveSessionProfile(
  requested: string | undefined,
  config: StratumConfig,
  detect: () => InfraDetection = () => detectInfrastructure(config),
): SessionProfileResolution {
  const name = (requested ?? config.session?.profile ?? AUTO_PROFILE).trim().toLowerCase();
  const profiles = listSessionProfiles(config);
  if (name === AUTO_PROFILE) {
    const detection = detect();
    const target = detection.detected ? 'full' : 'code';
    const profile = profiles.find((p) => p.name === target)!;
    return { ok: true, profile, auto: detection };
  }
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    return {
      ok: false,
      error:
        `el perfil de sesión '${name}' no existe. Disponibles: ` +
        `${[AUTO_PROFILE, ...profiles.map((p) => p.name)].join(', ')}.`,
    };
  }
  return { ok: true, profile };
}

/** Filtro de toolset del perfil. Las tools de control pasan: un perfil describe capacidades. */
export function sessionProfileFilter(profile: SessionProfile): ToolsetFilter | undefined {
  if (profile.allowedTools === null && profile.hiddenTools.length === 0) return undefined;
  return {
    allowedTools: profile.allowedTools,
    hiddenTools: profile.hiddenTools,
    controlTools: 'keep',
  };
}

/** ¿Admite el perfil esta tool? (para condicionar bloques del prompt). */
export function profileAllows(profile: SessionProfile, tool: string): boolean {
  return isToolVisibleForProfile(tool, sessionProfileFilter(profile));
}

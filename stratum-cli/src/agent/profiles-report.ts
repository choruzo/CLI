/**
 * Hito 15 — Informe de perfiles de agente para `/agents` y `stratum agents
 * list`. Puro: recibe los perfiles ya cargados y devuelve texto, así el chat y
 * la CLI muestran exactamente lo mismo.
 */
import type { AgentProfile } from './types.js';
import type { InvalidProfile, ProfileWarning } from './profiles.js';
import { describeProfile, profileMode } from './profiles.js';

const SCOPE_LABEL: Record<string, string> = {
  builtin: 'integrado',
  global: 'global',
  project: 'proyecto',
};

function toolsText(profile: AgentProfile): string {
  if (profile.allowedTools === null) return 'todas';
  if (profile.allowedTools.length === 0) return 'ninguna';
  return profile.allowedTools.join(', ');
}

/** Descripción legible (sin el escape de `|` que necesita la tabla del prompt). */
function plainDescription(profile: AgentProfile): string {
  const text = describeProfile(profile).replace(/\\\|/g, '|');
  return profile.description ? text : `${text || '—'} (sin description: primera línea del cuerpo)`;
}

export interface ProfilesReportOptions {
  /** Perfil activo como agente principal, marcado con `◆`. */
  activeName?: string | null;
  /** Hito 16 — perfiles válidos con avisos (tools retiradas en `allowedTools`). */
  warnings?: ProfileWarning[];
}

export function formatProfilesReport(
  profiles: AgentProfile[],
  invalid: InvalidProfile[],
  opts: ProfilesReportOptions = {},
): string {
  const lines: string[] = [`Perfiles de agente (${profiles.length}):`];
  for (const p of profiles) {
    const marker = opts.activeName === p.name ? '◆' : '•';
    const scope = SCOPE_LABEL[p.source?.scope ?? 'builtin'] ?? p.source?.scope ?? '';
    lines.push('');
    lines.push(`  ${marker} ${p.name}  [${profileMode(p)} · ${scope}]`);
    lines.push(`      ${plainDescription(p)}`);
    lines.push(`      tools: ${toolsText(p)}`);
    if (p.provider || p.model) {
      lines.push(`      modelo: ${[p.provider, p.model].filter(Boolean).join(' / ')}`);
    }
    if (p.source?.path) lines.push(`      fichero: ${p.source.path}`);
  }

  if (invalid.length > 0) {
    lines.push('', `Perfiles inválidos (${invalid.length}) — no se cargaron:`);
    for (const i of invalid) {
      lines.push('', `  ✗ ${i.name}`, `      ${i.error}`, `      fichero: ${i.path}`);
    }
  }

  const warnings = opts.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('', `Avisos (${warnings.length}):`);
    for (const w of warnings) {
      lines.push('', `  ! ${w.name}`, `      ${w.message}`, `      fichero: ${w.path}`);
    }
  }

  lines.push(
    '',
    'Uso: @perfil <tarea> delega (mode subagent/all) · /agent <perfil> lo activa como agente principal (mode primary/all).',
  );
  return lines.join('\n');
}

/** Forma JSON estable para `stratum agents list --json`. */
export function profilesToJson(
  profiles: AgentProfile[],
  invalid: InvalidProfile[],
  warnings: ProfileWarning[] = [],
): unknown {
  return {
    profiles: profiles.map((p) => ({
      name: p.name,
      mode: profileMode(p),
      scope: p.source?.scope ?? 'builtin',
      path: p.source?.path ?? null,
      description: p.description ?? null,
      allowedTools: p.allowedTools,
      provider: p.provider ?? null,
      model: p.model ?? null,
      destructivePolicy: p.destructivePolicy ?? null,
      budget: p.budget,
    })),
    invalid,
    warnings,
  };
}

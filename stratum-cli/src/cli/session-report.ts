/**
 * Hito 17 — informes de texto de `/profile` y `/env`. Puros, para poder
 * probarlos sin montar Ink.
 */
import type { InfraDetection, SessionProfile } from '../agent/session-profile.js';
import { describeEnvironmentRules, type ResolvedEnvironment } from '../tools/environments.js';

export function formatSessionProfileReport(
  active: SessionProfile | null,
  requested: string,
  detection: InfraDetection | null,
  available: SessionProfile[],
): string {
  const lines: string[] = [];
  if (!active) return 'Esta sesión no tiene perfil de sesión.';
  const auto =
    requested === 'auto'
      ? detection?.detected
        ? ` (auto: ${detection.reasons.join(', ')})`
        : ' (auto: sin infraestructura a la vista)'
      : '';
  lines.push(`Perfil de sesión: ${active.name}${auto}`);
  lines.push('');
  lines.push('Disponibles:');
  for (const p of available) {
    const mark = p.name === active.name ? '◆' : '•';
    const tools =
      p.allowedTools === null
        ? p.hiddenTools.length > 0
          ? `todas salvo ${p.hiddenTools.join(', ')}`
          : 'todas'
        : p.allowedTools.join(', ');
    const origin = p.source === 'config' ? ' [.stratumrc.json]' : '';
    lines.push(`  ${mark} ${p.name}${origin} — ${p.description}`);
    lines.push(`      tools: ${tools}`);
  }
  lines.push('');
  lines.push('Uso: /profile <nombre> · /profile auto');
  return lines.join('\n');
}

export function formatEnvironmentsReport(
  environments: ResolvedEnvironment[],
  context: { target: string; environment: ResolvedEnvironment | null },
): string {
  const lines: string[] = [];
  lines.push(
    `Contexto activo: ${context.target}` +
      (context.environment
        ? ` → ${context.environment.name} (${context.environment.tier})`
        : ' (sin entorno)'),
  );
  lines.push('');
  if (environments.length === 0) {
    lines.push('No hay entornos definidos: añade una sección "environments" a .stratumrc.json.');
    return lines.join('\n');
  }
  lines.push('Entornos:');
  for (const env of environments) {
    lines.push(`  • ${env.name} (${env.tier}) — ${env.match.join(', ')}`);
    lines.push(`      ${describeEnvironmentRules(env)}`);
  }
  lines.push('');
  lines.push(
    'Las reglas solo afectan a lo que cambia algo: los comandos read-only nunca se restringen.',
  );
  return lines.join('\n');
}

/**
 * Textos de `stratum plugin list` y `/plugins` (PL1). Puro: recibe el informe
 * del host.
 */
import type { PluginReport } from './host.js';

const SOURCE_LABEL = {
  flag: '--plugin',
  config: 'config global',
  directory: '~/.stratum/plugins',
  project: 'proyecto',
} as const;

function hooksText(hooks: PluginReport['loaded'][number]['hooks']): string {
  const parts = Object.entries(hooks)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([hook, n]) => (n === 1 ? hook : `${hook} ×${n}`));
  return parts.length > 0 ? parts.join(', ') : 'sin hooks';
}

export function formatPluginsReport(report: PluginReport): string {
  if (!report.enabled) return 'Plugins desactivados (--no-plugins o plugins.enabled: false).';
  const lines: string[] = [];
  if (report.loaded.length === 0) {
    lines.push('Ningún plugin cargado.');
  } else {
    lines.push(`Plugins cargados (${report.loaded.length}):`);
    for (const p of report.loaded) {
      lines.push(`  ✓ ${p.id}  [${SOURCE_LABEL[p.source]}]  ${hooksText(p.hooks)}`);
      lines.push(`      ${p.entry}`);
    }
  }
  if (report.skipped.length > 0) {
    lines.push('', `Omitidos (${report.skipped.length}):`);
    for (const s of report.skipped) {
      const who = s.id ?? s.entry ?? '?';
      lines.push(`  ✗ ${who}  [${SOURCE_LABEL[s.source]}]  ${s.reason}`);
      if (s.id && s.entry) lines.push(`      ${s.entry}`);
    }
  }
  if (report.disabledHooks.length > 0) {
    lines.push('', 'Hooks dados de baja en esta sesión:');
    for (const d of report.disabledHooks) lines.push(`  ⚠ ${d.id} · ${d.hook}: ${d.reason}`);
  }
  return lines.join('\n');
}

export function pluginsToJson(report: PluginReport): string {
  return JSON.stringify(report, null, 2);
}

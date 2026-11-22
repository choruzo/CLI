/**
 * Avisos de Home Assistant (`ha_avisos`, M27 fase 1, solo lectura): los
 * *Repairs* por WebSocket (`repairs/list_issues`). HA no da el texto
 * traducido, solo la clave y los placeholders; todo ello es contenido no
 * confiable (`safeField`).
 */
import { type ConnectorTool } from '../lib/mcp-stdio.js';
import { isRecord } from './client.js';
import { EXTERNAL_NOTE, NO_DATA, safeField } from './format.js';
import type { HaToolContext } from './args.js';

const MAX_ISSUES = 20;

/** `clave=valor` de los placeholders, sin `edit` (una ruta de la interfaz de HA). */
function placeholders(v: unknown): string {
  if (!isRecord(v)) return '';
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (k === 'edit') continue;
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue;
    const key = safeField(k, 40);
    const text = safeField(String(val), 80);
    if (key) parts.push(`${key}=${text}`);
  }
  return parts.join(', ');
}

export function createRepairsTool(ctx: HaToolContext): ConnectorTool {
  return {
    name: 'ha_avisos',
    description:
      'Avisos pendientes de Home Assistant (los «Repairs»: una integración rota, un servicio que ya no existe, ' +
      'una automatización con un error…), con su gravedad, su dominio y su clave. Para «¿hay algo roto en HA?», ' +
      '«¿algún aviso de Home Assistant?». Solo lectura.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, signal) {
      ctx.need();
      const ws = ctx.needWs('avisos');
      const raw = await ws.command({ type: 'repairs/list_issues' }, signal);
      const issues = (isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : []).filter(
        isRecord,
      );
      const pending = issues.filter((i) => i.ignored !== true);
      const ignored = issues.length - pending.length;
      const ignoredLine = `${ignored} avisos ignorados en Home Assistant (no se enseñan).`;
      if (pending.length === 0) {
        return [
          'Sin avisos pendientes en Home Assistant.',
          ...(ignored > 0 ? [ignoredLine] : []),
        ].join('\n');
      }
      const shown = pending.slice(0, MAX_ISSUES);
      const lines = [
        `Avisos pendientes en Home Assistant (${pending.length}):`,
        ...shown.map((i) =>
          [
            safeField(i.severity, 30) || NO_DATA,
            safeField(i.domain, 60) || NO_DATA,
            safeField(i.translation_key, 80) || NO_DATA,
            placeholders(i.translation_placeholders),
          ]
            .filter((p) => p !== '')
            .join(' · '),
        ),
      ];
      if (pending.length > shown.length) lines.push(`… y ${pending.length - shown.length} más.`);
      if (ignored > 0) lines.push(ignoredLine);
      lines.push(EXTERNAL_NOTE);
      return lines.join('\n');
    },
  };
}

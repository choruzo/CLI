/**
 * `stratum sessions export`: una sesión guardada como JSON o Markdown. Puro: el
 * comando lee la sesión y escribe el resultado. Todo texto que viene del
 * historial (mensajes, argumentos de tools) pasa por `redact` antes de salir:
 * una exportación se comparte, y una salida de tool puede llevar un token.
 */
import type { Message } from '../agent/types.js';
import type { SessionContext } from './types.js';

export type SessionExportFormat = 'json' | 'markdown';

export const SESSION_EXPORT_FORMATS: readonly SessionExportFormat[] = ['json', 'markdown'];

/** Copia del mensaje con el contenido y los argumentos de tools redactados. */
function redactMessage(m: Message, redact: (text: string) => string): Message {
  return {
    ...m,
    content: m.content === null ? null : redact(m.content),
    ...(m.tool_calls
      ? {
          tool_calls: m.tool_calls.map((c) => ({
            ...c,
            function: { ...c.function, arguments: redact(c.function.arguments) },
          })),
        }
      : {}),
  };
}

/** Valla de código más larga que cualquier racha de comillas del texto. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text: string, lang = ''): string {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
}

function toMarkdown(s: SessionContext, messages: Message[]): string {
  const lines: string[] = [`# Sesión ${s.id}`, ''];
  lines.push(`- Creada: ${s.createdAt}`);
  lines.push(`- Actualizada: ${s.updatedAt}`);
  lines.push(`- Provider / modelo: ${s.provider} / ${s.model}`);
  lines.push(`- Proyecto: ${s.project}`);
  if (s.summary) lines.push(`- Resumen: ${s.summary}`);
  if (s.activeAgent) lines.push(`- Agente principal: ${s.activeAgent}`);
  if (s.readOnly) lines.push('- Read-only');
  lines.push('');

  for (const m of messages) {
    // El system prompt es del runtime, no de la conversación: va en el JSON.
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      lines.push('## Usuario', '', m.content ?? '', '');
    } else if (m.role === 'assistant') {
      lines.push('## Asistente', '');
      if (m.content) lines.push(m.content, '');
      for (const call of m.tool_calls ?? []) {
        lines.push(`**→ ${call.function.name}**`, '', fenced(call.function.arguments, 'json'), '');
      }
    } else {
      lines.push(`**← ${m.name ?? 'tool'}**`, '', fenced(m.content ?? ''), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function exportSession(
  session: SessionContext,
  format: SessionExportFormat,
  redact: (text: string) => string,
): string {
  const messages = session.messages.map((m) => redactMessage(m, redact));
  if (format === 'json') {
    return `${JSON.stringify({ ...session, summary: redact(session.summary), messages }, null, 2)}\n`;
  }
  return toMarkdown({ ...session, summary: redact(session.summary) }, messages);
}

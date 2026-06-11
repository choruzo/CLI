/**
 * Truncado genérico de tool results (equivalente a tool/truncate.ts de OpenCode).
 *
 * Protege el contexto del modelo local: un `cat`, `find` o `git log` grande no
 * debe inundar el historial. Conserva cabeza (80%) y cola (20%) con un marcador
 * explícito para que el modelo sepa que falta contenido.
 */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function truncateToolOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.8));
  const tail = text.slice(-Math.floor(maxChars * 0.2));
  return `${head}\n\n[... output truncated (${text.length} chars total) ...]\n\n${tail}`;
}

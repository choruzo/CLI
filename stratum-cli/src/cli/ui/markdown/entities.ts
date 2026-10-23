/**
 * `marked` (v12) entrega el texto y el código en línea ya escapados para HTML:
 * `->` llega como `-&gt;`. Un terminal no es HTML, así que se deshace. Puro.
 */
const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

export function unescapeHtml(text: string): string {
  // Una sola pasada: `&amp;gt;` es `&gt;` literal, no `>`.
  return text.replace(/&(?:lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m] ?? m);
}

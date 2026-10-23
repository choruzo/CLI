/**
 * Vista previa del razonamiento plegado (UX-3). La línea `⊙` no sigue al token:
 * enseña el último párrafo ya **terminado**, así que avanza a saltos legibles en
 * vez de temblar con cada fragmento. Mientras no hay ningún párrafo cerrado se
 * conforma con la última frase terminada. Puro: lo pintan `AgentMessage` y sus
 * tests.
 */

export interface ReasoningPreview {
  /** Texto a enseñar, ya aplanado a una línea; '' si aún no hay nada cerrado. */
  preview: string;
  words: number;
}

const PARAGRAPH = /\n\s*\n/;

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const flat = flatten(text);
  return flat ? flat.split(' ').length : 0;
}

/** Última frase terminada (`.`, `!`, `?` o `:` seguidos de espacio) de un texto a medias. */
function lastClosedSentence(text: string): string {
  const flat = flatten(text);
  const ends = [...flat.matchAll(/[.!?:](?=\s)/g)].map((m) => m.index ?? -1);
  const end = ends.at(-1);
  if (end === undefined) return '';
  const start = ends.length > 1 ? (ends.at(-2) ?? -1) + 1 : 0;
  return flat.slice(start, end + 1).trim();
}

/**
 * @param open el bloque sigue llegando: su último párrafo está a medias y no se
 *   enseña. Cerrado, el último párrafo es el más reciente y vale entero.
 */
export function reasoningPreview(text: string, open: boolean): ReasoningPreview {
  const words = countWords(text);
  const paragraphs = text.split(PARAGRAPH).filter((p) => p.trim());
  // Un salto de párrafo al final cierra el último aunque el bloque siga abierto.
  if (!open || /\n\s*\n\s*$/.test(text))
    return { preview: flatten(paragraphs.at(-1) ?? ''), words };
  if (paragraphs.length > 1) return { preview: flatten(paragraphs.at(-2) ?? ''), words };
  return { preview: lastClosedSentence(paragraphs[0] ?? ''), words };
}

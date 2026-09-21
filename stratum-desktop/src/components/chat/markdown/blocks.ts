import { Lexer } from 'marked';

/**
 * Troceo del markdown en bloques de primer nivel para el render incremental
 * (15.13). Durante el streaming solo cambia el final del texto: todos los
 * bloques salvo el último son estables, se memoizan y no se vuelven a parsear.
 *
 * `marked` solo se usa como lexer para encontrar las fronteras; el render lo
 * hace react-markdown bloque a bloque.
 */

export interface MarkdownBlock {
  /** Texto markdown del bloque, tal cual aparece en la fuente. */
  raw: string;
  /** Desplazamiento del bloque dentro del texto completo. */
  offset: number;
}

export interface SplitState {
  /** Texto del que salen `blocks`. */
  text: string;
  blocks: MarkdownBlock[];
}

export const EMPTY_SPLIT: SplitState = { text: '', blocks: [] };

function lex(text: string, base: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let offset = base;
  for (const token of Lexer.lex(text, { gfm: true })) {
    const raw = token.raw;
    // Los `space` (líneas en blanco) separan bloques pero no se pintan: se
    // pegan al bloque anterior para que los offsets sigan cuadrando.
    if (token.type === 'space' && blocks.length > 0) {
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], raw: blocks[blocks.length - 1].raw + raw };
    } else {
      blocks.push({ raw, offset });
    }
    offset += raw.length;
  }
  return blocks;
}

/**
 * Trocea `text` reutilizando el troceo anterior cuando `text` lo extiende: se
 * re-lexa solo desde el principio del último bloque, que es el único que un
 * delta puede alterar (un párrafo que se convierte en encabezado setext, una
 * lista que crece, una valla de código que se cierra). Si el texto no es una
 * extensión del anterior (edición, reinicio), se re-lexa entero.
 */
export function splitBlocks(text: string, prev: SplitState = EMPTY_SPLIT): SplitState {
  if (text === prev.text) return prev;
  const last = prev.blocks[prev.blocks.length - 1];
  if (!last || !text.startsWith(prev.text)) {
    return { text, blocks: lex(text, 0) };
  }
  const stable = prev.blocks.slice(0, -1);
  return { text, blocks: [...stable, ...lex(text.slice(last.offset), last.offset)] };
}

/** ¿El bloque es una valla de código ya cerrada? Solo esas se resaltan. */
export function isClosedFence(raw: string): boolean {
  const body = raw.replace(/\s+$/, '');
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(body);
  if (!open) return false;
  const lines = body.split('\n');
  if (lines.length < 2) return false;
  const fence = open[1];
  const closing = lines[lines.length - 1].trim();
  return closing.startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(closing);
}

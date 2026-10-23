/**
 * Localización tolerante de `old_string` para `edit_file`, en escalera: el
 * nivel estricto primero y, solo si no casa, dos redes más laxas.
 *
 * El tramo que se devuelve es siempre el del texto **original**: los niveles 2
 * y 3 construyen una vista normalizada y traducen los offsets con un mapa, de
 * modo que el reemplazo se hace sobre los bytes reales del fichero. Lo que
 * escribe el modelo (`new_string`) nunca se normaliza.
 *
 * Funciones puras: no tocan disco ni dependen de `TextFile`.
 */

export type MatchLevel = 'exact' | 'unicode' | 'trailing-whitespace';

/** Tramo `[start, end)` del texto original. */
export interface Span {
  start: number;
  end: number;
}

/** Orden de la escalera: se para en el primer nivel con al menos un tramo. */
export const MATCH_LEVELS: readonly MatchLevel[] = ['exact', 'unicode', 'trailing-whitespace'];

/**
 * Carácter normalizado de `code`. `''` = zero-width, se elimina (con la salvedad
 * del U+FEFF al principio del texto, que es un BOM legítimo y se conserva).
 */
function normalizeChar(code: number, index: number): string | undefined {
  // Zero-width: no aporta nada al match y rompe comparaciones invisibles.
  if (code >= 0x200b && code <= 0x200d) return '';
  if (code === 0xfeff && index > 0) return '';

  switch (code) {
    // Comillas tipográficas.
    case 0x2018: // ‘
    case 0x2019: // ’
    case 0x201a: // ‚
    case 0x201b: // ‛
      return "'";
    case 0x201c: // “
    case 0x201d: // ”
    case 0x201e: // „
    case 0x201f: // ‟
      return '"';
    // Guiones y rayas.
    case 0x2010: // ‐
    case 0x2011: // ‑
    case 0x2012: // ‒
    case 0x2013: // –
    case 0x2014: // —
    case 0x2015: // ―
      return '-';
    // Espacios «raros»: NBSP, espacios tipográficos, fino, ideográfico.
    case 0x00a0:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return ' ';
    // Puntos suspensivos: un solo carácter pasa a tres.
    case 0x2026: // …
      return '...';
    default:
      if (code >= 0x2000 && code <= 0x200a) return ' ';
      return undefined;
  }
}

/**
 * Vista normalizada + fronteras al original. `starts[i]` es el primer offset
 * original del carácter normalizado `i` y `ends[i]` el siguiente al último: con
 * ambos se traduce un tramo sin cortar caracteres que no emiten nada (el `\r` de
 * un CRLF, un zero-width), que quedan absorbidos por el carácter siguiente.
 */
function normalizeWithMap(text: string): { norm: string; starts: number[]; ends: number[] } {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  /** Primer offset de la racha de caracteres que no emiten nada. */
  let skipped = -1;
  for (let i = 0; i < text.length; i++) {
    // El `\r` de un CRLF no emite carácter en la vista normalizada: el modelo
    // escribe `\n` (read_file no le enseña los `\r`) y sin esto el nivel
    // `unicode` sería inalcanzable en cualquier fichero CRLF multilínea.
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) {
      if (skipped === -1) skipped = i;
      continue;
    }
    const replaced = normalizeChar(text.charCodeAt(i), i);
    if (replaced === undefined) {
      out.push(text[i]);
      starts.push(skipped === -1 ? i : skipped);
      ends.push(i + 1);
      skipped = -1;
      continue;
    }
    if (replaced === '') {
      // Zero-width: no emite nada y lo absorbe el carácter siguiente.
      if (skipped === -1) skipped = i;
      continue;
    }
    // `'...'` emite tres caracteres que apuntan todos al mismo offset de origen.
    for (const ch of replaced) {
      out.push(ch);
      starts.push(i);
      ends.push(i + 1);
    }
    skipped = -1;
  }
  return { norm: out.join(''), starts, ends };
}

/** Índices de `needle` en `haystack`, sin solapes y de izquierda a derecha. */
function indexesOf(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (needle.length === 0) return hits;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return hits;
    hits.push(idx);
    from = idx + needle.length;
  }
}

interface Line {
  /** Offset del primer carácter de la línea. */
  start: number;
  /** Offset del final del contenido (sin el salto). */
  contentEnd: number;
  /** Offset del principio de la línea siguiente (tras el salto). */
  next: number;
  text: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\n' && ch !== '\r') continue;
    const next = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
    lines.push({ start, contentEnd: i, next, text: text.slice(start, i) });
    start = next;
    i = next - 1;
  }
  lines.push({ start, contentEnd: text.length, next: text.length, text: text.slice(start) });
  return lines;
}

/** Sin espacios, tabs ni `\r` al final (el `\r` ya no existe tras trocear). */
function stripTrailing(line: string): string {
  return line.replace(/[ \t\r]+$/, '');
}

/**
 * Tramos de `needle` en `text` para el nivel pedido, sin solapes y de
 * izquierda a derecha. No sabe de unicidad: eso lo decide quien llama.
 */
export function findSpans(text: string, needle: string, level: MatchLevel): Span[] {
  if (needle.length === 0) return [];

  if (level === 'exact') {
    return indexesOf(text, needle).map((start) => ({ start, end: start + needle.length }));
  }

  if (level === 'unicode') {
    const { norm, starts, ends } = normalizeWithMap(text);
    const { norm: needleNorm } = normalizeWithMap(needle);
    if (needleNorm.length === 0) return [];
    const spans: Span[] = [];
    for (const start of indexesOf(norm, needleNorm)) {
      const end = start + needleNorm.length;
      // Una expansión (`…` → `...`) son varios caracteres normalizados con el
      // mismo offset de origen. Un tramo que empieza o acaba en mitad de una
      // dejaría el original cortado, así que se descarta entero: solo vale el
      // que arranca en el primer carácter de su expansión y termina tras el
      // último.
      if (start > 0 && starts[start - 1] === starts[start]) continue;
      if (end < norm.length && starts[end] === starts[end - 1]) continue;
      spans.push({ start: starts[start], end: ends[end - 1] });
    }
    return spans;
  }

  // Nivel 3: líneas completas, ignorando espacios finales en ambos lados.
  const lines = splitLines(text);
  const needleLines = splitLines(needle);
  // Un `needle` que acaba en salto produce una línea final vacía: esa línea no
  // se compara, pero su salto sí forma parte del tramo.
  const includeTrailingNewline = /\r?\n$/.test(needle) || /\r$/.test(needle);
  const wanted = (includeTrailingNewline ? needleLines.slice(0, -1) : needleLines).map((line) =>
    stripTrailing(line.text),
  );
  // Un needle en blanco casaría con cualquier línea vacía del fichero: se deja
  // que lo resuelvan los niveles anteriores.
  if (wanted.length === 0 || wanted.every((line) => line === '')) return [];

  const spans: Span[] = [];
  for (let i = 0; i + wanted.length <= lines.length; ) {
    let k = 0;
    for (; k < wanted.length; k++) {
      if (stripTrailing(lines[i + k].text) !== wanted[k]) break;
    }
    if (k < wanted.length) {
      i++;
      continue;
    }
    const last = lines[i + wanted.length - 1];
    spans.push({
      start: lines[i].start,
      end: includeTrailingNewline ? last.next : last.contentEnd,
    });
    i += wanted.length;
  }
  return spans;
}

/** Primer nivel de la escalera con al menos un tramo, o `null`. */
export function locate(text: string, needle: string): { level: MatchLevel; spans: Span[] } | null {
  for (const level of MATCH_LEVELS) {
    const spans = findSpans(text, needle, level);
    if (spans.length > 0) return { level, spans };
  }
  return null;
}

/**
 * Reemplazo literal de los tramos dados. Slicing de derecha a izquierda: los
 * offsets de la izquierda siguen siendo válidos y `$&`/`$$` del reemplazo no se
 * interpretan nunca.
 */
export function replaceSpans(text: string, spans: Span[], replacement: string): string {
  let out = text;
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  for (const span of ordered) {
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
  }
  return out;
}

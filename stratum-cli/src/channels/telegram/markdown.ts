/**
 * M18 parte 6D — el markdown del modelo, en el HTML de Telegram (`parse_mode: 'HTML'`).
 *
 * Puro: sin E/S. Solo se emite un puñado de etiquetas (`b i s code pre a
 * blockquote`); todo lo que no es una marca reconocida se escapa, así que el
 * texto del modelo nunca se interpreta como otra cosa. Se prefiere no formatear
 * a generar HTML inválido: un delimitador sin pareja se queda como texto.
 *
 * Cada trozo lleva también `plain` (el markdown original de esos bloques): es el
 * respaldo si Telegram rechaza el formato.
 */
import { CHUNK_CHARS, chunkText } from './render.js';

export interface TelegramChunk {
  html: string;
  plain: string;
}

/** Escapa lo único que HTML de Telegram interpreta en el texto. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Igual, para un valor de atributo (entre comillas dobles). */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Formato inline
// ---------------------------------------------------------------------------

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** Cierre de un delimitador de dos caracteres (`**`, `__`, `~~`) o `-1`. */
function findDouble(s: string, delim: string, from: number): number {
  for (let j = s.indexOf(delim, from); j !== -1; j = s.indexOf(delim, j + 1)) {
    if (j > from && !isSpace(s[j - 1])) return j;
  }
  return -1;
}

/** Cierre de `*` o `_` sueltos, en límite de palabra, o `-1`. */
function findSingle(s: string, delim: string, from: number): number {
  for (let j = s.indexOf(delim, from); j !== -1; j = s.indexOf(delim, j + 1)) {
    if (s[j + 1] === delim || s[j - 1] === delim) continue;
    if (j > from && !isSpace(s[j - 1]) && !isWordChar(s[j + 1])) return j;
  }
  return -1;
}

const LINK_RE = /^\[([^\]\n]+)\]\((\S+?)\)/;

/** Una línea de markdown inline → HTML de Telegram (siempre con etiquetas equilibradas). */
function inline(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    } else if (c === '[') {
      const m = LINK_RE.exec(s.slice(i));
      if (m) {
        if (/^https?:\/\//i.test(m[2]!)) {
          out += `<a href="${escapeAttr(m[2]!)}">${inline(m[1]!)}</a>`;
        } else {
          // Otro esquema (`javascript:`…): ni enlace ni formato, el texto tal cual.
          out += escapeHtml(m[0]);
        }
        i += m[0].length;
        continue;
      }
    } else if (c === '*' || c === '_' || c === '~') {
      if (s[i + 1] === c && (c !== '_' || !isWordChar(s[i - 1]))) {
        const end = findDouble(s, c + c, i + 2);
        const next = end === -1 ? undefined : s[end + 2];
        if (end !== -1 && !isSpace(s[i + 2]) && (c !== '_' || !isWordChar(next))) {
          const tag = c === '~' ? 's' : 'b';
          out += `<${tag}>${inline(s.slice(i + 2, end))}</${tag}>`;
          i = end + 2;
          continue;
        }
      } else if (c !== '~' && s[i + 1] !== c && !isWordChar(s[i - 1]) && !isSpace(s[i + 1])) {
        const end = findSingle(s, c, i + 1);
        if (end !== -1) {
          out += `<i>${inline(s.slice(i + 1, end))}</i>`;
          i = end + 1;
          continue;
        }
      }
      // Sin pareja: se queda como texto (y salta el par entero, para no reintentarlo).
      const run = s[i + 1] === c ? 2 : 1;
      out += c.repeat(run);
      i += run;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

interface Block {
  /** Lo que separa este bloque del anterior en el original. */
  sep: '\n' | '\n\n';
  html: string;
  /** El markdown original del bloque. */
  plain: string;
  /** Un bloque `<pre>` se parte por líneas, no por texto. */
  pre?: { open: string; lines: string[] };
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\n`]*)$/;
const TABLE_SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE = /^\s*>/;

const width = (s: string): number => [...s].length;

function isTableSep(line: string | undefined): boolean {
  if (line === undefined) return false;
  const t = line.trim();
  return t.includes('|') && t.includes('-') && TABLE_SEP.test(t);
}

/** Las celdas de una fila, en markdown (`\|` ya es una barra). */
function rowCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Sin marcas de negrita ni de código: para alinear en `<pre>`. */
const bare = (cell: string): string => cell.replace(/\*\*|__|`/g, '');

/**
 * Ancho máximo de una línea de tabla en `<pre>`: lo que cabe en la pantalla de
 * un móvil. Más ancha, Telegram la parte y las columnas dejan de leerse.
 */
export const TABLE_PRE_WIDTH = 36;

/** Celda vacía o de relleno: en una ficha no merece línea. */
const EMPTY_CELL = /^[-—–]?$/;

/**
 * Una tabla ancha, como fichas: por fila, la primera celda en negrita y debajo
 * `Columna: valor` por cada otra celda con contenido. Un bloque por fila, para
 * que el troceo no las parta.
 */
function tableCards(sep: Block['sep'], header: string[], rows: string[][], raw: string[]): Block[] {
  return rows.map((r, n) => {
    const [first = '', ...rest] = r;
    const title = first.replace(/\*\*|__/g, '');
    const lines = EMPTY_CELL.test(title) ? [] : [`<b>${inline(title)}</b>`];
    rest.forEach((cell, k) => {
      if (EMPTY_CELL.test(cell)) return;
      const name = bare(header[k + 1] ?? '').trim();
      lines.push(name ? `${escapeHtml(name)}: ${inline(cell)}` : inline(cell));
    });
    return { sep: n === 0 ? sep : '\n\n', html: lines.join('\n'), plain: raw[n]! };
  });
}

/** Las filas de una tabla alineadas por columnas (sin la fila separadora). */
function alignTable(rows: string[][]): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => width(r[c] ?? ''))),
  );
  return rows.map((r) =>
    widths
      .map((w, c) => {
        const cell = r[c] ?? '';
        return cell + ' '.repeat(w - width(cell));
      })
      .join(' | ')
      .trimEnd(),
  );
}

function preBlock(
  sep: Block['sep'],
  open: string,
  rawLines: string[],
  plain: string,
): Block | null {
  if (rawLines.every((l) => l.trim() === '')) return null;
  const close = open.startsWith('<pre><code') ? '</code></pre>' : '</pre>';
  return {
    sep,
    html: `${open}${escapeHtml(rawLines.join('\n'))}${close}`,
    plain,
    pre: { open, lines: rawLines },
  };
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let sep: Block['sep'] = '\n';
  const push = (b: Block | null): void => {
    if (b && b.html.trim()) blocks.push(b);
    sep = '\n';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      sep = '\n\n';
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const lang = fence[2]!.trim().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j]!.trim();
        if (t.startsWith(mark[0]!.repeat(3)) && /^(`+|~+)$/.test(t) && t.length >= mark.length)
          break;
        body.push(lines[j]!);
        j++;
      }
      const raw = lines.slice(i, Math.min(j + 1, lines.length)).join('\n');
      const open = /^[A-Za-z0-9_+-]+$/.test(lang)
        ? `<pre><code class="language-${lang}">`
        : '<pre>';
      push(preBlock(sep, open, body, raw));
      i = j + 1;
      continue;
    }
    if (line.trim().startsWith('|') && isTableSep(lines[i + 1])) {
      const rows: string[][] = [rowCells(line)];
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim().startsWith('|')) {
        rows.push(rowCells(lines[j]!));
        j++;
      }
      const aligned = alignTable(rows.map((r) => r.map(bare)));
      if (rows.length === 1 || aligned.every((l) => width(l) <= TABLE_PRE_WIDTH)) {
        push(preBlock(sep, '<pre>', aligned, lines.slice(i, j).join('\n')));
      } else {
        // La cabecera y la separadora van con la primera fila en el respaldo plano.
        const raw = lines.slice(i + 2, j);
        raw[0] = lines.slice(i, i + 3).join('\n');
        for (const card of tableCards(sep, rows[0]!, rows.slice(1), raw)) push(card);
      }
      i = j;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i;
      const body: string[] = [];
      while (j < lines.length && QUOTE.test(lines[j]!)) {
        body.push(lines[j]!.replace(/^\s*>\s?/, ''));
        j++;
      }
      push({
        sep,
        html: `<blockquote>${body.map(inline).join('\n')}</blockquote>`,
        plain: lines.slice(i, j).join('\n'),
      });
      i = j;
      continue;
    }
    let html: string;
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    if (HR.test(line)) html = '──────';
    // Ya va en negrita: sin `**`/`__` dentro, para no anidar `<b>` en `<b>`.
    else if (heading)
      html = heading[1] ? `<b>${inline(heading[1].replace(/\*\*|__/g, ''))}</b>` : '';
    else if (bullet) html = `${bullet[1]}• ${inline(bullet[2]!)}`;
    else html = inline(line);
    push({ sep, html, plain: line });
    i++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Troceo
// ---------------------------------------------------------------------------

/** Parte un `<pre>` por líneas en varios `<pre>` completos que caben en `max`. */
function splitPre(block: Block, max: number): TelegramChunk[] {
  const { open, lines } = block.pre!;
  const close = open.startsWith('<pre><code') ? '</code></pre>' : '</pre>';
  const budget = Math.max(1, max - open.length - close.length);
  const out: TelegramChunk[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = (): void => {
    if (cur.length === 0 || cur.every((l) => l.trim() === '')) {
      cur = [];
      curLen = 0;
      return;
    }
    out.push({
      html: `${open}${escapeHtml(cur.join('\n'))}${close}`,
      plain: cur.join('\n').trim(),
    });
    cur = [];
    curLen = 0;
  };
  const add = (raw: string): void => {
    const esc = escapeHtml(raw).length;
    if (cur.length > 0 && curLen + esc + 1 > budget) flush();
    curLen += esc + (cur.length > 0 ? 1 : 0);
    cur.push(raw);
  };
  for (const raw of lines) {
    if (escapeHtml(raw).length <= budget) {
      add(raw);
      continue;
    }
    // Una línea más larga que el trozo: se corta por puntos de código.
    flush();
    let piece = '';
    let pieceLen = 0;
    for (const ch of raw) {
      const n = escapeHtml(ch).length;
      if (pieceLen + n > budget) {
        add(piece);
        flush();
        piece = '';
        pieceLen = 0;
      }
      piece += ch;
      pieceLen += n;
    }
    if (piece) add(piece);
  }
  flush();
  return out;
}

/** Un bloque que no cabe: su texto plano en pedazos, cada uno escapado y sin formato. */
function splitText(block: Block, max: number): TelegramChunk[] {
  for (let m = max; m >= 1; m = Math.floor(m / 2)) {
    const pieces = chunkText(block.plain, m);
    const chunks = pieces.map((p) => ({ html: escapeHtml(p), plain: p }));
    if (chunks.every((c) => c.html.length <= max)) return chunks;
    if (m === 1) break;
  }
  // Inalcanzable con `max` ≥ 6 (un carácter escapado mide ≤ 5); por si acaso, por puntos de código.
  return [...block.plain].map((p) => ({ html: escapeHtml(p), plain: p }));
}

/**
 * Convierte markdown en trozos de HTML de Telegram que caben en `max`, sin partir
 * nunca una marca: se agrupan bloques enteros y solo un bloque que por sí solo no
 * cabe se parte. `plain` es el respaldo (el markdown original de esos bloques).
 */
export function renderTelegramMarkdown(
  markdown: string,
  max: number = CHUNK_CHARS,
): TelegramChunk[] {
  const chunks: TelegramChunk[] = [];
  let cur: TelegramChunk | null = null;
  const flush = (): void => {
    if (cur && cur.html.trim()) chunks.push({ html: cur.html, plain: cur.plain.trim() });
    cur = null;
  };
  for (const block of parseBlocks(markdown)) {
    if (block.html.length > max || block.plain.length > max) {
      flush();
      const pieces = block.pre ? splitPre(block, max) : splitText(block, max);
      for (const p of pieces) if (p.html.trim() && p.plain.trim()) chunks.push(p);
      continue;
    }
    if (cur) {
      const html: string = cur.html + block.sep + block.html;
      const plain: string = cur.plain + block.sep + block.plain;
      if (html.length <= max && plain.length <= max) {
        cur = { html, plain };
        continue;
      }
      flush();
    }
    cur = { html: block.html, plain: block.plain };
  }
  flush();
  return chunks;
}

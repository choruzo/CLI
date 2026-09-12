/**
 * Parser de frontmatter YAML mínimo, sin dependencias. Extraído de
 * `profiles.ts` (Hito 8) para compartirlo con el registro de skills (Hito 12):
 * los dos formatos son el mismo — markdown con un bloque `---` delante.
 *
 * Soporta el subconjunto que usan perfiles y skills: escalares, arrays y
 * objetos inline (`[a, b]` / `{ k: v }`), bloques indentados (secuencias
 * `- item` y mapas `k: v`) y escalares de bloque (`|` y `>`). Los `>` importan
 * para las skills: una `description` larga se escribe casi siempre plegada.
 */

export interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function splitFrontmatter(raw: string): SplitResult {
  const normalized = raw.replace(/^﻿/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized };
  const frontmatter = parseYamlBlock(match[1] ?? '');
  return { frontmatter, body: match[2] ?? '' };
}

/**
 * Parsea un bloque YAML de pares `clave: valor` a nivel raíz. Soportar el
 * estilo de bloque es importante: un `allowedTools:` válido en YAML de bloque
 * NO debe colarse como "sin restricción" (que concedería todas las tools al
 * subagente).
 */
export function parseYamlBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split('\n');
  const indentOf = (s: string): number => s.length - s.replace(/^\s+/, '').length;

  let i = 0;
  while (i < lines.length) {
    const raw = (lines[i] ?? '').replace(/\s+$/, '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const valueStr = trimmed.slice(colon + 1).trim();
    if (!key) {
      i++;
      continue;
    }

    const parentIndent = indentOf(raw);

    // Escalar de bloque: `key: |` (literal) o `key: >` (plegado), con los
    // indicadores opcionales de chomping (`-`, `+`).
    const blockScalar = valueStr.match(/^([|>])([-+]?)$/);
    if (blockScalar) {
      const folded = blockScalar[1] === '>';
      const chunk: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const childRaw = (lines[j] ?? '').replace(/\s+$/, '');
        if (childRaw.trim() !== '' && indentOf(childRaw) <= parentIndent) break;
        chunk.push(childRaw.trim());
        j++;
      }
      while (chunk.length > 0 && chunk[chunk.length - 1] === '') chunk.pop();
      out[key] = folded ? foldBlock(chunk) : chunk.join('\n');
      i = j;
      continue;
    }

    // Valor en la misma línea → inline (escalar / [..] / {..}).
    if (valueStr !== '') {
      out[key] = parseYamlValue(valueStr);
      i++;
      continue;
    }

    // Valor vacío → posible bloque hijo indentado.
    const children: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const childRaw = (lines[j] ?? '').replace(/\s+$/, '');
      const childTrim = childRaw.trim();
      if (childTrim === '' || childTrim.startsWith('#')) {
        j++;
        continue;
      }
      if (indentOf(childRaw) <= parentIndent) break;
      children.push(childTrim);
      j++;
    }

    if (children.length > 0 && children.every((c) => c.startsWith('-'))) {
      out[key] = children.map((c) => parseScalar(c.replace(/^-\s*/, '').trim()));
    } else if (children.length > 0) {
      const obj: Record<string, unknown> = {};
      for (const c of children) {
        const cc = c.indexOf(':');
        if (cc === -1) continue;
        const k = c.slice(0, cc).trim();
        if (k) obj[k] = parseScalar(c.slice(cc + 1).trim());
      }
      out[key] = obj;
    } else {
      out[key] = undefined;
    }
    i = j;
  }
  return out;
}

/** Plegado YAML `>`: las líneas en blanco separan párrafos; el resto se une con espacio. */
function foldBlock(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

export function parseYamlValue(value: string): unknown {
  if (value === '') return undefined;
  // Array inline: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((v) => parseScalar(v.trim()));
  }
  // Objeto inline: { k: v, k2: v2 }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const pair of inner.split(',')) {
      const c = pair.indexOf(':');
      if (c === -1) continue;
      const k = pair.slice(0, c).trim();
      if (k) obj[k] = parseScalar(pair.slice(c + 1).trim());
    }
    return obj;
  }
  return parseScalar(value);
}

export function parseScalar(s: string): unknown {
  const unquoted = s.replace(/^['"]|['"]$/g, '');
  if (s === unquoted) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  }
  return unquoted;
}

/**
 * Lectura de XML con regex/estado, tolerante (sin dependencias): los elementos
 * vacíos o auto-cerrados significan «sin dato», nunca 0. Utilidades compartidas
 * por la previsión (ISO-8859-15) y los avisos (CAP 1.2, UTF-8).
 */

/** Sustituto de una entidad numérica que no es un carácter XML válido. */
const SUSTITUTO = '\uFFFD';

/** ¿Es un punto de código Unicode representable (≤ 0x10FFFF y sin sustitutos sueltos)? */
function puntoValido(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
}

/** Carácter de una entidad numérica; `�` si el punto no es válido (`&#9999999;`). */
function dePunto(n: number): string {
  return puntoValido(n) ? String.fromCodePoint(n) : SUSTITUTO;
}

/** Decodifica entidades XML numéricas y predefinidas; `&amp;lt;` → `&lt;` literal. */
export function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => dePunto(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => dePunto(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * ISO-8859-15 decodificado como latin1 con los 8 puntos que cambian respecto
 * de ISO-8859-1 corregidos a mano (€, Š, Ž, š, ž, Œ, œ, Ÿ). Los XML de
 * previsión de AEMET vienen en ISO-8859-15 y declaran esa codificación.
 */
const LATIN15: Record<string, string> = {
  '\u00A4': '€',
  '\u00A6': 'Š',
  '\u00A8': 'Ž',
  '\u00B4': 'š',
  '\u00B8': 'ž',
  '\u00BC': 'Œ',
  '\u00BD': 'œ',
  '\u00BE': 'Ÿ',
};

export function decodificarIso885915(bytes: ArrayBuffer): string {
  const s = new TextDecoder('latin1').decode(bytes);
  return s.replace(/[\u00A4\u00A6\u00A8\u00B4\u00B8\u00BC\u00BD\u00BE]/g, (c) => LATIN15[c] ?? c);
}

/** Un elemento: atributos y contenido interno (vacío si es auto-cerrado). */
export interface Elemento {
  attrs: Record<string, string>;
  inner: string;
  /** Texto del primer hijo de texto, ya decodificado; `''` si no trae texto. */
  texto: string;
}

/** Encuentra todos los elementos `<nombre>` (hojas: sin pares anidados del mismo nombre). */
export function elementos(xml: string, nombre: string): Elemento[] {
  // El lookbehind evita que el par se haga con la `/` de un auto-cerrado
  // (`<x periodo="0-24"/>` no es la apertura de un par).
  const re = new RegExp(
    `<${nombre}(\\s[^>]*(?<!/))?>([\\s\\S]*?)</${nombre}>|<${nombre}(\\s[^>]*)?/>`,
    'g',
  );
  const out: Elemento[] = [];
  for (const m of xml.matchAll(re)) {
    const attrs = parseAttrs(m[1] ?? m[3] ?? '');
    const inner = m[2] ?? '';
    out.push({ attrs, inner, texto: inner.includes('<') ? '' : decodeXml(inner).trim() });
  }
  return out;
}

/** El primer elemento `<nombre>` o `undefined`. */
export function primer(xml: string, nombre: string): Elemento | undefined {
  return elementos(xml, nombre)[0];
}

/** Valor de un atributo del primer `<nombre>` (o `''`). */
export function atributo(xml: string, nombre: string, attr: string): string {
  const re = new RegExp(`<${nombre}(\\s[^>]*)?>`);
  return parseAttrs(re.exec(xml)?.[1] ?? '')[attr] ?? '';
}

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(/([a-zA-Z_][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g))
    out[m[1]!] = decodeXml(m[2]!);
  return out;
}

/** El texto del elemento `<nombre>…</nombre>` raíz, sin etiquetas; `null` si vacío o ausente. */
export function texto(xml: string, nombre: string): string | null {
  const m = new RegExp(
    `<${nombre}(\\s[^>]*(?<!/))?>([\\s\\S]*?)</${nombre}>|<${nombre}(\\s[^>]*)?/>`,
  ).exec(xml);
  if (!m) return null;
  const inner = m[2] ?? '';
  if (!inner.trim()) return null;
  return decodeXml(inner.replace(/<[^>]*>/g, '')).trim();
}

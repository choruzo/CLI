/**
 * Conversor HTML → texto/markdown sin dependencias externas.
 *
 * No pretende ser un parser HTML completo: cubre el caso de extraer contenido
 * legible de páginas web para inyectarlo al contexto del agente. Elimina
 * scripts/estilos/navegación, convierte la estructura principal (headings,
 * párrafos, listas, código, enlaces, tablas simples) a markdown y colapsa
 * el whitespace.
 */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&laquo;': '«',
  '&raquo;': '»',
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&[a-zA-Z]+;/g, (entity) => ENTITY_MAP[entity] ?? ' ');
}

/** Convierte HTML a texto plano estilo markdown. */
export function htmlToText(html: string): string {
  let s = html;

  // 1. Eliminar bloques sin contenido legible
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'template']) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  // Zonas de chrome de página (best-effort; si no hay match, no pasa nada)
  for (const tag of ['nav', 'header', 'footer', 'aside']) {
    s = s.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }

  // 2. Bloques de código: preservar contenido con fences
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const code = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`;
  });
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
    return '`' + decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')) + '`';
  });

  // 3. Estructura → markdown
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    return `\n\n${'#'.repeat(parseInt(level, 10))} ${text}\n\n`;
  });
  s = s.replace(
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      if (!text) return '';
      if (href.startsWith('#') || href.startsWith('javascript:')) return text;
      return `[${text}](${href})`;
    },
  );
  // \b tras el nombre del tag: evita que <li> matchee <link>, <b> matchee
  // <body> o <i> matchee <img>.
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  s = s.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*');
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) => {
    const text = inner
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `\n\n> ${text}\n\n`;
  });

  // 4. Separadores de bloque
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr[^>]*>/gi, '\n\n---\n\n');
  s = s.replace(/<\/(?:p|div|section|article|main|table|ul|ol|tr|figure|details)>/gi, '\n\n');
  s = s.replace(/<\/(?:td|th)>/gi, ' | ');

  // 5. Eliminar el resto de tags y decodificar entidades
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);

  // 6. Normalizar whitespace
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/** Extrae el <title> del documento si existe. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeHtmlEntities(m[1]!.replace(/\s+/g, ' ')).trim() : null;
}

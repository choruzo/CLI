/**
 * Normalización de nombres de persona: minúsculas, sin acentos ni puntuación,
 * espacios colapsados y alias habituales. Es la misma para los nombres del feed
 * (al construir el índice) y para lo que escribe quien pregunta.
 */

const ALIASES: Record<string, string> = {
  pza: 'plaza',
  pl: 'plaza',
  sta: 'santa',
  sto: 'santo',
  st: 'sant',
  avda: 'avenida',
  av: 'avenida',
  ctra: 'carretera',
  aptos: 'apartaderos',
};

/** «Estación de» y similares no distinguen nada: se quitan al principio. */
const LEADING = /^(estacion|estacio|estaciones)( (de|del|d|la|el))? /;

export function normalizeName(text: string): string {
  const base = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = base.split(' ').map((w) => ALIASES[w] ?? w);
  const joined = words.join(' ').replace(LEADING, '').trim();
  return joined;
}

/** Nombre de una ruta del feed: espacios de relleno colapsados (`"A   -B"` → `"A-B"`). */
export function tidyLabel(text: string): string {
  return text.replace(/\s+-/g, '-').replace(/-\s+/g, '-').replace(/\s+/g, ' ').trim();
}

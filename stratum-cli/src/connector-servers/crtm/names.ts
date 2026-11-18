/**
 * Nombres de cara a la persona: el feed trae las estaciones de Metro y Metro
 * Ligero en MAYÚSCULAS («PLAZA DE CASTILLA») y la EMT en formato mixto con
 * artículos en mayúscula («Blanca De Castilla»). Aquí se dejan en formato de
 * título. También, las etiquetas de línea y los ids estables de las tools.
 */
import type { ModeId } from './feeds.js';
import { isModeId } from './feeds.js';

const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'a', 'al']);

function capitalizeWord(w: string): string {
  // `o'donnell` → `O'Donnell`, `m-30` → `M-30`.
  return w
    .split('-')
    .map((part) =>
      part
        .split("'")
        .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
        .join("'"),
    )
    .join('-');
}

/** Formato de título: artículos y preposiciones en minúscula salvo al principio de cada tramo. */
export function titleCase(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const upper = text === text.toUpperCase();
  let startOfSegment = true;
  return text
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase();
      const isSeparator = word === '-' || word === '/' || word === '–';
      let out: string;
      if (isSeparator) out = word;
      else if (!startOfSegment && SMALL.has(lower)) out = lower;
      else if (upper) out = capitalizeWord(lower);
      else out = word;
      // Tras «Gran Vía - » o un paréntesis empieza otro tramo.
      startOfSegment = isSeparator || /[(:]$/.test(word);
      return out;
    })
    .join(' ');
}

/** Etiqueta de una línea de cara a la persona: `L1`, `ML1`, `27`, `625`. */
export function lineTag(mode: ModeId, shortName: string): string {
  if (mode === 'metro') return /^\d+$/.test(shortName) ? `L${shortName}` : shortName;
  return shortName;
}

/** Id estable de una estación o parada para las tools: `emt:4514`, `ml:est_10_1`. */
export function stationRef(mode: ModeId, stationId: string): string {
  return `${mode}:${stationId}`;
}

/**
 * Id estable de una línea: `interurbano:8__625___`. Hace falta cuando el número
 * se repite (el 1 circula en Aranjuez, en Ciempozuelos y en la EMT), porque el
 * `modo` solo ya no distingue dos líneas «1» de la misma red.
 */
export function lineRef(mode: ModeId, routeId: string): string {
  return `${mode}:${routeId}`;
}

export function parseStationRef(text: string): { mode: ModeId; stationId: string } | null {
  const m = /^([a-z]+):(.+)$/i.exec(text.trim());
  if (!m) return null;
  const mode = m[1]!.toLowerCase();
  return isModeId(mode) ? { mode, stationId: m[2]!.trim() } : null;
}

/** `interurbano:8__625___` → modo y id de línea; `null` si no lleva modo delante. */
export function parseLineRef(text: string): { mode: ModeId; lineId: string } | null {
  const ref = parseStationRef(text);
  return ref ? { mode: ref.mode, lineId: ref.stationId } : null;
}

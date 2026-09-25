/**
 * Frases del indicador de espera (D7). Stratum son estratos: en vez de
 * «Pensando…», el agente sedimenta, perfora y cuenta varvas. Puro y
 * determinista para poder probarlo: la frase depende del turno, de la fase y
 * del tiempo transcurrido, nunca de `Math.random()`.
 */

/** En qué está el turno según lo último que llegó. */
export type ThinkingPhase = 'waiting' | 'reasoning' | 'tool' | 'long';

export const PHRASES: Record<ThinkingPhase, readonly string[]> = {
  // Nada visible todavía: el modelo está leyendo el contexto.
  waiting: [
    'Sedimentando',
    'Estratificando',
    'Leyendo los estratos',
    'Compactando ideas',
    'Decantando',
    'Tamizando matices',
    'Buscando la veta',
    'Contando varvas',
    'Datando capas',
    'Cartografiando el terreno',
    'Midiendo el buzamiento',
    'Aflorando',
  ],
  // Llega razonamiento: presión y temperatura.
  reasoning: [
    'Metamorfoseando',
    'Plegando argumentos',
    'Fundiendo ideas',
    'Subduciendo dudas',
    'Acumulando presión',
    'Cristalizando',
    'Escuchando al magma',
    'Litificando',
  ],
  // Una tool en marcha: trabajo de campo.
  tool: [
    'Excavando',
    'Perforando',
    'Sacando testigos',
    'Tomando muestras',
    'Picando piedra',
    'Cribando',
  ],
  // Pasado un buen rato, un guiño.
  long: [
    'Esto va por eras geológicas',
    'Paciencia mineral',
    'Una capa más',
    'Erosión lenta, pero segura',
  ],
};

/** Cada cuánto cambia la frase. */
export const PHRASE_ROTATE_MS = 4_000;
/** A partir de aquí se muestran los segundos. */
export const SHOW_ELAPSED_AFTER_MS = 3_000;
/** A partir de aquí entran las frases de espera larga. */
export const LONG_WAIT_MS = 30_000;

/** Hash FNV-1a de 32 bits: estable entre ejecuciones y navegadores. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Frase para un turno. Cada turno empieza en un punto distinto de la lista (la
 * semilla es su id) y avanza una posición cada `PHRASE_ROTATE_MS`.
 */
export function thinkingPhrase(seed: string, phase: ThinkingPhase, elapsedMs: number): string {
  const effective: ThinkingPhase =
    elapsedMs >= LONG_WAIT_MS && phase !== 'tool' ? 'long' : phase;
  const list = PHRASES[effective];
  const step = Math.floor(Math.max(0, elapsedMs) / PHRASE_ROTATE_MS);
  return `${list[(hash(`${seed}:${effective}`) + step) % list.length]}…`;
}

/** `12 s`, `1 min 05 s`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  return `${min} min ${String(total % 60).padStart(2, '0')} s`;
}

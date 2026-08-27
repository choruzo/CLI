/**
 * Breakpoints responsive de la UI (§9, Hito 10).
 *
 * Los cortes horizontales del ASCII art viven en `ascii-art.ts`
 * (`getAsciiArt`); aquí están los que afectan al layout: el eje vertical, que
 * no estaba implementado, y el ancho máximo del contenido de conversación.
 *
 * Lógica pura para poder testear los umbrales sin renderizar Ink.
 */

/** Alto mínimo por debajo del cual el banner se reduce (§9). */
export const MIN_ROWS = 24;

/** Ancho máximo del contenido de conversación en terminales amplias (§9). */
export const MAX_CONTENT_WIDTH = 100;

export interface Layout {
  /**
   * `false` cuando `rows < 24`: el banner oculta los tips y el separador,
   * dejando solo el ASCII art y el prompt.
   */
  showTips: boolean;
  /**
   * Ancho del contenido de conversación. En terminales de más de 100 columnas
   * se limita a `MAX_CONTENT_WIDTH`; por debajo, ocupa el ancho disponible.
   */
  contentWidth: number;
}

export function resolveLayout(columns: number, rows: number): Layout {
  const cols = columns > 0 ? columns : 80;
  const r = rows > 0 ? rows : MIN_ROWS;
  return {
    showTips: r >= MIN_ROWS,
    contentWidth: Math.min(cols, MAX_CONTENT_WIDTH),
  };
}

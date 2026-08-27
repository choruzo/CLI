/**
 * Historial de inputs enviados en la sesión (UI §10, Hito 10).
 *
 * Vive en memoria y no persiste entre sesiones. La spec lo situaba en
 * `<InputArea>`, pero el valor del input ya vive en el reducer de `<App>`, así
 * que el estado se guarda ahí y aquí queda solo la lógica pura, testeable sin
 * renderizar Ink.
 *
 * El índice sigue la convención de shell: `null` = "escribiendo un mensaje
 * nuevo" (no se está navegando), `0` = la entrada más reciente, y crece hacia
 * el pasado.
 */

export interface HistoryNav {
  /** Índice tras el movimiento; `null` cuando se vuelve al input en curso. */
  index: number | null;
  /** Valor que debe mostrar el input. */
  value: string;
}

/**
 * Añade un input al historial. Ignora vacíos y no duplica la entrada más
 * reciente si se repite el mismo mensaje dos veces seguidas.
 */
export function pushHistory(history: readonly string[], input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [...history];
  if (history[0] === trimmed) return [...history];
  return [trimmed, ...history];
}

/**
 * `↑` — retrocede hacia mensajes más antiguos. Al llegar al más antiguo se
 * queda ahí (no hace wrap: en un shell tampoco).
 *
 * @param draft Texto que el usuario tenía escrito antes de empezar a navegar;
 *              se restaura al volver al final con `↓`.
 */
export function historyPrev(
  history: readonly string[],
  index: number | null,
  draft: string,
): HistoryNav {
  if (history.length === 0) return { index: null, value: draft };
  const next = index === null ? 0 : Math.min(index + 1, history.length - 1);
  return { index: next, value: history[next] ?? draft };
}

/**
 * `↓` — avanza hacia mensajes más recientes. Al pasar del más reciente se sale
 * de la navegación y se recupera el borrador que había antes de empezar.
 */
export function historyNext(
  history: readonly string[],
  index: number | null,
  draft: string,
): HistoryNav {
  if (index === null || index <= 0) return { index: null, value: draft };
  const next = index - 1;
  return { index: next, value: history[next] ?? draft };
}

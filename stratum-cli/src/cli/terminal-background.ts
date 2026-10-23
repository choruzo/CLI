/**
 * Fondo del terminal mientras corre la TUI (`tui.background`). Ink no pinta el
 * fondo de las celdas vacías: el color se le pide al terminal con OSC 11 y al
 * salir se le devuelve el suyo con OSC 111. Un terminal que no las conoce las
 * ignora, así que no hay nada que detectar.
 */

const SET = (color: string): string => `\x1b]11;${color}\x07`;
const RESET = '\x1b]111\x07';

interface Output {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/**
 * Pide `color` como fondo y devuelve la función que lo restaura. La restauración
 * también va en `exit`: si el proceso muere por otro camino, el terminal del
 * usuario no se queda negro.
 */
export function applyTerminalBackground(
  out: Output,
  color: string,
  proc: Pick<NodeJS.Process, 'once' | 'off'> = process,
): () => void {
  if (!out.isTTY || color === 'terminal') return () => undefined;
  out.write(SET(color));
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    proc.off('exit', restore);
    out.write(RESET);
  };
  proc.once('exit', restore);
  return restore;
}

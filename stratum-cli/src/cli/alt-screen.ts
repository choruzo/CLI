/**
 * Pantalla alternativa del terminal (la de `less` o `vim`) para vistas que
 * ocupan la pantalla entera sin tocar el historial, como la ventana de un
 * subagente. Al entrar, el terminal guarda la pantalla normal (con todo lo
 * que `<Static>` ya imprimió) y al salir la devuelve tal cual.
 *
 * Las secuencias se escriben con el `write` de `useStdout()` de Ink: vacía su
 * región viva, escribe y vuelve a pintar el último fotograma. Escribirlas a
 * pelo dejaría a Ink borrando en una pantalla lo que pintó en la otra.
 */

export const ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[H';
export const ALT_SCREEN_LEAVE = '\x1b[?1049l';

interface Output {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

type Write = (chunk: string) => void;

export interface AltScreen {
  /** `write`: el de Ink (`useStdout().write`); sin él, directo a la salida. */
  enter(write?: Write): void;
  leave(write?: Write): void;
  readonly active: boolean;
}

export function createAltScreen(
  out: Output,
  proc: Pick<NodeJS.Process, 'once' | 'off'> = process,
): AltScreen {
  let active = false;
  const direct: Write = (chunk) => {
    out.write(chunk);
  };
  // Si el proceso sale con la vista abierta, el terminal vuelve a la normal.
  const onExit = (): void => {
    if (active) out.write(ALT_SCREEN_LEAVE);
    active = false;
  };
  return {
    get active() {
      return active;
    },
    enter(write = direct) {
      if (active || !out.isTTY) return;
      write(ALT_SCREEN_ENTER);
      active = true;
      proc.once('exit', onExit);
    },
    leave(write = direct) {
      if (!active) return;
      write(ALT_SCREEN_LEAVE);
      active = false;
      proc.off('exit', onExit);
    },
  };
}

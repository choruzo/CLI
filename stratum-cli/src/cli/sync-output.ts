/**
 * Synchronized output (modo DEC `?2026`) para los fotogramas de Ink.
 *
 * Ink 5 repinta la región viva borrándola (`ESC[2K` por línea) y reescribiéndola
 * en cada render. Sin sincronizar, el terminal enseña el estado intermedio
 * —líneas borradas, texto a medias— y eso es el parpadeo, sobre todo con una
 * región viva alta (turnos largos, subagentes). Envolver la escritura entre
 * `?2026h` y `?2026l` le pide al terminal que no pinte hasta tenerla entera.
 *
 * Va en **la misma** llamada a `write` que el fotograma: no hay entrelazado
 * posible con otras escrituras. Un terminal que no conoce el modo lo ignora
 * (es un modo privado DEC), así que no hay nada que detectar. Apagado con
 * `STRATUM_NO_SYNC_OUTPUT=1` si algún terminal lo pinta mal.
 */

export const SYNC_BEGIN = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

interface Output {
  isTTY?: boolean;
  // `any` para aceptar la sobrecarga de `write` de `process.stdout` sin reescribirla.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  write: (chunk: any, ...rest: any[]) => boolean;
}

/**
 * ¿Es esta escritura un fotograma de Ink? Un fotograma borra líneas o abarca
 * varias; las escrituras sueltas (OSC, cursor, pantalla alternativa) se dejan
 * como están: sincronizarlas no aporta y `?1049` no debe ir dentro de un bloque.
 */
export function isFrameWrite(chunk: unknown): chunk is string {
  if (typeof chunk !== 'string') return false;
  if (chunk.includes('\x1b[?1049') || chunk.includes('\x1b[?2026')) return false;
  return chunk.includes('\x1b[2K') || chunk.includes('\n');
}

/** Envuelve `chunk` en el bloque sincronizado. */
export function wrapSynchronized(chunk: string): string {
  return SYNC_BEGIN + chunk + SYNC_END;
}

/**
 * Hace que cada fotograma de Ink salga sincronizado y devuelve la función que
 * deshace el parche. No hace nada sin TTY ni con `STRATUM_NO_SYNC_OUTPUT=1`.
 */
export function installSyncOutput(out: Output, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!out.isTTY || env['STRATUM_NO_SYNC_OUTPUT'] === '1') return () => undefined;
  const original = out.write;
  out.write = function patched(this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    const data = isFrameWrite(chunk) ? wrapSynchronized(chunk) : chunk;
    return original.call(out, data, ...rest);
  };
  let restored = false;
  return (): void => {
    if (restored) return;
    restored = true;
    out.write = original;
  };
}

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
 * Hace que los fotogramas de Ink salgan sincronizados y devuelve la función que
 * deshace el parche (y vacía lo pendiente). No hace nada sin TTY ni con
 * `STRATUM_NO_SYNC_OUTPUT=1`.
 *
 * Las escrituras de fotograma de un mismo tick se **fusionan en un solo bloque**:
 * al commitear a `<Static>` Ink escribe seguidas el borrado de la región viva, el
 * texto estático y el fotograma nuevo, y en tres bloques el terminal podría pintar
 * entre ellos. Se vacían en una microtarea, antes de que el proceso ceda al
 * terminal; una escritura que no es de fotograma, o que lleva callback/codificación,
 * vacía antes lo pendiente para no cambiar el orden.
 */
export function installSyncOutput(
  out: Output,
  env: NodeJS.ProcessEnv = process.env,
  proc: Pick<NodeJS.Process, 'once' | 'off'> = process,
): () => void {
  if (!out.isTTY || env['STRATUM_NO_SYNC_OUTPUT'] === '1') return () => undefined;
  const original = out.write;
  let pending: string | null = null;
  const flush = (): void => {
    if (pending === null) return;
    const data = pending;
    pending = null;
    original.call(out, wrapSynchronized(data));
  };
  out.write = function patched(this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (rest.length === 0 && isFrameWrite(chunk)) {
      if (pending === null) {
        pending = chunk;
        queueMicrotask(flush);
      } else {
        pending += chunk;
      }
      return true;
    }
    flush();
    return original.call(out, chunk, ...rest);
  };
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    proc.off('exit', restore);
    flush();
    out.write = original;
  };
  // Un `process.exit()` síncrono tras pintar no deja correr la microtarea.
  proc.once('exit', restore);
  return restore;
}

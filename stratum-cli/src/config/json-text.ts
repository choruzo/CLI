/**
 * Lectura de ficheros JSON escritos a mano (`.stratumrc.json`). Puro, sin
 * tipos de Node: lo comparten la CLI y el sidecar de Desktop.
 */

/**
 * Quita el BOM UTF-8 inicial. El Bloc de notas de Windows lo añade al guardar
 * y `JSON.parse` lo rechaza como «Unexpected token», sin decir qué pasa.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Línea y columna de un `SyntaxError` de `JSON.parse` (V8 da la posición o la línea). */
export function jsonErrorPosition(err: unknown, text: string): { line?: number; column?: number } {
  const message = err instanceof Error ? err.message : '';
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) {
    const before = text.slice(0, Number(pos[1]));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
  }
  if (/end of JSON input/i.test(message)) {
    const lines = text.split('\n');
    return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
  }
  return {};
}

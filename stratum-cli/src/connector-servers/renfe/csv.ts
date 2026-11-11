/**
 * CSV de GTFS en streaming: línea a línea, sin cargar el fichero entero (el
 * `stop_times.txt` real pesa 270 MB). Soporta comillas dobles (con comas y
 * saltos de línea dentro), BOM inicial y CRLF. Cada campo se recorta: el feed de
 * Renfe rellena con espacios (`"C1  "`).
 */
import { StringDecoder } from 'node:string_decoder';

export type CsvRow = Record<string, string>;

/** Divide una línea CSV ya completa (sin salto final) en campos recortados. */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',').map((f) => f.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** ¿Tiene la línea un número impar de comillas (un campo entrecomillado sigue abierto)? */
function openQuote(s: string): boolean {
  let n = 0;
  for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) n++;
  return n % 2 === 1;
}

/** Líneas lógicas del texto: une las que quedan dentro de un campo entrecomillado. */
function* logicalLines(state: { pending: string }, final: boolean): Generator<string> {
  let start = 0;
  for (;;) {
    let nl = state.pending.indexOf('\n', start);
    if (nl < 0) break;
    // Mientras haya una comilla abierta, la línea sigue en la siguiente.
    let incomplete = false;
    while (openQuote(state.pending.slice(start, nl))) {
      const next = state.pending.indexOf('\n', nl + 1);
      if (next < 0) {
        incomplete = true;
        break;
      }
      nl = next;
    }
    if (incomplete) break;
    let line = state.pending.slice(start, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield line;
    start = nl + 1;
  }
  state.pending = state.pending.slice(start);
  if (final && state.pending.trim() !== '') {
    const rest = state.pending.endsWith('\r') ? state.pending.slice(0, -1) : state.pending;
    state.pending = '';
    yield rest;
  }
}

/** Filas del CSV como objetos `columna → valor`. La primera línea es la cabecera. */
export async function* csvRows(source: AsyncIterable<Buffer | string>): AsyncGenerator<CsvRow> {
  const decoder = new StringDecoder('utf8');
  const state = { pending: '' };
  let header: string[] | null = null;
  let first = true;

  function* rowsOf(final: boolean): Generator<CsvRow> {
    for (const line of logicalLines(state, final)) {
      if (line.trim() === '') continue;
      const fields = splitCsvLine(line);
      if (!header) {
        header = fields;
        continue;
      }
      const row: CsvRow = {};
      for (let i = 0; i < header.length; i++) row[header[i]!] = fields[i] ?? '';
      yield row;
    }
  }

  for await (const chunk of source) {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    state.pending += text;
    yield* rowsOf(false);
  }
  state.pending += decoder.end();
  yield* rowsOf(true);
}

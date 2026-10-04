import { readFileSync } from 'fs';
import type { TraceRecord } from './records.js';

/**
 * Lectura completa de una traza guardada. Tolerante: una línea que no es JSON
 * (el final de un fichero que otro proceso está escribiendo) se salta, y un
 * fichero que no se puede leer es una traza vacía.
 */
export function parseTraceText(text: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as TraceRecord;
      if (rec && typeof rec === 'object' && typeof rec.t === 'string') out.push(rec);
    } catch {
      /* línea a medias */
    }
  }
  return out;
}

export function readTraceFile(file: string): TraceRecord[] {
  try {
    return parseTraceText(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

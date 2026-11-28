/**
 * La nota de voz: la marca que dice de dónde salió el texto (`M25 fase 4`).
 *
 * Es **puro**, sin React, y la regla es la del Dot compacto
 * (`src-tauri/ask/ask.js`, que es otra ventana y otro fichero): la marca solo se
 * pone si lo que dejó la nota sigue en el campo **tal cual**, ni un carácter
 * cambiado en esa parte. Lo que la persona corrige ya es suyo.
 *
 *   mmss(7.4) = '0:07'             mmss(102) = '1:42'    mmss(0) = '0:00'
 *   voiceMarker(7, false)  = '[nota de voz, 0:07] '
 *   voiceMarker(102, true) = '[nota de voz, 1:42, recortada] '
 *
 *   campo vacío + «hola»          → '[nota de voz, 0:07] hola'
 *   «recuérdame» + «la compra»    → '[nota de voz, 0:07] recuérdame la compra'
 *   «recuérdame la compra» tocado → 'recuérdame la compra' (sin marca)
 */

/** Los segundos de la nota, en `M:SS` (los minutos no se rellenan). */
export function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** La marca del principio, con el aviso de que el audio se cortó por el tope. */
export function voiceMarker(seconds: number, capped: boolean): string {
  return `[nota de voz, ${mmss(seconds)}${capped ? ', recortada' : ''}] `;
}

/** Lo que último dejó una nota: el texto exacto que se puso, para reconocerlo al enviar. */
export interface VoiceNote {
  inserted: string;
  durationSec: number;
  capped: boolean;
}

/** El texto, detrás de lo que ya hubiera, con un espacio de por medio (sin doblarlo). */
export function insertNote(before: string, text: string): string {
  const gap = before !== '' && !/\s$/.test(before) ? ' ' : '';
  return before + gap + text;
}

/** El mensaje que se envía: con la marca delante si la nota sigue intacta en el campo. */
export function withMarker(draft: string, note: VoiceNote | null): string {
  if (!note || note.inserted === '' || !draft.includes(note.inserted)) return draft;
  return voiceMarker(note.durationSec, note.capped) + draft;
}

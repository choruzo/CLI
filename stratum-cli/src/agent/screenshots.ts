/**
 * M15 — las capturas de pantalla que el modelo puede ver (PRD de Stratum Dot
 * §23.4). Viven aquí, en memoria y fuera del historial: el historial (y con él
 * la sesión guardada, la conversación duradera, la traza y la compactación)
 * solo lleva el texto de cada resultado, con los metadatos de su captura.
 *
 * Solo las últimas `limit` se mandan al modelo, cada una detrás del resultado
 * de la tool que la tomó. Las anteriores dejan de enviarse sin tocar el
 * historial: su texto ya dice qué eran. Una captura cuyo resultado ya no está
 * en el historial (compactado) tampoco se manda.
 */
import type { Message, ToolImage } from './types.js';

/** Capturas en el contexto del modelo. El spike de §23.9 funcionó con 2. */
export const SCREENSHOTS_IN_CONTEXT = 2;

/** Una captura que acompaña a una petición: va tras el resultado `toolCallId`. */
export interface RequestImage {
  toolCallId: string;
  image: ToolImage;
}

export class ScreenshotBuffer {
  private entries: RequestImage[] = [];

  constructor(private readonly limit: number = SCREENSHOTS_IN_CONTEXT) {}

  add(toolCallId: string, image: ToolImage): void {
    this.entries.push({ toolCallId, image });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** Las que siguen en el historial, en su orden. */
  forRequest(messages: readonly Message[]): RequestImage[] {
    if (this.entries.length === 0) return [];
    const ids = new Set<string>();
    for (const m of messages) if (m.role === 'tool' && m.tool_call_id) ids.add(m.tool_call_id);
    return this.entries.filter((e) => ids.has(e.toolCallId));
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

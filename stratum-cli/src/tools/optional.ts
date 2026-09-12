/**
 * Hito 13 — Degradación explícita de las tools opcionales (P2 pendiente de
 * `gentle-pi`).
 *
 * La regla: cuando lo que falta es un RECURSO opcional (una dependencia nativa,
 * una API key, un binario externo, la red), la tool no devuelve `tool_error`
 * sino un resultado exitoso cuyo texto le dice al modelo qué hacer en su lugar.
 * Un error interrumpe el loop y consume un reintento; una instrucción de
 * fallback lo mantiene trabajando con la siguiente mejor opción.
 *
 * Un error de verdad — parámetros inválidos, una ruta que no existe, un fallo
 * al escribir — sigue siendo un error. La distinción es «no tengo esta
 * capacidad» frente a «tu llamada está mal».
 *
 * Nota de ingeniería para cuando envolvamos un binario npm GLOBAL: en Windows,
 * npm instala solo shims `.cmd`/`.ps1` y ningún `.exe`, así que `execFile`
 * (que usa `CreateProcess` sin shell) siempre da `ENOENT`. La salida es
 * resolver el `package.json` del paquete, sacar su `bin` real y lanzarlo con
 * `process.execPath` — sin shell, para que los argumentos no se reinterpreten.
 * `tools/mcp/installer.ts` ya hace justo eso para la carpeta gestionada.
 *
 * Ver CLI-DOC/Investigacion/gentle-pi.md §2 (P2).
 */
import type { ToolResult } from '../agent/types.js';

export interface UnavailableOptions {
  /** Qué falta, en una frase: «Tavily API key», «la red», «sqlite-vec». */
  missing: string;
  /** Qué hacer en su lugar, en orden de preferencia. Al menos una. */
  alternatives: string[];
  /** Cómo recuperar la capacidad (config, instalación). Para el usuario, no para el modelo. */
  howToEnable?: string;
}

/**
 * Resultado de «capacidad no disponible». `ok: true` a propósito: el modelo
 * recibe una instrucción, no una excepción.
 */
export function unavailable(opts: UnavailableOptions): ToolResult {
  const alternatives = opts.alternatives.map((a) => `- ${a}`).join('\n');
  const enable = opts.howToEnable ? `\n\nTo enable it: ${opts.howToEnable}` : '';
  return {
    ok: true,
    output:
      `UNAVAILABLE: ${opts.missing}. This is not an error in your call — the capability is ` +
      `not configured in this environment.\n\nDo this instead:\n${alternatives}${enable}`,
  };
}

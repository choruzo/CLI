/**
 * Cierre de un turno cancelado (§12.12). Un Ctrl+C puede llegar en cualquier
 * punto del turno, y el historial que queda tiene que seguir siendo uno que el
 * provider acepte en el turno siguiente:
 *
 *  - un `assistant` con `tool_calls` necesita un mensaje `tool` por cada id
 *    (OpenAI rechaza el historial entero con un 400 si falta uno);
 *  - dos mensajes `user` seguidos los rechazan las plantillas de chat que
 *    exigen alternancia (Mistral, algunas de Gemma y Llama), con un error que
 *    deja la sesión inutilizable.
 *
 * El loop ya responde a las tool calls que cancela; esto es la red de
 * seguridad para lo que no pasa por él (un generador abandonado a mitad de un
 * `yield`) y para el `user` que se quedó sin respuesta.
 */
import type { Message } from './types.js';

/** Texto de resultado para una tool call que el usuario canceló. */
export const CANCELLED_BY_USER = 'Cancelled by the user.';

/**
 * Añade un resultado `tool` de cancelación a cada tool call del último
 * `assistant` que se quedó sin respuesta. Devuelve cuántas cerró. Solo mira la
 * cola: el loop añade los mensajes en orden, así que un hueco solo puede estar
 * al final.
 */
export function closeDanglingToolCalls(messages: Message[]): number {
  let i = messages.length - 1;
  while (i >= 0 && messages[i]!.role === 'tool') i--;
  const last = messages[i];
  if (!last || last.role !== 'assistant' || !last.tool_calls?.length) return 0;
  const answered = new Set(
    messages.slice(i + 1).flatMap((m) => (m.tool_call_id ? [m.tool_call_id] : [])),
  );
  let closed = 0;
  for (const tc of last.tool_calls) {
    if (answered.has(tc.id)) continue;
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      name: tc.function.name,
      content: CANCELLED_BY_USER,
    });
    closed++;
  }
  return closed;
}

/**
 * Añade un aviso del runtime (p. ej. «el job #3 terminó») al final del
 * historial sin crear un mensaje: se anexa al último `user` o `tool`, que es
 * lo que hay al empezar cualquier iteración del loop.
 *
 * No es un `user` nuevo a propósito. A mitad de turno rompería dos cosas: la
 * alternancia de roles que exigen varias plantillas de chat y, sobre todo, el
 * ancla de la compresión de contexto (§12.4), que es «el último `user`» — un
 * aviso pasaría a ser la tarea en curso y la tarea de verdad se comprimiría.
 * Tampoco va en el system prompt: cambiaría el prefijo y tiraría la caché de
 * todo el historial por cada job. Anexado al final, el aviso queda donde el
 * modelo más lo ve, persiste con la sesión y no invalida nada anterior.
 *
 * El mensaje se muta en el sitio: es el mismo objeto que la traza ya conoce.
 */
export function appendRuntimeNotice(messages: Message[], notice: string): void {
  const last = messages.at(-1);
  if (last && (last.role === 'user' || last.role === 'tool') && typeof last.content === 'string') {
    last.content = last.content ? `${last.content}\n\n${notice}` : notice;
    return;
  }
  messages.push({ role: 'user', content: notice });
}

/**
 * Añade la petición `input` del usuario al historial sin dejar dos `user`
 * seguidos: si el último mensaje es una petición que nunca recibió respuesta
 * (turno cancelado antes de que el modelo contestase, que acabó en error, o
 * un aviso de reanudación), la nueva se funde con ella y se le dice al modelo
 * que aquello no tuvo respuesta. Así no se pierde lo que se pidió ni se rompe
 * la alternancia.
 */
export function pushUserInput(messages: Message[], input: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user' && typeof last.content === 'string') {
    messages[messages.length - 1] = {
      ...last,
      content: `${last.content}\n\n[No response was given to the message above.]\n\n${input}`,
    };
    return;
  }
  messages.push({ role: 'user', content: input });
}

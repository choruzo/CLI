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

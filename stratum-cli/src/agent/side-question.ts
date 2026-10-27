/**
 * `/btw` (UX-4): una pregunta lateral sobre la conversación en curso. Es una
 * llamada auxiliar (`tracedCompletion`, origen `side-question`) que lee el
 * historial pero no lo toca: ni la pregunta ni la respuesta entran en la
 * conversación, en la memoria ni en el uso de la sesión.
 */

import type { Message } from './types.js';
import { closeDanglingToolCalls } from './cancel.js';

/** Plazo de una pregunta lateral; la cancelación del usuario la corta antes. */
export const SIDE_QUESTION_TIMEOUT_MS = 120_000;

/**
 * Lo que se le dice al modelo junto a la pregunta. Sin tools: si las pidiera
 * no habría quien las ejecutara, así que se le avisa de que no las tiene.
 */
export function sideQuestionBlock(question: string): string {
  return [
    '<side_question>',
    'The user asks a quick side question about this conversation. Answer it briefly,',
    'using only what is already in the conversation. You cannot call tools now, and',
    'this exchange will not be added to the conversation: do not continue the task.',
    '',
    question,
    '</side_question>',
  ].join('\n');
}

/**
 * Mensajes de la petición: una copia del historial más la pregunta. Con un turno
 * en curso el historial puede acabar en tool calls sin respuesta (el provider
 * rechazaría la petición): en la copia se cierran como canceladas. Si acaba en
 * un `user`, la pregunta se le anexa en vez de abrir otro: dos `user` seguidos
 * rompen la alternancia que exigen varias plantillas de chat.
 */
export function sideQuestionMessages(history: readonly Message[], question: string): Message[] {
  const messages = [...history];
  closeDanglingToolCalls(messages);
  const block = sideQuestionBlock(question);
  const last = messages.at(-1);
  if (last?.role === 'user') {
    messages[messages.length - 1] = { ...last, content: `${last.content ?? ''}\n\n${block}` };
  } else {
    messages.push({ role: 'user', content: block });
  }
  return messages;
}

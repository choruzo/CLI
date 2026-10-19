import type { ProtocolStateEvent } from './events.js';
import type { ProtocolChatMessage, ProtocolToolCall } from './model.js';

/**
 * La conversación de una sesión como **función de sus eventos de estado**. Es
 * la única definición: el anfitrión la usa para llevar el transcript que va en
 * sus fotos, y quien reduce eventos (`applySessionEvent`) usa la misma, así que
 * una foto y los eventos que la siguen dan siempre la misma conversación.
 *
 * Qué entra:
 *
 *  - `run.started` → la entrada del usuario (`run.input`);
 *  - `message.completed` del agente principal → un bloque del asistente;
 *  - `tool.*` del agente principal → una línea por llamada, que cambia de estado;
 *  - `run.failed` / `run.cancelled` → cómo acabó el turno.
 *
 * Los fragmentos volátiles **no** entran: el texto a medias vive en `partial`
 * y solo se vuelve mensaje cuando un `message.completed` lo cierra.
 */

/** Lo que una foto conserva de la conversación. Lo más antiguo se descarta primero. */
export const TRANSCRIPT_LIMITS = {
  messages: 200,
  /** Texto de un mensaje. Más largo: se recorta y se marca `truncated`. */
  textChars: 12_000,
  /** Descripción de una tool dentro de la conversación. */
  descriptionChars: 300,
  /** Suma de los textos: una foto es un solo mensaje del protocolo y tiene que caber. */
  totalChars: 150_000,
} as const;

export interface ProtocolTranscript {
  messages: ProtocolChatMessage[];
  /** Se descartaron entradas antiguas. Una vez `true`, no vuelve a `false`. */
  messagesTruncated: boolean;
}

export const EMPTY_TRANSCRIPT: ProtocolTranscript = { messages: [], messagesTruncated: false };

/**
 * Recorta a `max` caracteres con `…` al final, **sin partir un par de
 * surrogates**: medio emoji es un texto mal formado, que un cliente estricto
 * (el JSON de Rust) rechaza junto con todo el mensaje que lo lleva.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

function clipped(text: string, max: number): { text: string; truncated?: true } {
  return text.length > max ? { text: clipText(text, max), truncated: true } : { text };
}

function size(message: ProtocolChatMessage): number {
  return message.kind === 'tool' ? message.description.length : message.text.length;
}

function bounded(messages: ProtocolChatMessage[], truncated: boolean): ProtocolTranscript {
  let total = 0;
  for (const m of messages) total += size(m);
  let from = 0;
  // Siempre queda al menos la última entrada, quepa o no.
  while (
    from < messages.length - 1 &&
    (messages.length - from > TRANSCRIPT_LIMITS.messages || total > TRANSCRIPT_LIMITS.totalChars)
  ) {
    total -= size(messages[from]!);
    from++;
  }
  return from === 0
    ? { messages, messagesTruncated: truncated }
    : { messages: messages.slice(from), messagesTruncated: true };
}

/**
 * Una conversación que no sale de eventos (M12: la que se importa de Stratum
 * Desktop D4), acotada con los mismos topes que la que sí.
 */
export function boundedTranscript(messages: ProtocolChatMessage[]): ProtocolTranscript {
  return bounded(messages, false);
}

function isOpen(state: ProtocolToolCall['state']): boolean {
  return state === 'pending' || state === 'running';
}

function withTool(
  transcript: ProtocolTranscript,
  id: string,
  at: number,
  call: ProtocolToolCall,
): ProtocolTranscript {
  const { messages } = transcript;
  // Un id ya cerrado que vuelve a aparecer es otra llamada: los ids del modelo se repiten.
  for (let i = messages.length - 1; i >= 0; i--) {
    const known = messages[i]!;
    if (known.kind !== 'tool' || known.callId !== call.id) continue;
    // De otro run, aunque quedase abierta: los ids del modelo se repiten entre turnos.
    if (known.runId !== call.runId || !isOpen(known.state)) break;
    if (known.state === call.state) return transcript;
    const out = messages.slice();
    out[i] = { ...known, state: call.state };
    return { messages: out, messagesTruncated: transcript.messagesTruncated };
  }
  const entry: ProtocolChatMessage = {
    kind: 'tool',
    id,
    runId: call.runId,
    at,
    callId: call.id,
    name: call.name,
    description: clipped(call.description, TRANSCRIPT_LIMITS.descriptionChars).text,
    ...(call.target ? { target: call.target } : {}),
    state: call.state,
  };
  return bounded([...messages, entry], transcript.messagesTruncated);
}

/**
 * Aplica un evento de estado a la conversación. Devuelve **el mismo objeto** si
 * el evento no la cambia. No comprueba el `seq`: eso es de quien llama.
 */
export function applyTranscriptEvent(
  transcript: ProtocolTranscript,
  event: ProtocolStateEvent,
): ProtocolTranscript {
  const id = `m${event.seq}`;
  const add = (message: ProtocolChatMessage): ProtocolTranscript =>
    bounded([...transcript.messages, message], transcript.messagesTruncated);

  switch (event.type) {
    case 'run.started': {
      const { run } = event.data;
      const { text, truncated } = clipped(run.input, TRANSCRIPT_LIMITS.textChars);
      return add({
        kind: 'user',
        id,
        runId: run.id,
        at: event.at,
        text,
        ...(truncated || run.inputTruncated ? { truncated: true } : {}),
      });
    }
    case 'message.completed': {
      if (event.subagentId || !event.data.text) return transcript;
      return add({
        kind: 'assistant',
        id,
        runId: event.runId ?? '',
        at: event.at,
        ...clipped(event.data.text, TRANSCRIPT_LIMITS.textChars),
      });
    }
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.blocked':
      if (event.subagentId || event.data.call.subagentId) return transcript;
      return withTool(transcript, id, event.at, event.data.call);
    case 'run.failed':
    case 'run.cancelled': {
      const { run } = event.data;
      return add({
        kind: 'outcome',
        id,
        runId: run.id,
        at: event.at,
        status: event.type === 'run.failed' ? 'failed' : 'cancelled',
        text: clipped(run.error ?? '', TRANSCRIPT_LIMITS.textChars).text,
      });
    }
    default:
      return transcript;
  }
}

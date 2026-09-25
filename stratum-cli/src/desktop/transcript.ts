import type { AgentEvent, Message } from '../agent/types.js';
import type {
  TranscriptAttachment,
  TranscriptPart,
  TranscriptToolCall,
  TranscriptTurn,
  TranscriptTurnStatus,
  WorkspaceFileInfo,
} from './protocol.js';

/**
 * Transcript visible de una conversación (D4): lo que la UI pinta, construido
 * por el sidecar a partir de los mismos `AgentEvent` que emite. Puro y sin
 * estado global: los tests lo ejercitan sin agente.
 *
 * Es el espejo de `conversation-reducer.ts` del webview en lo que se guarda: el
 * webview no puede importar código de stratum-cli (solo tipos), y aquí basta
 * con el resultado final de cada turno. Se recortan las salidas de tool para
 * que el fichero no crezca con cada `read_file`.
 */

/** Tope de la salida o el error de una tool guardados en el transcript. */
export const TRANSCRIPT_TOOL_OUTPUT_CHARS = 8_000;
/** Tope de los argumentos de una tool guardados en el transcript. */
export const TRANSCRIPT_TOOL_INPUT_CHARS = 4_000;
/** Tope de cada bloque de razonamiento guardado en el transcript. */
export const TRANSCRIPT_REASONING_CHARS = 8_000;
const REASONING_CLIPPED = '\n… (recortado)';
/** Longitud del título derivado del primer mensaje. */
export const TITLE_CHARS = 60;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (recortado)` : text;
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function newTurn(
  turnId: string,
  text: string,
  attachments: TranscriptAttachment[],
  status: TranscriptTurnStatus,
  now: Date = new Date(),
): TranscriptTurn {
  return {
    turnId,
    user: { text, ...(attachments.length > 0 ? { attachments } : {}) },
    parts: [],
    toolCalls: {},
    status,
    startedAt: now.toISOString(),
  };
}

function appendText(parts: TranscriptPart[], delta: string): TranscriptPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === 'text')
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + delta }];
  return [...parts, { kind: 'text', text: delta }];
}

/**
 * Fragmentos de razonamiento consecutivos forman un bloque; pasado el tope se
 * dejan de guardar (el webview los tiene enteros mientras la conversación está
 * abierta).
 */
function appendReasoning(parts: TranscriptPart[], delta: string): TranscriptPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind !== 'reasoning') {
    return [...parts, { kind: 'reasoning', text: clipReasoning(delta) }];
  }
  if (last.text.endsWith(REASONING_CLIPPED)) return parts;
  return [...parts.slice(0, -1), { kind: 'reasoning', text: clipReasoning(last.text + delta) }];
}

function clipReasoning(text: string): string {
  return text.length > TRANSCRIPT_REASONING_CHARS
    ? text.slice(0, TRANSCRIPT_REASONING_CHARS) + REASONING_CLIPPED
    : text;
}

function upsertTool(
  turn: TranscriptTurn,
  id: string,
  name: string,
  patch: Partial<TranscriptToolCall>,
): TranscriptTurn {
  const existing = turn.toolCalls[id];
  const parts = existing ? turn.parts : [...turn.parts, { kind: 'tool' as const, id }];
  const base: TranscriptToolCall = existing ?? { id, name, state: 'pending', input: '' };
  return {
    ...turn,
    parts,
    toolCalls: { ...turn.toolCalls, [id]: { ...base, name: name || base.name, ...patch } },
  };
}

export function statusForStop(stopReason: string): TranscriptTurnStatus {
  if (stopReason === 'cancelled') return 'cancelled';
  if (stopReason === 'error') return 'error';
  return 'done';
}

/** Aplica un evento del agente al turno. Los que no se pintan lo dejan igual. */
export function applyTranscriptEvent(turn: TranscriptTurn, event: AgentEvent): TranscriptTurn {
  switch (event.type) {
    case 'text_delta':
      return { ...turn, status: 'streaming', parts: appendText(turn.parts, event.delta) };
    case 'thinking':
      return { ...turn, status: 'streaming', parts: appendReasoning(turn.parts, event.text) };
    case 'tool_call_start':
      return upsertTool(turn, event.id, event.name, {
        input: clip(event.input_so_far, TRANSCRIPT_TOOL_INPUT_CHARS),
      });
    case 'tool_call_ready':
      return upsertTool(turn, event.id, event.name, {
        state: 'running',
        input: clip(stringifyInput(event.input), TRANSCRIPT_TOOL_INPUT_CHARS),
      });
    case 'tool_result':
      return upsertTool(turn, event.id, event.name, {
        state: 'completed',
        output: clip(event.result, TRANSCRIPT_TOOL_OUTPUT_CHARS),
        durationMs: event.durationMs,
      });
    case 'tool_error':
      return upsertTool(turn, event.id, event.name, {
        state: 'error',
        error: clip(event.error, TRANSCRIPT_TOOL_OUTPUT_CHARS),
      });
    case 'questions_answered': {
      // Tool de control: el loop no emite `tool_result` para `question`.
      const output = event.answers?.length
        ? event.answers.map((a) => `${a.question} → ${a.answer}`).join('\n')
        : 'Sin respuesta: el asistente sigue con supuestos.';
      let next = turn;
      for (const call of Object.values(turn.toolCalls)) {
        if (call.name === 'question' && (call.state === 'pending' || call.state === 'running')) {
          next = upsertTool(next, call.id, call.name, { state: 'completed', output });
        }
      }
      return next;
    }
    case 'warning':
      return {
        ...turn,
        parts: [...turn.parts, { kind: 'notice', tone: 'warning', text: event.message }],
      };
    case 'error':
      return {
        ...turn,
        parts: [...turn.parts, { kind: 'notice', tone: 'error', text: event.message }],
      };
    case 'done':
      return { ...turn, status: statusForStop(event.stopReason), stopReason: event.stopReason };
    default:
      return turn;
  }
}

/** Un tool call que no llegó a terminar no se guarda como «ejecutándose». */
export function settleTranscriptTurn(
  turn: TranscriptTurn,
  status?: TranscriptTurnStatus,
): TranscriptTurn {
  const toolCalls: Record<string, TranscriptToolCall> = {};
  for (const [id, call] of Object.entries(turn.toolCalls)) {
    toolCalls[id] =
      call.state === 'pending' || call.state === 'running'
        ? { ...call, state: 'error', error: call.error ?? 'No llegó a terminar.' }
        : call;
  }
  const open = turn.status === 'streaming' || turn.status === 'queued';
  return { ...turn, toolCalls, ...(status && open ? { status } : {}) };
}

/** Añade las tarjetas de fichero del turno (un fichero reescrito sustituye a la anterior). */
export function addTranscriptFiles(
  turn: TranscriptTurn,
  files: WorkspaceFileInfo[],
): TranscriptTurn {
  return {
    ...turn,
    files: [...(turn.files ?? []).filter((f) => !files.some((n) => n.path === f.path)), ...files],
  };
}

/**
 * Título a partir del primer mensaje: una línea, ~60 caracteres cortados por
 * palabra. Sin texto (solo adjuntos), el nombre del primer fichero.
 */
export function deriveTitle(text: string, attachments: TranscriptAttachment[] = []): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return attachments[0]?.name ?? 'Nueva conversación';
  if (line.length <= TITLE_CHARS) return line;
  const cut = line.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const ATTACHMENTS_BLOCK = /^<attachments>\n[\s\S]*?\n<\/attachments>(?:\n\n)?/;

/**
 * Transcript aproximado a partir del historial del agente, para las sesiones
 * guardadas antes de D4 (sin transcript propio). Pierde lo que el historial no
 * guarda (avisos, tarjetas de fichero) y, tras una compresión, lo resumido.
 */
export function transcriptFromMessages(messages: Message[], at: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  let seq = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'user') {
      if (current) turns.push(current);
      const attachments: TranscriptAttachment[] = [];
      const block = ATTACHMENTS_BLOCK.exec(content);
      if (block) {
        for (const line of block[0].split('\n')) {
          const match = /^- (\S+) \(/.exec(line);
          if (match) {
            const path = match[1];
            attachments.push({ path, name: path.split('/').pop() ?? path, size: 0 });
          }
        }
      }
      current = newTurn(
        `legacy-${++seq}`,
        block ? content.slice(block[0].length) : content,
        attachments,
        'done',
      );
      current.startedAt = at;
      continue;
    }
    if (!current) continue;
    if (m.role === 'assistant') {
      // Un resumen de compresión no es una respuesta que el usuario viera.
      if (content && !content.startsWith('<summary>')) {
        current = { ...current, parts: appendText(current.parts, content) };
      }
      for (const tc of m.tool_calls ?? []) {
        current = upsertTool(current, tc.id, tc.function.name, {
          state: 'completed',
          input: clip(tc.function.arguments, TRANSCRIPT_TOOL_INPUT_CHARS),
        });
      }
    } else if (m.role === 'tool' && m.tool_call_id && current.toolCalls[m.tool_call_id]) {
      current = upsertTool(current, m.tool_call_id, '', {
        output: clip(content, TRANSCRIPT_TOOL_OUTPUT_CHARS),
      });
    }
  }
  if (current) turns.push(current);
  return turns;
}

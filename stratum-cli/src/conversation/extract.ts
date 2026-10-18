/**
 * Las dos funciones del modelo que mantiene la memoria de sesión (M11). Son
 * contratos distintos aunque las haga el mismo modelo:
 *
 *  - **Extractor** — precisión: devuelve hechos, decisiones, restricciones,
 *    preferencias, tareas, resultados y entidades **con sus fuentes**, en JSON.
 *    No infiere ni completa: lo que no está en el trozo no sale.
 *  - **Resumen** — continuidad: actualiza el resumen narrativo anterior con lo
 *    que pasó en el trozo (qué se hizo, qué se intenta, en qué estado está).
 *
 * Las dos pasan por `tracedCompletion` con su origen. Lo que ven de una tool
 * es un extracto acotado (cabeza y cola) con el id de la entrada original: la
 * salida completa sigue en el `ConversationStore`, no entra en la memoria.
 */
import { z } from 'zod';
import type { ProtocolAgentMessage } from '../protocol/index.js';
import { ThinkTagSplitter } from '../providers/openai-compatible.js';
import { tracedCompletion } from '../trace/llm-call.js';
import type { TraceScope } from '../trace/recorder.js';
import { truncateToolOutput } from '../tools/truncate.js';
import type { MemoryModel } from './models.js';
import {
  MEMORY_ITEM_KINDS,
  normalizeKey,
  type Extraction,
  type ExtractedItem,
  type SessionMemory,
} from './session-memory.js';

/** Una entrada del trozo que se compacta: su id en el store y el mensaje. */
export interface ChunkEntry {
  id: string;
  message: ProtocolAgentMessage;
}

const TEXT_CHARS = 4_000;
const TOOL_CHARS = 1_500;
const ARGS_CHARS = 600;
/** Tope del trozo entero en la petición. */
const CHUNK_CHARS = 48_000;

/** El trozo como lo ve el modelo de memoria: cada mensaje con su id. */
export function renderChunk(entries: ChunkEntry[]): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const { id, message: m } of entries) {
    if (m.role === 'assistant') {
      const parts = [`[${id} assistant]`];
      if (m.content) parts.push(truncateToolOutput(m.content, TEXT_CHARS));
      for (const call of m.toolCalls ?? []) {
        names.set(call.id, call.name);
        parts.push(`-> ${call.name}(${truncateToolOutput(call.arguments, ARGS_CHARS)})`);
      }
      lines.push(parts.join('\n'));
    } else if (m.role === 'tool') {
      const name = (m.toolCallId && names.get(m.toolCallId)) || m.name || 'tool';
      const content = m.content ?? '';
      const note =
        content.length > TOOL_CHARS
          ? ` (excerpt of ${content.length} chars; full output in ${id})`
          : '';
      lines.push(`[${id} tool:${name}${note}]\n${truncateToolOutput(content, TOOL_CHARS)}`);
    } else if (m.role === 'user') {
      lines.push(`[${id} user]\n${truncateToolOutput(m.content ?? '', TEXT_CHARS)}`);
    }
  }
  return truncateToolOutput(lines.join('\n\n'), CHUNK_CHARS);
}

export const EXTRACTOR_PROMPT = `You maintain the structured memory of ONE conversation between a user and an AI agent. From the conversation excerpt below, extract only what is explicitly stated or clearly established in it. Do not infer, guess, generalize or add outside knowledge.

Return only JSON, with this shape:
{"items":[{"kind":"fact|decision|constraint|preference|task|result|entity","key":"short-stable-key","text":"one self-contained sentence","sources":["e12"],"status":"open|done","supersedes":"sm_3","conflict":false}]}

Rules:
- sources (required): the ids in brackets of the messages that state it. Never an id that is not in the excerpt.
- key: a short stable identifier of the subject (e.g. "database-engine", "deploy-target"). When the excerpt updates something already in memory, reuse its key, or set "supersedes" to its id.
- decision: something the user and agent chose. constraint: a rule or limit to respect. preference: how the user wants things done in this conversation. task: pending work ("status":"open") or work now finished ("status":"done", with the key of the open task). result: an outcome that was verified (tests passed, a command failed). entity: a file, service, host or identifier that matters later.
- Tool output: keep conclusions only, never raw dumps. Never include secrets, passwords, API keys or tokens.
- If two messages contradict each other and the excerpt does not say which holds, set "conflict":true.
- Nothing worth keeping: {"items":[]}`;

export const SUMMARIZER_PROMPT = `You keep the running summary of ONE conversation between a user and an AI agent, so the agent can continue it without the old messages. Update the previous summary with the new excerpt. At most 300 words. Cover what has happened, what the user is trying to achieve, the current state and what is pending. Do not list every detail (facts and decisions are kept separately). Never include secrets, passwords, API keys or tokens. Write in the language the user writes in. Output only the summary text.`;

/** Lo que se le enseña al extractor de la memoria actual: claves e ids para no duplicar. */
function existingItems(memory: SessionMemory): string {
  const live = memory.items.filter((i) => i.status === 'active' || i.status === 'conflict');
  if (live.length === 0) return '(none)';
  return live
    .slice(-120)
    .map((i) => `[${i.id}] ${i.kind}/${i.key}: ${i.text.slice(0, 160)}`)
    .join('\n');
}

export interface MemoryCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  trace?: TraceScope;
  sessionId?: string;
}

export class MemoryCallError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'MemoryCallError';
  }
}

async function complete(
  model: MemoryModel,
  origin: 'session-memory-extraction' | 'session-memory-summary',
  prompt: string,
  opts: MemoryCallOptions,
): Promise<string> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const think = new ThinkTagSplitter();
  let out = '';
  try {
    for await (const chunk of tracedCompletion({
      origin,
      provider: model.provider,
      providerName: model.providerName,
      request: {
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        model: model.model,
        signal,
        temperature: 0,
      },
      ...(opts.trace ? { trace: opts.trace } : {}),
      ...(opts.signal ? { cancelSignal: opts.signal } : {}),
    })) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) out += think.feed(content).text;
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new MemoryCallError('cancelled', true);
    if (timeout.aborted) {
      throw new MemoryCallError(
        `${model.role} timed out after ${Math.round(opts.timeoutMs / 1000)} s`,
      );
    }
    throw new MemoryCallError(
      `${model.role} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (opts.signal?.aborted) throw new MemoryCallError('cancelled', true);
  out += think.flush().text;
  return out.trim();
}

const itemSchema = z.object({
  kind: z.enum(MEMORY_ITEM_KINDS),
  key: z.string().max(200).default(''),
  text: z.string().min(1).max(4_000),
  sources: z.array(z.string()).min(1),
  status: z.enum(['open', 'done']).optional(),
  supersedes: z.string().optional(),
  conflict: z.boolean().optional(),
});

/**
 * Lee la respuesta del extractor. Tolera un bloque de código alrededor o una
 * lista suelta; descarta las entradas que no cumplen el contrato. Una
 * respuesta que no es JSON es un fallo: la memoria no cambia.
 */
export function parseExtraction(text: string): Extraction {
  const body = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new MemoryCallError('extractor did not return JSON');
  const open = body[start];
  const end = body.lastIndexOf(open === '[' ? ']' : '}');
  if (end <= start) throw new MemoryCallError('extractor did not return JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new MemoryCallError('extractor returned invalid JSON');
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null;
  if (!list) throw new MemoryCallError('extractor JSON has no "items" list');
  const items: ExtractedItem[] = [];
  for (const candidate of list) {
    const parsed = itemSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { kind, key, text: itemText, sources, status, supersedes, conflict } = parsed.data;
    items.push({
      kind,
      key: normalizeKey(key || itemText.slice(0, 40)),
      text: itemText,
      sources,
      ...(status ? { status } : {}),
      ...(supersedes ? { supersedes } : {}),
      ...(conflict ? { conflict } : {}),
    });
  }
  return { items };
}

export async function runExtractor(
  model: MemoryModel,
  memory: SessionMemory,
  entries: ChunkEntry[],
  opts: MemoryCallOptions,
): Promise<Extraction> {
  const prompt =
    `${EXTRACTOR_PROMPT}\n\nExisting memory items:\n${existingItems(memory)}\n\n` +
    `<conversation>\n${renderChunk(entries)}\n</conversation>`;
  return parseExtraction(await complete(model, 'session-memory-extraction', prompt, opts));
}

export async function runSummarizer(
  model: MemoryModel,
  memory: SessionMemory,
  entries: ChunkEntry[],
  opts: MemoryCallOptions,
): Promise<string> {
  const previous = memory.summary?.text ?? '(none yet)';
  const prompt =
    `${SUMMARIZER_PROMPT}\n\n<previous_summary>\n${previous}\n</previous_summary>\n\n` +
    `<conversation>\n${renderChunk(entries)}\n</conversation>`;
  const summary = await complete(model, 'session-memory-summary', prompt, opts);
  // Un resumen vacío no sustituye al anterior: sería perder la continuidad.
  if (!summary) throw new MemoryCallError('summarizer returned an empty summary');
  return summary;
}

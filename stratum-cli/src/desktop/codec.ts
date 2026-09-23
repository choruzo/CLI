/**
 * Codificación NDJSON del canal del sidecar. Separado de `protocol.ts` porque
 * usa `Buffer`, y `protocol.ts` lo importa también el frontend de Desktop.
 */
import { z } from 'zod';
import { LIMITS, type InboundFrame, type OutboundFrame } from './protocol.js';
import { isConversationId } from './session-store.js';

export function encodeFrame(frame: OutboundFrame): string {
  // JSON.stringify nunca emite un salto de línea literal: los de los strings
  // salen escapados, así que la línea es la frontera de trama.
  return JSON.stringify(frame) + '\n';
}

export class FrameTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`La trama supera el límite de ${limit} bytes.`);
    this.name = 'FrameTooLargeError';
  }
}

/**
 * Acumula bytes del socket y devuelve líneas completas. Mide en bytes y no en
 * caracteres, y decodifica solo líneas completas: un carácter multibyte partido
 * entre dos chunks no se corrompe.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private limit: number) {}

  /** Sube el tope (tras autenticar). */
  setLimit(limit: number): void {
    this.limit = limit;
  }

  /** @throws FrameTooLargeError si una línea (completa o en curso) excede el tope. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      this.assertFits(this.pendingBytes + piece.length);
      const line = Buffer.concat([...this.pending, piece]).toString('utf8');
      this.pending = [];
      this.pendingBytes = 0;
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.trim() !== '') lines.push(trimmed);
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.assertFits(this.pendingBytes + rest.length);
      this.pending.push(rest);
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  private assertFits(bytes: number): void {
    if (bytes > this.limit) throw new FrameTooLargeError(this.limit);
  }
}

const id = z.string().min(1).max(LIMITS.idChars);
const conversationId = z.string().refine(isConversationId, 'conversationId no es un UUID');

const answer = z
  .object({
    question: z.string().max(LIMITS.answerChars),
    answer: z.string().max(LIMITS.answerChars),
    optionId: id.optional(),
  })
  .strict();

/**
 * Schemas de entrada. `strict()`: un campo desconocido invalida la trama en vez
 * de viajar ignorado hacia el core.
 */
const inboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('handshake'), token: z.string().max(1024) }).strict(),
  z.object({ type: z.literal('ping'), id: id.optional() }).strict(),
  z
    .object({ type: z.literal('new_conversation'), conversationId, resume: z.boolean().optional() })
    .strict(),
  z.object({ type: z.literal('close_conversation'), conversationId }).strict(),
  z
    .object({
      type: z.literal('chat'),
      conversationId,
      turnId: id,
      text: z.string().max(LIMITS.chatChars),
      attachments: z
        .array(z.string().min(1).max(LIMITS.attachmentPathChars))
        .max(LIMITS.attachments)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal('workspace_touch'), conversationId }).strict(),
  z.object({ type: z.literal('workspace_pin'), conversationId, pinned: z.boolean() }).strict(),
  z.object({ type: z.literal('cancel'), conversationId, turnId: id.optional() }).strict(),
  z
    .object({
      type: z.literal('answer_questions'),
      conversationId,
      requestId: id,
      answers: z
        .array(answer)
        .max(LIMITS.answers)
        // Una respuesta por pregunta: dos para la misma son ambiguas.
        .refine((a) => new Set(a.map((x) => x.question)).size === a.length, 'respuestas duplicadas')
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('confirm_response'),
      conversationId,
      callId: id,
      decision: z.enum(['approve', 'deny', 'allow-all']),
    })
    .strict(),
  z.object({ type: z.literal('list_conversations') }).strict(),
  z
    .object({
      type: z.literal('rename_conversation'),
      conversationId,
      title: z.string().max(LIMITS.titleChars),
    })
    .strict(),
  z.object({ type: z.literal('delete_conversation'), conversationId }).strict(),
  z.object({ type: z.literal('clear_conversation'), conversationId }).strict(),
  z.object({ type: z.literal('compact_conversation'), conversationId }).strict(),
  z.object({ type: z.literal('list_models'), conversationId }).strict(),
  z
    .object({
      type: z.literal('set_model'),
      conversationId,
      model: z.string().trim().min(1).max(LIMITS.modelChars),
    })
    .strict(),
  z.object({ type: z.literal('memory_get') }).strict(),
  z
    .object({
      type: z.literal('memory_save'),
      content: z.string().max(LIMITS.memoryChars),
      baseMtimeMs: z.number().finite().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('memory_forget'), id }).strict(),
  z.object({ type: z.literal('config_get') }).strict(),
  z
    .object({
      type: z.literal('config_validate'),
      requestId: id,
      text: z.string().max(LIMITS.configChars),
    })
    .strict(),
  z
    .object({
      type: z.literal('config_save'),
      text: z.string().max(LIMITS.configChars),
      baseHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider_probe'),
      requestId: id,
      baseUrl: z.string().min(1).max(LIMITS.urlChars),
      apiKey: z.string().max(LIMITS.secretChars).optional(),
      provider: z.string().min(1).max(LIMITS.idChars).optional(),
    })
    .strict(),
  z.object({ type: z.literal('retention_run') }).strict(),
  z.object({ type: z.literal('workspaces_usage_get') }).strict(),
]);

/** Parsea una línea como trama de entrada. Devuelve `null` si no tiene forma válida. */
export function parseInboundFrame(line: string): InboundFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = inboundSchema.safeParse(value);
  if (!parsed.success) return null;
  const frame = parsed.data as InboundFrame;
  // Un mensaje vacío solo tiene sentido si lleva ficheros. Va aquí y no como
  // `refine` porque `discriminatedUnion` solo admite objetos planos.
  if (frame.type === 'chat' && frame.text.trim() === '' && !frame.attachments?.length) return null;
  if (frame.type === 'rename_conversation' && normalizeTitle(frame.title) === '') return null;
  return frame;
}

/** Título en una línea, sin espacios sobrantes ni caracteres de control. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

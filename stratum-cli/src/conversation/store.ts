/**
 * `ConversationStore` (M11): la conversación **entera** y duradera de una
 * sesión, independiente de lo que el modelo tenga en su contexto.
 *
 * Guarda dos vistas de la misma conversación, en un solo flujo ordenado:
 *
 *  - **El historial del agente** (`agent`): cada mensaje que entró alguna vez
 *    en su contexto —usuario, asistente con sus tool calls, resultados de
 *    tools— con un id estable (`e<n>`). Compactar el contexto no borra nada de
 *    aquí: es la fuente de la memoria de sesión, de su procedencia y de la
 *    reconstrucción del contexto tras un reinicio.
 *  - **La conversación para personas** (`chat`): los `ProtocolChatMessage` que
 *    publica la sesión (los mismos ids `m<seq>` que la foto), para paginar lo
 *    antiguo que la foto ya no lleva.
 *
 * En disco es un JSONL de **solo añadir** (`conversation.jsonl`): una línea por
 * registro, la primera es la cabecera con el formato. Añadir es atómico por
 * línea; una última línea a medias (el proceso murió escribiéndola) se
 * descarta al abrir. Una línea intermedia que no valida se salta y se cuenta,
 * nunca se reescribe. Abrirlo no carga los mensajes: se indexan sus
 * posiciones y se leen bajo demanda. Un solo escritor a la vez (`.lock`).
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import type { ProtocolAgentMessage, ProtocolChatMessage } from '../protocol/index.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('conversation');

/** Formato del fichero. Cambiarlo es subir este número (y migrar o rechazar). */
export const CONVERSATION_FORMAT = 1;

/** Tope de un mensaje guardado. Más largo se recorta y lo dice (`clipped`). */
export const MAX_STORED_CONTENT = 1_048_576;

export interface AgentEntry {
  id: string;
  /** Posición en el historial del agente (0, 1, 2…). */
  index: number;
  at: number;
  runId?: string;
  message: ProtocolAgentMessage;
  /** Longitud original si el contenido se recortó al guardarlo. */
  clipped?: number;
}

export interface ChatPage {
  messages: ProtocolChatMessage[];
  /** Hay mensajes anteriores al primero de la página. */
  hasMore: boolean;
}

export interface ConversationStore {
  readonly sessionId: string;
  /** Añade un mensaje al historial del agente y devuelve su id. */
  appendAgent(message: ProtocolAgentMessage, meta?: { at?: number; runId?: string }): string;
  /** El contenido de un mensaje ya guardado creció (un aviso del runtime anexado). */
  amendAgent(id: string, content: string | null): void;
  getAgent(id: string): AgentEntry | null;
  agentCount(): number;
  /** Ids del historial del agente, en orden. */
  agentIds(): readonly string[];
  /** Posición de un id en el historial del agente; `-1` si no existe. */
  orderOf(id: string): number;
  /** Alta o actualización (misma `id`) de un mensaje de la conversación para personas. */
  putChat(message: ProtocolChatMessage): void;
  getChat(id: string): ProtocolChatMessage | null;
  chatCount(): number;
  /** Los `limit` más recientes, en orden cronológico. */
  listRecentChat(limit: number): ProtocolChatMessage[];
  /** Los `limit` anteriores a `beforeId` (o los últimos), en orden cronológico. */
  listChatBefore(beforeId: string | null, limit: number): ChatPage;
  /** Mayor `seq` de un id de chat (`m<seq>`), o 0. */
  maxChatSeq(): number;
  /** Fuerza a disco lo escrito (fin de turno). */
  flush(): void;
  close(): void;
}

export class ConversationFormatError extends Error {
  constructor(
    readonly path: string,
    readonly found: unknown,
  ) {
    super(
      `The conversation at ${path} uses format ${String(found)}, but this Stratum only reads ` +
        `format ${CONVERSATION_FORMAT}. It was not modified.`,
    );
    this.name = 'ConversationFormatError';
  }
}

export class ConversationLockedError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`The conversation at ${path} is being written by another process (pid ${pid}).`);
    this.name = 'ConversationLockedError';
  }
}

// ---------------------------------------------------------------------------
// Registros
// ---------------------------------------------------------------------------

const agentMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});

const recordSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('header'),
    format: z.number().int(),
    sessionId: z.string(),
    createdAt: z.number(),
  }),
  z.object({
    t: z.literal('agent'),
    id: z.string(),
    at: z.number(),
    runId: z.string().optional(),
    msg: agentMessageSchema,
    clipped: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('amend'),
    id: z.string(),
    at: z.number(),
    content: z.string().nullable(),
    clipped: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('chat'),
    at: z.number(),
    // La forma del mensaje la valida el contrato al leerlo de vuelta.
    msg: z.object({ id: z.string(), kind: z.string() }).passthrough(),
  }),
]);
type StoreRecord = z.infer<typeof recordSchema>;

function clipContent(content: string | null): { content: string | null; clipped?: number } {
  if (content === null || content.length <= MAX_STORED_CONTENT) return { content };
  let end = MAX_STORED_CONTENT;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { content: content.slice(0, end), clipped: content.length };
}

function chatSeq(id: string): number {
  const n = /^m(\d+)$/.exec(id);
  return n ? Number(n[1]) : 0;
}

// ---------------------------------------------------------------------------
// En memoria (tests y sesiones sin disco)
// ---------------------------------------------------------------------------

export class MemoryConversationStore implements ConversationStore {
  private readonly agent: AgentEntry[] = [];
  private readonly agentById = new Map<string, AgentEntry>();
  private readonly chatOrder: string[] = [];
  private readonly chat = new Map<string, ProtocolChatMessage>();
  private maxSeq = 0;

  constructor(readonly sessionId: string) {}

  appendAgent(message: ProtocolAgentMessage, meta: { at?: number; runId?: string } = {}): string {
    const index = this.agent.length;
    const id = `e${index + 1}`;
    const clipped = clipContent(message.content);
    const entry: AgentEntry = {
      id,
      index,
      at: meta.at ?? Date.now(),
      ...(meta.runId ? { runId: meta.runId } : {}),
      message: { ...message, content: clipped.content },
      ...(clipped.clipped ? { clipped: clipped.clipped } : {}),
    };
    this.agent.push(entry);
    this.agentById.set(id, entry);
    return id;
  }

  amendAgent(id: string, content: string | null): void {
    const entry = this.agentById.get(id);
    if (!entry) return;
    const clipped = clipContent(content);
    entry.message = { ...entry.message, content: clipped.content };
    if (clipped.clipped) entry.clipped = clipped.clipped;
  }

  getAgent(id: string): AgentEntry | null {
    const entry = this.agentById.get(id);
    return entry ? { ...entry, message: { ...entry.message } } : null;
  }

  agentCount(): number {
    return this.agent.length;
  }

  agentIds(): readonly string[] {
    return this.agent.map((e) => e.id);
  }

  orderOf(id: string): number {
    return this.agentById.get(id)?.index ?? -1;
  }

  putChat(message: ProtocolChatMessage): void {
    if (!this.chat.has(message.id)) this.chatOrder.push(message.id);
    this.chat.set(message.id, { ...message });
    this.maxSeq = Math.max(this.maxSeq, chatSeq(message.id));
  }

  getChat(id: string): ProtocolChatMessage | null {
    const m = this.chat.get(id);
    return m ? { ...m } : null;
  }

  chatCount(): number {
    return this.chatOrder.length;
  }

  listRecentChat(limit: number): ProtocolChatMessage[] {
    return this.listChatBefore(null, limit).messages;
  }

  listChatBefore(beforeId: string | null, limit: number): ChatPage {
    return pageOf(this.chatOrder, beforeId, limit, (id) => this.getChat(id));
  }

  maxChatSeq(): number {
    return this.maxSeq;
  }

  flush(): void {}
  close(): void {}
}

function pageOf(
  order: readonly string[],
  beforeId: string | null,
  limit: number,
  get: (id: string) => ProtocolChatMessage | null,
): ChatPage {
  const end = beforeId === null ? order.length : order.indexOf(beforeId);
  if (end < 0) return { messages: [], hasMore: false };
  const n = Math.max(0, Math.floor(limit));
  const start = Math.max(0, end - n);
  const messages: ProtocolChatMessage[] = [];
  for (const id of order.slice(start, end)) {
    const m = get(id);
    if (m) messages.push(m);
  }
  return { messages, hasMore: start > 0 };
}

// ---------------------------------------------------------------------------
// En disco
// ---------------------------------------------------------------------------

interface Span {
  offset: number;
  length: number;
}

interface AgentSlot {
  id: string;
  index: number;
  base: Span;
  /** Último `amend`, si lo hubo: su contenido sustituye al de `base`. */
  amend?: Span;
}

export interface FileStoreOptions {
  /** Solo lectura: no toma el cerrojo, no repara ni escribe. */
  readOnly?: boolean;
  /** ¿Está vivo ese pid? Inyectable para tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileConversationStore implements ConversationStore {
  private fd: number;
  private size = 0;
  private readonly agent: AgentSlot[] = [];
  private readonly agentById = new Map<string, AgentSlot>();
  private readonly chatOrder: string[] = [];
  private readonly chatSpans = new Map<string, Span>();
  private maxSeq = 0;
  /** Líneas intermedias que no validaron al abrir. */
  readonly skipped: number;
  private closed = false;
  private readonly lockPath: string;
  private readonly now: () => number;

  private constructor(
    readonly path: string,
    readonly sessionId: string,
    private readonly readOnly: boolean,
    fd: number,
    now: () => number,
    skipped: number,
  ) {
    this.fd = fd;
    this.lockPath = `${path}.lock`;
    this.now = now;
    this.skipped = skipped;
  }

  /**
   * Abre (o crea) la conversación de `sessionId` en `path`.
   *
   * @throws ConversationFormatError si es de un formato más nuevo (no se toca).
   * @throws ConversationLockedError si otro proceso vivo la está escribiendo.
   */
  static open(path: string, sessionId: string, opts: FileStoreOptions = {}): FileConversationStore {
    const readOnly = opts.readOnly === true;
    const now = opts.now ?? Date.now;
    if (!readOnly) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      takeLock(`${path}.lock`, opts.isAlive ?? defaultIsAlive);
    }
    let fd: number | null = null;
    try {
      const exists = existsSync(path);
      if (!exists && readOnly) throw new Error(`No conversation at ${path}`);
      fd = openSync(path, readOnly ? 'r' : exists ? 'r+' : 'w+', 0o600);
      const store = FileConversationStore.scan(path, sessionId, readOnly, fd, now);
      return store;
    } catch (err) {
      if (fd !== null) closeSync(fd);
      if (!readOnly) releaseLock(`${path}.lock`);
      throw err;
    }
  }

  private static scan(
    path: string,
    sessionId: string,
    readOnly: boolean,
    fd: number,
    now: () => number,
  ): FileConversationStore {
    const total = fstatSync(fd).size;
    const lines: Array<{ span: Span; record: StoreRecord | null }> = [];
    let good = 0; // fin de la última línea completa
    const chunk = Buffer.alloc(1 << 20);
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = 0;
    let pos = 0;
    while (pos < total) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, total - pos), pos);
      if (read <= 0) break;
      const data =
        carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, read)])
          : chunk.subarray(0, read);
      const base = carry.length > 0 ? carryStart : pos;
      let from = 0;
      for (let nl = data.indexOf(10, from); nl !== -1; nl = data.indexOf(10, from)) {
        const text = data.subarray(from, nl).toString('utf8');
        let record: StoreRecord | null = null;
        try {
          const parsed = recordSchema.safeParse(JSON.parse(text));
          record = parsed.success ? parsed.data : null;
        } catch {
          record = null;
        }
        lines.push({ span: { offset: base + from, length: nl - from }, record });
        from = nl + 1;
        good = base + from;
      }
      carry = Buffer.from(data.subarray(from));
      carryStart = base + from;
      pos += read;
    }

    // Una cola sin salto de línea es una escritura cortada: se descarta.
    if (good < total) {
      if (readOnly) {
        log.warn('conversation has a torn tail (read-only, left as is)', { sessionId });
      } else {
        log.warn('conversation tail was torn; truncated', { sessionId, bytes: total - good });
        ftruncateSync(fd, good);
      }
    }

    let skipped = 0;
    const header = lines[0]?.record;
    if (lines.length === 0) {
      if (!readOnly) {
        const store = new FileConversationStore(path, sessionId, readOnly, fd, now, 0);
        store.size = good;
        store.write({ t: 'header', format: CONVERSATION_FORMAT, sessionId, createdAt: now() });
        return store;
      }
    } else if (!header || header.t !== 'header') {
      // Sin cabecera legible no se sabe de qué formato es: no se toca.
      let found: unknown = 'unknown';
      try {
        const raw = JSON.parse(readSpan(fd, lines[0]!.span)) as { format?: unknown };
        found = raw.format ?? 'unknown';
      } catch {
        /* ilegible */
      }
      throw new ConversationFormatError(path, found);
    } else if (header.format > CONVERSATION_FORMAT) {
      throw new ConversationFormatError(path, header.format);
    } else if (header.sessionId !== sessionId) {
      throw new Error(`The conversation at ${path} belongs to another session.`);
    }

    const store = new FileConversationStore(path, sessionId, readOnly, fd, now, 0);
    store.size = good;
    for (const { span, record } of lines.slice(1)) {
      if (!record) {
        skipped++;
        continue;
      }
      store.index(record, span);
    }
    (store as { skipped: number }).skipped = skipped;
    if (skipped > 0) log.warn('conversation lines skipped', { sessionId, skipped });
    return store;
  }

  private index(record: StoreRecord, span: Span): void {
    if (record.t === 'agent') {
      if (this.agentById.has(record.id)) return;
      const slot: AgentSlot = { id: record.id, index: this.agent.length, base: span };
      this.agent.push(slot);
      this.agentById.set(record.id, slot);
    } else if (record.t === 'amend') {
      const slot = this.agentById.get(record.id);
      if (slot) slot.amend = span;
    } else if (record.t === 'chat') {
      const id = record.msg.id;
      if (!this.chatSpans.has(id)) this.chatOrder.push(id);
      this.chatSpans.set(id, span);
      this.maxSeq = Math.max(this.maxSeq, chatSeq(id));
    }
  }

  private write(record: StoreRecord): Span {
    if (this.readOnly) throw new Error('read-only conversation');
    if (this.closed) throw new Error('conversation is closed');
    const line = `${JSON.stringify(record)}\n`;
    const buf = Buffer.from(line, 'utf8');
    const offset = this.size;
    let written = 0;
    while (written < buf.length) {
      written += writeSync(this.fd, buf, written, buf.length - written, offset + written);
    }
    this.size += buf.length;
    return { offset, length: buf.length - 1 };
  }

  private read(span: Span): StoreRecord | null {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(readSpan(this.fd, span)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  appendAgent(message: ProtocolAgentMessage, meta: { at?: number; runId?: string } = {}): string {
    const id = `e${this.agent.length + 1}`;
    const clipped = clipContent(message.content);
    const record: StoreRecord = {
      t: 'agent',
      id,
      at: meta.at ?? this.now(),
      ...(meta.runId ? { runId: meta.runId } : {}),
      msg: { ...message, content: clipped.content },
      ...(clipped.clipped ? { clipped: clipped.clipped } : {}),
    };
    this.index(record, this.write(record));
    return id;
  }

  amendAgent(id: string, content: string | null): void {
    if (!this.agentById.has(id)) return;
    const clipped = clipContent(content);
    const record: StoreRecord = {
      t: 'amend',
      id,
      at: this.now(),
      content: clipped.content,
      ...(clipped.clipped ? { clipped: clipped.clipped } : {}),
    };
    this.index(record, this.write(record));
  }

  getAgent(id: string): AgentEntry | null {
    const slot = this.agentById.get(id);
    if (!slot) return null;
    const base = this.read(slot.base);
    if (!base || base.t !== 'agent') return null;
    const entry: AgentEntry = {
      id,
      index: slot.index,
      at: base.at,
      ...(base.runId ? { runId: base.runId } : {}),
      message: base.msg as ProtocolAgentMessage,
      ...(base.clipped ? { clipped: base.clipped } : {}),
    };
    if (slot.amend) {
      const amend = this.read(slot.amend);
      if (amend && amend.t === 'amend') {
        entry.message = { ...entry.message, content: amend.content };
        if (amend.clipped) entry.clipped = amend.clipped;
      }
    }
    return entry;
  }

  agentCount(): number {
    return this.agent.length;
  }

  agentIds(): readonly string[] {
    return this.agent.map((s) => s.id);
  }

  orderOf(id: string): number {
    return this.agentById.get(id)?.index ?? -1;
  }

  putChat(message: ProtocolChatMessage): void {
    const record: StoreRecord = {
      t: 'chat',
      at: this.now(),
      msg: message as unknown as { id: string; kind: string },
    };
    this.index(record, this.write(record));
  }

  getChat(id: string): ProtocolChatMessage | null {
    const span = this.chatSpans.get(id);
    if (!span) return null;
    const record = this.read(span);
    return record && record.t === 'chat' ? (record.msg as unknown as ProtocolChatMessage) : null;
  }

  chatCount(): number {
    return this.chatOrder.length;
  }

  listRecentChat(limit: number): ProtocolChatMessage[] {
    return this.listChatBefore(null, limit).messages;
  }

  listChatBefore(beforeId: string | null, limit: number): ChatPage {
    return pageOf(this.chatOrder, beforeId, limit, (id) => this.getChat(id));
  }

  maxChatSeq(): number {
    return this.maxSeq;
  }

  flush(): void {
    if (this.closed || this.readOnly) return;
    try {
      fsyncSync(this.fd);
    } catch (err) {
      log.warn('conversation fsync failed', { sessionId: this.sessionId, err });
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      if (!this.readOnly) releaseLock(this.lockPath);
    }
  }
}

function readSpan(fd: number, span: Span): string {
  const buf = Buffer.alloc(span.length);
  let got = 0;
  while (got < span.length) {
    const n = readSync(fd, buf, got, span.length - got, span.offset + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got).toString('utf8');
}

/** Cerrojo de escritor: `wx` y, si ya existe, solo se adopta si su proceso murió. */
function takeLock(lockPath: string, isAlive: (pid: number) => boolean): void {
  const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    writeFileSync(lockPath, mine, { flag: 'wx', mode: 0o600 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let pid = 0;
  try {
    pid = Number((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid) || 0;
  } catch {
    pid = 0;
  }
  if (pid > 0 && pid !== process.pid && isAlive(pid)) {
    throw new ConversationLockedError(lockPath.replace(/\.lock$/, ''), pid);
  }
  // Rancio (su proceso murió) o nuestro: se reescribe.
  writeFileSync(lockPath, mine, { mode: 0o600 });
}

function releaseLock(lockPath: string): void {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (Number(raw.pid) === process.pid) rmSync(lockPath, { force: true });
  } catch {
    /* ya no está o no es legible: nada que soltar */
  }
}

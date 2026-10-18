/**
 * Ficheros de estado de una conversación (M11), junto a su `ConversationStore`:
 *
 *  - `memory.json` — la memoria de sesión (`SessionMemory`).
 *  - `context.json` — qué entradas forman el contexto activo y el registro de
 *    compactaciones (`ContextState`): con esto y el store, el contexto del
 *    agente se reconstruye tras un reinicio.
 *
 * Como todo el estado en disco: escritura atómica, validación con Zod al leer
 * y un fichero de una versión más nueva no se toca (`SchemaVersionError`).
 */
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import {
  MEMORY_ITEM_KINDS,
  SESSION_MEMORY_SCHEMA_VERSION,
  emptySessionMemory,
  type SessionMemory,
} from './session-memory.js';

export const CONTEXT_STATE_SCHEMA_VERSION = 1;

/** Una compactación: qué entradas salieron del contexto y a qué versión de la memoria fueron. */
export interface CompactionRecord {
  at: number;
  /** Entradas compactadas, en orden. */
  ids: string[];
  memoryVersion: number;
  tokensBefore: number;
  tokensAfter: number;
  /** `provider/model` de cada función. */
  extractor: string;
  summarizer: string;
}

export interface ContextState {
  schemaVersion: typeof CONTEXT_STATE_SCHEMA_VERSION;
  sessionId: string;
  /** Entradas del store que forman el contexto activo (sin el system prompt), en orden. */
  activeIds: string[];
  compactions: CompactionRecord[];
  compactionCount: number;
  lastCompactionAt: number | null;
  /** Último fallo de compactación (se aplazó), o `null`. */
  lastCompactionError: string | null;
}

export const MAX_COMPACTION_RECORDS = 500;

export function emptyContextState(sessionId: string): ContextState {
  return {
    schemaVersion: CONTEXT_STATE_SCHEMA_VERSION,
    sessionId,
    activeIds: [],
    compactions: [],
    compactionCount: 0,
    lastCompactionAt: null,
    lastCompactionError: null,
  };
}

const memoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(MEMORY_ITEM_KINDS),
  key: z.string(),
  text: z.string(),
  status: z.enum(['active', 'superseded', 'done', 'conflict']),
  sources: z.array(z.string()).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
});

const sessionMemorySchema = z.object({
  schemaVersion: z.literal(SESSION_MEMORY_SCHEMA_VERSION),
  sessionId: z.string(),
  version: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  summary: z
    .object({ text: z.string(), sources: z.array(z.string()), updatedAt: z.string() })
    .nullable(),
  items: z.array(memoryItemSchema),
  sourceCursor: z.string().nullable(),
  nextItem: z.number().int().min(1),
});

const contextStateSchema = z.object({
  schemaVersion: z.literal(CONTEXT_STATE_SCHEMA_VERSION),
  sessionId: z.string(),
  activeIds: z.array(z.string()),
  compactions: z.array(
    z.object({
      at: z.number(),
      ids: z.array(z.string()),
      memoryVersion: z.number().int(),
      tokensBefore: z.number(),
      tokensAfter: z.number(),
      extractor: z.string(),
      summarizer: z.string(),
    }),
  ),
  compactionCount: z.number().int().min(0),
  lastCompactionAt: z.number().nullable(),
  lastCompactionError: z.string().nullable(),
});

export class StateFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'newer' | 'corrupt' | 'other-session',
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'StateFileError';
  }
}

function readVersioned(path: string, supported: number): unknown | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new StateFileError(path, 'corrupt', 'not valid JSON');
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > supported) {
    throw new StateFileError(path, 'newer', `schemaVersion ${version} is newer than ${supported}`);
  }
  return raw;
}

/** Memoria de sesión en disco, o vacía si no hay. */
export function loadSessionMemory(path: string, sessionId: string): SessionMemory {
  const raw = readVersioned(path, SESSION_MEMORY_SCHEMA_VERSION);
  if (raw === null) return emptySessionMemory(sessionId);
  const parsed = sessionMemorySchema.safeParse(raw);
  if (!parsed.success)
    throw new StateFileError(path, 'corrupt', parsed.error.message.slice(0, 300));
  if (parsed.data.sessionId !== sessionId) {
    throw new StateFileError(path, 'other-session', 'belongs to another session');
  }
  return parsed.data as SessionMemory;
}

export function saveSessionMemory(path: string, memory: SessionMemory): void {
  writeFileAtomic(path, `${JSON.stringify(memory)}\n`);
}

export function loadContextState(path: string, sessionId: string): ContextState {
  const raw = readVersioned(path, CONTEXT_STATE_SCHEMA_VERSION);
  if (raw === null) return emptyContextState(sessionId);
  const parsed = contextStateSchema.safeParse(raw);
  if (!parsed.success)
    throw new StateFileError(path, 'corrupt', parsed.error.message.slice(0, 300));
  if (parsed.data.sessionId !== sessionId) {
    throw new StateFileError(path, 'other-session', 'belongs to another session');
  }
  return parsed.data as ContextState;
}

export function saveContextState(path: string, state: ContextState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`);
}

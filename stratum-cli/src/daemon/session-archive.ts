/**
 * M11 — sesiones del daemon en disco, para que sobrevivan a un reinicio de
 * `stratumd`. Una carpeta privada por sesión en `~/.stratum/daemon/sessions/`:
 *
 *   <id>/session.json        ajustes para reconstruirla (cwd, provider, modelo,
 *                            perfil, read-only, perfil de sesión, plan, contadores)
 *   <id>/snapshot.json       la última foto publicada (seq, título, último run…)
 *   <id>/conversation.jsonl  la conversación entera (`ConversationStore`)
 *   <id>/memory.json         la memoria de sesión
 *   <id>/context.json        qué forma el contexto activo y las compactaciones
 *
 * **Nunca** se guardan claves (`apiKey`, el token del endpoint, la clave de
 * aprobador), el entorno, handles, procesos ni conexiones vivas (jobs, SSH,
 * MCP): una sesión recuperada monta los suyos con el entorno del daemon, como
 * una traspasada. Lo que contiene la conversación (y su memoria) sí está:
 * mismas reglas que el transcript, en una carpeta solo de este usuario.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { defaultEndpointDir } from '../client/discovery.js';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import {
  loadContextState,
  loadSessionMemory,
  saveContextState,
  saveSessionMemory,
  type ContextState,
} from '../conversation/files.js';
import {
  SessionConversation,
  type ConversationPersistence,
} from '../conversation/session-conversation.js';
import type { SessionMemory } from '../conversation/session-memory.js';
import {
  FileConversationStore,
  MemoryConversationStore,
  type ConversationStore,
} from '../conversation/store.js';
import { getLogger } from '../logging/index.js';
import {
  TRANSCRIPT_LIMITS,
  type ProtocolRun,
  type ProtocolSessionSnapshot,
} from '../protocol/index.js';
import { fitSnapshot } from '../host/session-publisher.js';
import { sessionSnapshotSchema } from '../protocol/schemas.js';
import { isSessionId } from '../session/store.js';
import { ensurePrivateDirSync } from './private-dir.js';

const log = getLogger('daemon').child('archive');

export const SESSION_META_SCHEMA_VERSION = 1;

/** Ajustes de una sesión del daemon: lo justo para volver a montarla. */
export interface SessionMeta {
  schemaVersion: typeof SESSION_META_SCHEMA_VERSION;
  sessionId: string;
  cwd: string;
  /** Alias del provider (sin `baseUrl` ni claves: se resuelven al montar). */
  provider: string;
  model: string;
  agent: string | null;
  readOnly: boolean;
  sessionProfile: string;
  planRef: string | null;
  usage: {
    toolCalls: number;
    tokens: number | null;
    tokenStatus: 'reported' | 'unavailable' | 'unsupported';
  };
  /** Versión de Stratum que la escribió. */
  writtenBy: string;
  createdAt: number;
  updatedAt: number;
}

const metaSchema = z.object({
  schemaVersion: z.literal(SESSION_META_SCHEMA_VERSION),
  sessionId: z.string(),
  cwd: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  agent: z.string().nullable(),
  readOnly: z.boolean(),
  sessionProfile: z.string(),
  planRef: z.string().nullable(),
  usage: z.object({
    toolCalls: z.number().int().min(0),
    tokens: z.number().nullable(),
    tokenStatus: z.enum(['reported', 'unavailable', 'unsupported']),
  }),
  writtenBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Una sesión guardada, tal como se leyó al arrancar. */
export interface ArchivedSession {
  meta: SessionMeta;
  snapshot: ProtocolSessionSnapshot;
}

/** Lo que una sesión montada escribe en su carpeta. */
export interface SessionFiles {
  conversation: SessionConversation;
  saveMeta(meta: SessionMeta): void;
  saveSnapshot(snapshot: ProtocolSessionSnapshot): void;
  close(): void;
}

const FILES = {
  meta: 'session.json',
  snapshot: 'snapshot.json',
  conversation: 'conversation.jsonl',
  memory: 'memory.json',
  context: 'context.json',
} as const;

/** Archivo de sesiones en `root`, o en memoria (`root: null`: nada sobrevive al proceso). */
export class SessionArchive {
  constructor(private readonly root: string | null) {}

  get persistent(): boolean {
    return this.root !== null;
  }

  private dir(sessionId: string): string {
    if (!this.root || !isSessionId(sessionId)) throw new Error('invalid session id');
    return join(this.root, sessionId);
  }

  has(sessionId: string): boolean {
    return this.root !== null && isSessionId(sessionId) && existsSync(this.dir(sessionId));
  }

  /**
   * Las sesiones guardadas que se pueden recuperar. Una que no valida (o de un
   * Stratum más nuevo) se deja como está y se cuenta en `skipped`: nunca se
   * borra por no entenderla.
   */
  list(): { sessions: ArchivedSession[]; skipped: Array<{ id: string; error: string }> } {
    const sessions: ArchivedSession[] = [];
    const skipped: Array<{ id: string; error: string }> = [];
    if (!this.root || !existsSync(this.root)) return { sessions, skipped };
    for (const id of readdirSync(this.root)) {
      if (!isSessionId(id)) continue;
      try {
        const loaded = this.load(id);
        if (loaded) sessions.push(loaded);
      } catch (err) {
        skipped.push({
          id,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }
    if (skipped.length > 0) log.warn('archived sessions skipped', { count: skipped.length });
    sessions.sort((a, b) => a.meta.createdAt - b.meta.createdAt);
    return { sessions, skipped };
  }

  private load(sessionId: string): ArchivedSession | null {
    const dir = this.dir(sessionId);
    const metaPath = join(dir, FILES.meta);
    if (!existsSync(metaPath)) return null;
    const rawMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as { schemaVersion?: unknown };
    if (
      typeof rawMeta.schemaVersion === 'number' &&
      rawMeta.schemaVersion > SESSION_META_SCHEMA_VERSION
    ) {
      throw new Error(`session.json schemaVersion ${rawMeta.schemaVersion} is newer`);
    }
    const meta = metaSchema.parse(rawMeta);
    if (meta.sessionId !== sessionId) throw new Error('session.json belongs to another session');
    const snapshot = sessionSnapshotSchema.parse(
      JSON.parse(readFileSync(join(dir, FILES.snapshot), 'utf8')),
    );
    if (snapshot.session.id !== sessionId) throw new Error('snapshot belongs to another session');
    return { meta: meta as SessionMeta, snapshot };
  }

  /**
   * Abre la conversación de una sesión para escribirla (la crea si no hay).
   * Sin `root`, todo en memoria. Lanza si los ficheros no se pueden leer o son
   * de un Stratum más nuevo: una sesión así no se monta ni se toca.
   */
  open(sessionId: string): SessionFiles {
    if (!this.root) {
      const conversation = new SessionConversation({
        sessionId,
        store: new MemoryConversationStore(sessionId),
      });
      return {
        conversation,
        saveMeta: () => undefined,
        saveSnapshot: () => undefined,
        close: () => undefined,
      };
    }
    const dir = this.dir(sessionId);
    ensurePrivateDirSync(this.root);
    ensurePrivateDirSync(dir);
    const memoryPath = join(dir, FILES.memory);
    const contextPath = join(dir, FILES.context);
    const memory: SessionMemory = loadSessionMemory(memoryPath, sessionId);
    const state: ContextState = loadContextState(contextPath, sessionId);
    const store: ConversationStore = FileConversationStore.open(
      join(dir, FILES.conversation),
      sessionId,
    );
    const persistence: ConversationPersistence = {
      saveMemory: (m) => saveSessionMemory(memoryPath, m),
      saveState: (s) => saveContextState(contextPath, s),
    };
    const conversation = new SessionConversation({ sessionId, store, memory, state, persistence });
    let closed = false;
    return {
      conversation,
      saveMeta: (meta) => {
        if (!closed) writeFileAtomic(join(dir, FILES.meta), `${JSON.stringify(meta)}\n`);
      },
      saveSnapshot: (snapshot) => {
        if (!closed) writeFileAtomic(join(dir, FILES.snapshot), `${JSON.stringify(snapshot)}\n`);
      },
      close: () => {
        if (closed) return;
        closed = true;
        store.close();
      },
    };
  }

  /**
   * Lectura sin montar la sesión (una recuperada que aún no tiene turno): la
   * conversación, en solo lectura, y su memoria y estado.
   */
  read(
    sessionId: string,
  ): { store: FileConversationStore; memory: SessionMemory; state: ContextState } | null {
    if (!this.has(sessionId)) return null;
    const dir = this.dir(sessionId);
    const path = join(dir, FILES.conversation);
    if (!existsSync(path)) return null;
    return {
      store: FileConversationStore.open(path, sessionId, { readOnly: true }),
      memory: loadSessionMemory(join(dir, FILES.memory), sessionId),
      state: loadContextState(join(dir, FILES.context), sessionId),
    };
  }

  /** Borra la sesión (`sessions.close`: se cierra de verdad, no se recupera). */
  remove(sessionId: string): void {
    if (!this.has(sessionId)) return;
    try {
      rmSync(this.dir(sessionId), { recursive: true, force: true });
    } catch (err) {
      log.warn('archived session not removed', { sessionId, err });
    }
  }
}

const LIVE_RUN: ReadonlySet<ProtocolRun['status']> = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
]);

/**
 * La foto con la que vuelve una sesión guardada. Es la última que publicó, con
 * lo que el reinicio cambia dicho tal cual: el `seq` sigue desde lo más alto
 * que llegó a guardarse (también la conversación escrita a mitad de un turno),
 * la conversación es la cola del store, nada queda en curso (un run vivo pasa
 * a `interrupted`, sin pendientes ni texto a medias, sin jobs vivos) y la
 * aloja este daemon. Se usa igual sin montarla (al arrancar) y al montarla.
 */
export function restorableSnapshot(
  snapshot: ProtocolSessionSnapshot,
  store: Pick<ConversationStore, 'maxChatSeq' | 'listRecentChat' | 'chatCount'>,
  host: ProtocolSessionSnapshot['session']['host'],
): ProtocolSessionSnapshot {
  const seq = Math.max(snapshot.seq, store.maxChatSeq());
  const recent = store.listRecentChat(TRANSCRIPT_LIMITS.messages);
  const messages = recent.length > 0 ? recent : snapshot.messages;
  const run = snapshot.run
    ? LIVE_RUN.has(snapshot.run.status)
      ? { ...snapshot.run, status: 'interrupted' as const, endedAt: snapshot.session.updatedAt }
      : snapshot.run
    : null;
  return fitSnapshot({
    ...snapshot,
    seq,
    session: { ...snapshot.session, seq, state: 'idle', currentRunId: null, host },
    run,
    partial: { text: '', reasoning: '' },
    jobs: snapshot.jobs.filter((j) => j.status !== 'running'),
    approvals: [],
    questions: [],
    plans: [],
    messages,
    messagesTruncated: snapshot.messagesTruncated || store.chatCount() > messages.length,
  });
}

/** `~/.stratum/daemon/sessions/`: dentro de la carpeta privada del daemon. */
export function defaultSessionsDir(home: string = homedir()): string {
  return join(defaultEndpointDir(home), 'sessions');
}

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { resolve, sep } from 'path';
import { getLogger } from '../logging/index.js';
import { DesktopSessionStore, idsIn, isConversationId } from './session-store.js';
import { deriveTitle, transcriptFromMessages } from './transcript.js';
import type { ConversationSummary, TranscriptTurn, WorkspaceStatus } from './protocol.js';

const log = getLogger('desktop.conversations');

/**
 * Lo que la UI necesita de cada conversación (D4), aparte del historial del
 * agente (`DesktopSessionStore`): título y transcript visible. Un fichero por
 * conversación en `~/.stratum/desktop/conversations/<id>.json`, con escritura
 * atómica, como el resto de stores.
 *
 * Las conversaciones guardadas antes de D4 solo tienen sesión: su título y su
 * transcript se derivan del historial del agente al leerlas.
 */

export const CONVERSATION_RECORD_VERSION = 1;

export interface ConversationRecord {
  version: number;
  conversationId: string;
  title: string;
  titleEdited: boolean;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  transcript: TranscriptTurn[];
}

interface CachedSummary {
  mtimeMs: number;
  summary: Omit<ConversationSummary, 'workspace'>;
}

export class DesktopConversationStore {
  private readonly cache = new Map<string, CachedSummary>();

  constructor(
    private readonly dir: string,
    readonly sessions: DesktopSessionStore,
  ) {}

  private pathFor(conversationId: string): string {
    if (!isConversationId(conversationId)) {
      throw new Error(`conversationId inválido: ${JSON.stringify(conversationId.slice(0, 64))}`);
    }
    const path = resolve(this.dir, `${conversationId}.json`);
    if (!path.startsWith(resolve(this.dir) + sep)) {
      throw new Error('ruta de conversación fuera del directorio');
    }
    return path;
  }

  /** Registro propio, o uno derivado de la sesión (conversaciones anteriores a D4). */
  load(conversationId: string): ConversationRecord | null {
    const path = this.pathFor(conversationId);
    if (existsSync(path)) {
      let raw: Partial<ConversationRecord> | null = null;
      try {
        raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ConversationRecord>;
      } catch (err) {
        log.warn('conversation record unreadable; deriving from session', { conversationId, err });
      }
      // Un registro de un Stratum más nuevo no se interpreta a medias ni se
      // sustituye por uno derivado (el siguiente guardado lo pisaría).
      if (typeof raw?.version === 'number' && raw.version > CONVERSATION_RECORD_VERSION) {
        throw new Error(
          `el registro de la conversación es de una versión más nueva de Stratum (${raw.version})`,
        );
      }
      if (raw && raw.conversationId === conversationId && Array.isArray(raw.transcript)) {
        return {
          version: CONVERSATION_RECORD_VERSION,
          conversationId,
          title: typeof raw.title === 'string' && raw.title ? raw.title : 'Nueva conversación',
          titleEdited: raw.titleEdited === true,
          createdAt: raw.createdAt ?? new Date(0).toISOString(),
          updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
          provider: raw.provider ?? '',
          model: raw.model ?? '',
          transcript: raw.transcript,
        };
      }
      if (raw) log.warn('conversation record malformed; deriving from session', { conversationId });
    }
    return this.fromSession(conversationId);
  }

  private fromSession(conversationId: string): ConversationRecord | null {
    const session = this.sessions.load(conversationId);
    if (!session) return null;
    const transcript = transcriptFromMessages(session.messages, session.updatedAt);
    const first = transcript[0];
    return {
      version: CONVERSATION_RECORD_VERSION,
      conversationId,
      title: first ? deriveTitle(first.user.text, first.user.attachments) : 'Nueva conversación',
      titleEdited: false,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      provider: session.provider,
      model: session.model,
      transcript,
    };
  }

  save(record: ConversationRecord): void {
    const path = this.pathFor(record.conversationId);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf-8');
    renameSync(tmp, path);
    this.cache.delete(record.conversationId);
  }

  /** Hay registro propio (no cuenta una sesión anterior a D4). */
  exists(conversationId: string): boolean {
    return existsSync(this.pathFor(conversationId));
  }

  /** Borra el registro y la sesión. El workspace lo borra `WorkspaceManager`. */
  remove(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
    this.sessions.remove(conversationId);
    this.cache.delete(conversationId);
  }

  /** Ids con registro o con sesión. */
  ids(): string[] {
    const ids = new Set<string>(this.sessions.ids());
    for (const id of idsIn(this.dir)) ids.add(id);
    return [...ids];
  }

  /** Resumen para el sidebar, sin el estado del workspace (lo añade el host). */
  summary(conversationId: string): Omit<ConversationSummary, 'workspace'> | null {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.pathFor(conversationId)).mtimeMs;
    } catch {
      /* sin registro: se deriva de la sesión */
    }
    const cached = this.cache.get(conversationId);
    if (cached && mtimeMs !== -1 && cached.mtimeMs === mtimeMs) return cached.summary;
    let record: ConversationRecord | null;
    try {
      record = this.load(conversationId);
    } catch (err) {
      log.warn('conversation unreadable; left out of the list', { conversationId, err });
      return null;
    }
    if (!record) return null;
    const summary = summarize(record);
    if (mtimeMs !== -1) this.cache.set(conversationId, { mtimeMs, summary });
    return summary;
  }
}

export function summarize(
  record: ConversationRecord,
  workspace?: WorkspaceStatus | null,
): ConversationSummary {
  return {
    conversationId: record.conversationId,
    title: record.title,
    titleEdited: record.titleEdited,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    provider: record.provider,
    model: record.model,
    turnCount: record.transcript.length,
    workspace: workspace ?? null,
  };
}

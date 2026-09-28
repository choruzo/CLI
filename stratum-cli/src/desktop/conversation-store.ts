import { existsSync, readFileSync, rmSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import { getLogger } from '../logging/index.js';
import { sweepTempFiles, writeFileAtomicSync } from './atomic-file.js';
import {
  DesktopSessionStore,
  NewerRecordError,
  idsIn,
  isConversationId,
  setAsideFile,
  unreadableReason,
  type UnreadableReason,
} from './session-store.js';
import { SessionCorruptError } from '../session/store.js';
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
  /**
   * El modelo lo eligió el usuario con `/model` (D5). Si no, la conversación
   * sigue al modelo por defecto del provider cuando cambia en Ajustes. Ausente
   * en los registros anteriores: se trata como elegido si difiere del default.
   */
  modelPinned?: boolean;
  transcript: TranscriptTurn[];
}

interface CachedSummary {
  mtimeMs: number;
  summary: Omit<ConversationSummary, 'workspace'>;
}

export interface LoadOptions {
  /**
   * Apartar a `.corrupt-<fecha>` un registro dañado antes de derivar otro de la
   * sesión. Lo pide quien va a escribir después (abrir, renombrar): sin
   * apartarlo, el siguiente guardado lo pisaría. El listado solo lee.
   */
  setAsideCorrupt?: boolean;
  /** Se llama con la ruta nueva de un registro apartado. */
  onSetAside?: (path: string) => void;
}

/** Resultado de leer una conversación para el listado. */
export type SummaryResult =
  | { kind: 'ok'; summary: Omit<ConversationSummary, 'workspace'> }
  | { kind: 'unreadable'; reason: UnreadableReason }
  | { kind: 'none' };

/** La forma mínima que el resto del código da por supuesta en un turno guardado. */
function isTranscriptTurn(t: unknown): t is TranscriptTurn {
  if (typeof t !== 'object' || t === null) return false;
  const turn = t as Partial<TranscriptTurn>;
  return (
    typeof turn.turnId === 'string' &&
    typeof turn.status === 'string' &&
    Array.isArray(turn.parts) &&
    typeof turn.toolCalls === 'object' &&
    turn.toolCalls !== null &&
    typeof turn.user === 'object' &&
    turn.user !== null &&
    typeof turn.user.text === 'string'
  );
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

  /**
   * Registro propio, o uno derivado de la sesión (conversaciones anteriores a
   * D4, o registro dañado). Lanza `NewerRecordError` si el registro es de un
   * Stratum más nuevo, y los errores de `DesktopSessionStore.load` si hay que
   * derivar y la sesión tampoco se puede leer. Un registro dañado sin sesión de
   * la que derivar lanza `SessionCorruptError`… salvo con `setAsideCorrupt`,
   * que lo aparta y devuelve `null`.
   */
  load(conversationId: string, opts: LoadOptions = {}): ConversationRecord | null {
    const path = this.pathFor(conversationId);
    if (existsSync(path)) {
      let raw: Partial<ConversationRecord> | null = null;
      let problem: string | null = null;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          raw = parsed as Partial<ConversationRecord>;
        } else {
          problem = 'no es un objeto';
        }
      } catch (err) {
        problem = `JSON inválido (${err instanceof Error ? err.message : String(err)})`;
      }
      // Un registro de un Stratum más nuevo no se interpreta a medias ni se
      // sustituye por uno derivado (el siguiente guardado lo pisaría).
      if (typeof raw?.version === 'number' && raw.version > CONVERSATION_RECORD_VERSION) {
        throw new NewerRecordError('El registro de la conversación', raw.version);
      }
      if (
        raw &&
        raw.conversationId === conversationId &&
        Array.isArray(raw.transcript) &&
        raw.transcript.every(isTranscriptTurn)
      ) {
        return {
          version: CONVERSATION_RECORD_VERSION,
          conversationId,
          title: typeof raw.title === 'string' && raw.title ? raw.title : 'Nueva conversación',
          titleEdited: raw.titleEdited === true,
          createdAt: raw.createdAt ?? new Date(0).toISOString(),
          updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
          provider: raw.provider ?? '',
          model: raw.model ?? '',
          ...(typeof raw.modelPinned === 'boolean' ? { modelPinned: raw.modelPinned } : {}),
          transcript: raw.transcript,
        };
      }
      problem ??= 'forma inválida';
      if (opts.setAsideCorrupt) {
        const aside = setAsideFile(path);
        this.cache.delete(conversationId);
        log.warn('corrupt conversation record set aside', { conversationId, aside, problem });
        opts.onSetAside?.(aside);
      } else {
        log.warn('conversation record unreadable; deriving from session', {
          conversationId,
          problem,
        });
      }
      const derived = this.fromSession(conversationId);
      if (!derived && !opts.setAsideCorrupt) {
        throw new SessionCorruptError(conversationId, `registro de la conversación: ${problem}`);
      }
      return derived;
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
    writeFileAtomicSync(this.pathFor(record.conversationId), JSON.stringify(record));
    this.cache.delete(record.conversationId);
  }

  /** Borra los temporales de escrituras que no terminaron (proceso matado). */
  sweepTemp(): number {
    return sweepTempFiles(this.dir);
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
    const result = this.summaryResult(conversationId);
    return result.kind === 'ok' ? result.summary : null;
  }

  /** Como `summary`, pero distingue «no existe» de «existe y no se puede leer». Solo lee. */
  summaryResult(conversationId: string): SummaryResult {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.pathFor(conversationId)).mtimeMs;
    } catch {
      /* sin registro: se deriva de la sesión */
    }
    const cached = this.cache.get(conversationId);
    if (cached && mtimeMs !== -1 && cached.mtimeMs === mtimeMs) {
      return { kind: 'ok', summary: cached.summary };
    }
    let record: ConversationRecord | null;
    try {
      record = this.load(conversationId);
    } catch (err) {
      log.warn('conversation unreadable; left out of the list', { conversationId, err });
      return { kind: 'unreadable', reason: unreadableReason(err) };
    }
    if (!record) return { kind: 'none' };
    const summary = summarize(record);
    if (mtimeMs !== -1) this.cache.set(conversationId, { mtimeMs, summary });
    return { kind: 'ok', summary };
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

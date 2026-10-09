import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { SessionContext } from './types.js';
import type { IProvider } from '../providers/base.js';
import type { Message } from '../agent/types.js';
import {
  SESSION_SCHEMA_VERSION,
  SchemaVersionError,
  assertSchemaVersion,
} from '../config/schema-version.js';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';
import { tracedCompletion } from '../trace/llm-call.js';
import type { TraceScope } from '../trace/recorder.js';

const log = getLogger('session');

// ---------------------------------------------------------------------------
// Generación de IDs de sesión
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function randomAlpha(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Id de sesión `sess_YYYYMMDD_HHMMSS_<rnd>`. Se exporta porque `chat` lo genera
 * al arrancar —no al guardar— para poder correlacionar desde el primer turno
 * lo que se escribe fuera de la sesión (p. ej. el log de auditoría SSH, §12.14).
 */
export function generateSessionId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `sess_${date}_${time}_${randomAlpha(3)}`;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/**
 * Id de sesión válido: el que genera `generateSessionId`. El id llega del
 * usuario (`sessions delete <id>`, `/sessions resume <id>`) y se usa como
 * nombre de fichero: sin esta comprobación, `../../x` borraba cualquier `.json`.
 */
const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]+$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

const MessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().nullable().optional(),
  })
  .passthrough();

// Solo la forma que el resto del código da por supuesta; `passthrough` para no
// perder al reescribir un campo que añada una versión compatible.
const SessionSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    provider: z.string(),
    model: z.string(),
    project: z.string(),
    messages: z.array(MessageSchema),
    toolCallCount: z.number().default(0),
    summary: z.string().default(''),
    planRef: z.string().optional(),
    activeAgent: z.string().optional(),
    readOnly: z.boolean().optional(),
    sessionProfile: z.string().optional(),
    forkedFrom: z.string().optional(),
  })
  .passthrough();

/** Una sesión que existe pero no se puede usar (JSON roto o forma inválida). */
export class SessionCorruptError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`La sesión "${id}" está dañada (${reason}).`);
    this.name = 'SessionCorruptError';
  }
}

/** Valida un JSON ya parseado. Lanza `SchemaVersionError` o `SessionCorruptError`. */
export function parseSession(raw: unknown, id: string, source: string): SessionContext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SessionCorruptError(id, 'no es un objeto');
  }
  assertSchemaVersion((raw as { schemaVersion?: unknown }).schemaVersion, 'session', source);
  const parsed = SessionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SessionCorruptError(
      id,
      `${issue?.path.join('.') || '(raíz)'}: ${issue?.message ?? 'inválido'}`,
    );
  }
  if (parsed.data.id !== id) {
    throw new SessionCorruptError(id, `el fichero contiene la sesión ${parsed.data.id}`);
  }
  return parsed.data as unknown as SessionContext;
}

/** Sesión que `scan` no pudo leer y omitió. */
export interface SkippedSession {
  file: string;
  reason: string;
  /** De un Stratum más nuevo (no se toca) o dañada. */
  kind: 'newer' | 'corrupt';
}

/** Aviso legible de las sesiones omitidas por `scan`; null si no hay ninguna. */
export function describeSkippedSessions(skipped: SkippedSession[]): string | null {
  if (skipped.length === 0) return null;
  const lines = skipped.map((s) =>
    s.kind === 'newer'
      ? `  ${s.file}: guardada por una versión más nueva de Stratum`
      : `  ${s.file}: ${s.reason}`,
  );
  return `${skipped.length} sesión(es) no se pudieron leer y se omiten:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// SessionStore — §12.6
// ---------------------------------------------------------------------------

export interface SaveSessionParams {
  provider: string;
  model: string;
  project: string;
  messages: Message[];
  toolCallCount: number;
  /** Si se pasa, se usa para generar el resumen automático (≤100 chars). */
  llmProvider?: IProvider;
  /** Traza de la sesión: la llamada del resumen se registra como `session-summary`. */
  trace?: TraceScope;
  /** ID de sesión existente (para actualizar en vez de crear nuevo). */
  existingId?: string;
  /** Timestamp de creación (para actualizar). */
  createdAt?: string;
  /** Hito 7 — ref al fichero de plan asociado a la sesión (§12.6). */
  planRef?: string | null;
  /** Hito 15 — perfil activo como agente principal. */
  activeAgent?: string | null;
  /** Hito 17 — modo read-only al guardar. */
  readOnly?: boolean;
  /** Hito 17 — perfil de sesión pedido. */
  sessionProfile?: string | null;
  /**
   * `updatedAt` de la versión en disco de la que parte esta conversación (la
   * que se cargó al reanudar). Si al guardar el fichero ya no está en esa
   * versión —otra terminal lo guardó entretanto—, no se pisa: la conversación
   * se guarda como sesión nueva con `forkedFrom`. Sin este campo, que ya exista
   * un fichero con `existingId` también cuenta como conflicto.
   */
  expectedUpdatedAt?: string;
  /**
   * Marca de bifurcación que conservar: los guardados posteriores de una sesión
   * que ya se bifurcó (checkpoints, `session/checkpoint.ts`) no deben perderla.
   */
  forkedFrom?: string;
}

export interface ListOptions {
  last?: number;
}

export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  private ensureDir(): void {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private sessionPath(id: string): string {
    if (!isSessionId(id)) {
      throw new Error(`Id de sesión inválido: ${JSON.stringify(id.slice(0, 80))}`);
    }
    return join(this.sessionsDir, `${id}.json`);
  }

  /** `updatedAt` de la sesión en disco; null si no existe. */
  private diskUpdatedAt(id: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.sessionPath(id), 'utf-8')) as {
        updatedAt?: unknown;
      };
      return typeof raw.updatedAt === 'string' ? raw.updatedAt : 'unknown';
    } catch (err) {
      // Existe pero ilegible: tampoco es la versión de la que partimos.
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
    }
  }

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  async save(params: SaveSessionParams): Promise<SessionContext> {
    this.ensureDir();

    const now = new Date().toISOString();
    let id = params.existingId ?? generateSessionId();
    let createdAt = params.createdAt ?? now;
    let forkedFrom: string | undefined = params.forkedFrom;
    // Concurrencia optimista: si la sesión cambió en disco desde que se cargó,
    // otra terminal la guardó. Pisarla perdería esa conversación sin avisar.
    if (params.existingId) {
      const onDisk = this.diskUpdatedAt(params.existingId);
      if (onDisk !== null && onDisk !== params.expectedUpdatedAt) {
        forkedFrom = params.existingId;
        id = generateSessionId();
        createdAt = now;
        log.warn('session changed on disk: saving as a fork', { from: forkedFrom, to: id });
      }
    }

    // Contar rondas (user+assistant) para decidir si generar resumen
    const rounds = params.messages.filter((m) => m.role === 'user').length;
    let summary = '';

    if (rounds >= 5 && params.llmProvider) {
      try {
        summary = await this.generateSummary(params, params.llmProvider);
      } catch {
        // No bloquear el guardado por un fallo en el resumen
        summary = '';
      }
    }

    // IMPORTANTE: no persistir secretos — solo el nombre del provider
    const ctx: SessionContext = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      createdAt,
      updatedAt: now,
      provider: params.provider,
      model: params.model,
      project: params.project,
      messages: params.messages,
      toolCallCount: params.toolCallCount,
      summary,
      ...(params.planRef ? { planRef: params.planRef } : {}),
      ...(params.activeAgent ? { activeAgent: params.activeAgent } : {}),
      ...(params.readOnly ? { readOnly: true } : {}),
      ...(params.sessionProfile ? { sessionProfile: params.sessionProfile } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
    };

    // Atómica: un cierre a mitad de escritura dejaba un JSON truncado y la
    // conversación perdida.
    writeFileAtomic(this.sessionPath(id), JSON.stringify(ctx, null, 2));
    return ctx;
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  load(id: string): SessionContext {
    const path = this.sessionPath(id);
    if (!existsSync(path)) {
      throw new Error(`Sesión "${id}" no encontrada en ${this.sessionsDir}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new SessionCorruptError(id, err instanceof Error ? err.message : String(err));
    }
    return parseSession(raw, id, path);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /** Sesiones legibles, más recientes primero. Omite (sin lanzar) las que no puede leer. */
  list(opts?: ListOptions): SessionContext[] {
    return this.scan(opts).sessions;
  }

  /**
   * Como `list`, pero dice qué omitió. Una sola sesión dañada no puede dejar
   * sin `sessions list` ni `prune`; y quien borra algo según lo que
   * referencian las sesiones tiene que saber que no las vio todas.
   */
  scan(opts?: ListOptions): { sessions: SessionContext[]; skipped: SkippedSession[] } {
    if (!existsSync(this.sessionsDir)) return { sessions: [], skipped: [] };

    const files = readdirSync(this.sessionsDir).filter(
      (f) => f.endsWith('.json') && isSessionId(f.slice(0, -'.json'.length)),
    );
    const sessions: SessionContext[] = [];
    const skipped: SkippedSession[] = [];
    for (const f of files) {
      try {
        sessions.push(this.load(f.slice(0, -'.json'.length)));
      } catch (err) {
        const kind: SkippedSession['kind'] =
          err instanceof SchemaVersionError && Number(err.found) > err.supported
            ? 'newer'
            : 'corrupt';
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ file: f, reason, kind });
        // debug: quien llama decide cómo mostrarlo (`describeSkippedSessions`).
        log.debug('session skipped', { file: f, reason });
      }
    }

    // Ordenar por updatedAt (más recientes primero) para orden estable
    sessions.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0));

    const limit = opts?.last ?? sessions.length;
    return { sessions: sessions.slice(0, limit), skipped };
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  delete(id: string): void {
    const path = this.sessionPath(id);
    if (!existsSync(path)) {
      throw new Error(`Sesión "${id}" no encontrada.`);
    }
    unlinkSync(path);
  }

  // -------------------------------------------------------------------------
  // prune
  // -------------------------------------------------------------------------

  /**
   * Elimina las sesiones que llevan más de `olderThan` ms **sin usarse**
   * (`updatedAt`, no `createdAt`: una sesión larga retomada ayer no es vieja).
   * Las que no se pueden leer no se tocan. Devuelve cuántas borró.
   */
  prune(olderThanMs: number, onDeleted?: (session: SessionContext) => void): number {
    if (!existsSync(this.sessionsDir)) return 0;

    const cutoff = Date.now() - olderThanMs;
    const sessions = this.list();
    let deleted = 0;

    for (const session of sessions) {
      const usedMs = new Date(session.updatedAt).getTime();
      if (usedMs < cutoff) {
        try {
          this.delete(session.id);
          deleted++;
          onDeleted?.(session);
        } catch {
          // ignorar errores individuales
        }
      }
    }

    return deleted;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Genera un resumen ≤100 chars usando el LLM. */
  private async generateSummary(params: SaveSessionParams, provider: IProvider): Promise<string> {
    const conversation = params.messages
      .filter((m) => m.role !== 'system')
      .slice(0, 20) // primeros 20 mensajes para no exceder contexto
      .map((m) => `${m.role}: ${(m.content ?? '').slice(0, 200)}`)
      .join('\n');

    const prompt: Message[] = [
      {
        role: 'user',
        content:
          'Resume esta conversación en máximo 100 caracteres (una sola frase breve):\n\n' +
          conversation,
      },
    ];

    let result = '';
    for await (const chunk of tracedCompletion({
      origin: 'session-summary',
      provider,
      providerName: params.provider,
      request: {
        messages: prompt,
        stream: true,
        model: params.model,
        signal: AbortSignal.timeout(15000),
      },
      trace: params.trace,
    })) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) result += content;
    }

    return result.trim().slice(0, 100);
  }
}

// ---------------------------------------------------------------------------
// Parsing de duración para prune (e.g. "30d", "7d", "2h")
// ---------------------------------------------------------------------------

export function parseDuration(str: string): number {
  const match = /^(\d+)(d|h|m|s)$/.exec(str);
  if (!match) throw new Error(`Formato de duración inválido: "${str}". Ejemplos: 30d, 7d, 2h`);
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit]!;
}

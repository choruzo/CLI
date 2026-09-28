import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { resolve, sep } from 'path';
import { sweepTempFiles, writeFileAtomicSync } from './atomic-file.js';
import type { Message } from '../agent/types.js';
import type { SessionContext } from '../session/types.js';
import { SessionCorruptError, parseSession } from '../session/store.js';
import { SESSION_SCHEMA_VERSION, SchemaVersionError } from '../config/schema-version.js';

/**
 * Sesiones de las conversaciones de Stratum Desktop (D1, 15.5): de aquí sale el
 * historial con el que se rehidrata el agente cuando el sidecar se reinicia.
 *
 * Mismo formato que `SessionStore` de la CLI (`SessionContext`, con
 * `schemaVersion`), pero en su propio directorio y con dos diferencias:
 * - el id es el `conversationId` (UUID) que genera el frontend, validado antes
 *   de usarlo como nombre de fichero: viene del webview;
 * - la escritura es atómica (`writeFileAtomicSync`). Un sidecar que muere a
 *   mitad de un guardado —justo el caso que motiva este store— no puede dejar
 *   la sesión corrupta.
 *
 * Leer valida como la CLI (`parseSession`): un fichero dañado lanza
 * `SessionCorruptError` y uno de un Stratum más nuevo `SchemaVersionError`.
 * Ninguno de los dos se sobrescribe nunca: el dañado se aparta con `setAside`
 * y el más nuevo no se abre (lo decide `ConversationHost`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConversationId(id: string): boolean {
  return UUID.test(id);
}

/** Ids de conversación de los `<uuid>.json` de un directorio. */
export function idsIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const id = e.slice(0, -'.json'.length);
    if (isConversationId(id)) ids.push(id);
  }
  return ids;
}

/**
 * Renombra un fichero ilegible a `<fichero>.corrupt-<fecha>`, como
 * `decisions.json` en la CLI. Queda fuera de `idsIn` (no acaba en `.json`) y a
 * mano del usuario para recuperarlo.
 */
export function setAsideFile(path: string): string {
  const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(path, aside);
  return aside;
}

/** Por qué no se pudo leer una sesión o un registro. */
export type UnreadableReason = 'corrupt' | 'newer';

export function unreadableReason(err: unknown): UnreadableReason {
  return err instanceof SchemaVersionError || err instanceof NewerRecordError ? 'newer' : 'corrupt';
}

/** Un registro que escribió un Stratum más nuevo: no se interpreta ni se reescribe. */
export class NewerRecordError extends Error {
  constructor(what: string, version: unknown) {
    super(
      `${what} lo guardó una versión más nueva de Stratum (versión ${String(version)}); ` +
        'actualiza Stratum Desktop para abrirla.',
    );
    this.name = 'NewerRecordError';
  }
}

export interface DesktopSessionSave {
  conversationId: string;
  provider: string;
  model: string;
  messages: Message[];
  toolCallCount: number;
  createdAt?: string;
}

export class DesktopSessionStore {
  constructor(readonly dir: string) {}

  private pathFor(conversationId: string): string {
    if (!isConversationId(conversationId)) {
      throw new Error(`conversationId inválido: ${JSON.stringify(conversationId.slice(0, 64))}`);
    }
    const path = resolve(this.dir, `${conversationId}.json`);
    // Defensa en profundidad: con el UUID validado no puede pasar, pero el
    // fichero tiene que quedar dentro del directorio pase lo que pase.
    if (!path.startsWith(resolve(this.dir) + sep)) {
      throw new Error('ruta de sesión fuera del directorio de sesiones');
    }
    return path;
  }

  exists(conversationId: string): boolean {
    return existsSync(this.pathFor(conversationId));
  }

  remove(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
  }

  /** Conversaciones con sesión guardada. */
  ids(): string[] {
    return idsIn(this.dir);
  }

  /** Lanza `SessionCorruptError` (dañada) o `SchemaVersionError` (más nueva). */
  load(conversationId: string): SessionContext | null {
    const path = this.pathFor(conversationId);
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new SessionCorruptError(
        conversationId,
        `JSON inválido (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return parseSession(raw, conversationId, path);
  }

  /** Aparta una sesión dañada (nunca se pisa). Devuelve la ruta nueva. */
  setAside(conversationId: string): string {
    return setAsideFile(this.pathFor(conversationId));
  }

  save(p: DesktopSessionSave): SessionContext {
    const path = this.pathFor(p.conversationId);
    const now = new Date().toISOString();
    const ctx: SessionContext = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: p.conversationId,
      createdAt: p.createdAt ?? now,
      updatedAt: now,
      provider: p.provider,
      model: p.model,
      // Sin proyecto: el modo Chat no trabaja sobre ninguna carpeta.
      project: '',
      messages: p.messages,
      toolCallCount: p.toolCallCount,
      summary: '',
    };
    // Sin sangrado: se guarda síncrono tras cada tool, y con historiales de
    // varios MB el sangrado casi duplica el tamaño y el tiempo que el sidecar
    // (el de todas las conversaciones) pasa bloqueado.
    writeFileAtomicSync(path, JSON.stringify(ctx));
    return ctx;
  }

  /** Borra los temporales de escrituras que no terminaron (proceso matado). */
  sweepTemp(): number {
    return sweepTempFiles(this.dir);
  }
}

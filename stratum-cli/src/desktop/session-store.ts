import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve, sep } from 'path';
import type { Message } from '../agent/types.js';
import type { SessionContext } from '../session/types.js';
import { SESSION_SCHEMA_VERSION, assertSchemaVersion } from '../config/schema-version.js';

/**
 * Sesiones de las conversaciones de Stratum Desktop (D1, 15.5): de aquí sale el
 * historial con el que se rehidrata el agente cuando el sidecar se reinicia.
 *
 * Mismo formato que `SessionStore` de la CLI (`SessionContext`, con
 * `schemaVersion`), pero en su propio directorio y con dos diferencias:
 * - el id es el `conversationId` (UUID) que genera el frontend, validado antes
 *   de usarlo como nombre de fichero: viene del webview;
 * - la escritura es atómica (tmp + rename). Un sidecar que muere a mitad de un
 *   guardado —justo el caso que motiva este store— no puede dejar la sesión
 *   corrupta.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConversationId(id: string): boolean {
  return UUID.test(id);
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
  constructor(private readonly dir: string) {}

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

  load(conversationId: string): SessionContext | null {
    const path = this.pathFor(conversationId);
    if (!existsSync(path)) return null;
    const ctx = JSON.parse(readFileSync(path, 'utf-8')) as SessionContext;
    assertSchemaVersion(ctx.schemaVersion, 'session', path);
    if (!Array.isArray(ctx.messages)) throw new Error(`sesión sin historial: ${path}`);
    return ctx;
  }

  save(p: DesktopSessionSave): SessionContext {
    const path = this.pathFor(p.conversationId);
    mkdirSync(this.dir, { recursive: true });
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
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ctx, null, 2), 'utf-8');
    renameSync(tmp, path);
    return ctx;
  }
}

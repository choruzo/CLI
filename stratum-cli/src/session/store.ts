import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { SessionContext } from './types.js';
import type { IProvider } from '../providers/base.js';
import type { Message } from '../agent/types.js';

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

function generateSessionId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `sess_${date}_${time}_${randomAlpha(3)}`;
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
  /** ID de sesión existente (para actualizar en vez de crear nuevo). */
  existingId?: string;
  /** Timestamp de creación (para actualizar). */
  createdAt?: string;
  /** Hito 7 — ref al fichero de plan asociado a la sesión (§12.6). */
  planRef?: string | null;
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
    return join(this.sessionsDir, `${id}.json`);
  }

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  async save(params: SaveSessionParams): Promise<SessionContext> {
    this.ensureDir();

    const now = new Date().toISOString();
    const id = params.existingId ?? generateSessionId();
    const createdAt = params.createdAt ?? now;

    // Contar rondas (user+assistant) para decidir si generar resumen
    const rounds = params.messages.filter((m) => m.role === 'user').length;
    let summary = '';

    if (rounds >= 5 && params.llmProvider) {
      try {
        summary = await this.generateSummary(params.messages, params.llmProvider, params.model);
      } catch {
        // No bloquear el guardado por un fallo en el resumen
        summary = '';
      }
    }

    // IMPORTANTE: no persistir secretos — solo el nombre del provider
    const ctx: SessionContext = {
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
    };

    writeFileSync(this.sessionPath(id), JSON.stringify(ctx, null, 2), 'utf-8');
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
    return JSON.parse(readFileSync(path, 'utf-8')) as SessionContext;
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  list(opts?: ListOptions): SessionContext[] {
    if (!existsSync(this.sessionsDir)) return [];

    const files = readdirSync(this.sessionsDir).filter(
      (f) => f.endsWith('.json') && f.startsWith('sess_'),
    );

    // Parsear y ordenar por updatedAt (más recientes primero) para orden estable
    const sessions = files.map((f) => {
      const raw = readFileSync(join(this.sessionsDir, f), 'utf-8');
      return JSON.parse(raw) as SessionContext;
    });

    sessions.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0));

    const limit = opts?.last ?? sessions.length;
    return sessions.slice(0, limit);
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
   * Elimina sesiones más antiguas que `olderThan` ms.
   * Devuelve el número de sesiones eliminadas.
   */
  prune(olderThanMs: number): number {
    if (!existsSync(this.sessionsDir)) return 0;

    const cutoff = Date.now() - olderThanMs;
    const sessions = this.list();
    let deleted = 0;

    for (const session of sessions) {
      const createdMs = new Date(session.createdAt).getTime();
      if (createdMs < cutoff) {
        try {
          this.delete(session.id);
          deleted++;
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
  private async generateSummary(
    messages: Message[],
    provider: IProvider,
    model: string,
  ): Promise<string> {
    const conversation = messages
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
    for await (const chunk of provider.complete({
      messages: prompt,
      stream: true,
      model,
      signal: AbortSignal.timeout(15000),
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

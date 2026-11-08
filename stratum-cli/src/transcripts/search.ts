/**
 * M19 fase 3 — búsqueda de solo lectura en las conversaciones guardadas por el
 * daemon (`~/.stratum/daemon/sessions/<id>/conversation.jsonl`, y `archived/`).
 *
 * Es la capa de «transcripts» de *Components of agent memory*: lo que se dijo,
 * entero, para contrastar o recuperar lo que una nota de memoria resume. Nunca
 * escribe: abre cada conversación con `readOnly` (sin cerrojo ni reparación), no
 * toca la memoria de decisiones ni la de sesión, y no decide nada (la tool que
 * lo usa no es de autoridad).
 *
 * **Ámbito.** Una búsqueda mira solo las conversaciones de su ámbito: las de un
 * agente embebido (`assistant` o `companion`, nunca las del otro) o las de un
 * proyecto (`cwd`). Las sesiones de una rutina (M16) quedan fuera siempre: nada
 * suyo vuelve al contexto del chat principal. Una sesión de un Stratum más
 * nuevo (`schemaVersion`) o ilegible se salta: ante la duda, no se lee.
 *
 * Búsqueda léxica (sin embeddings): minúsculas, sin acentos, por términos.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { FileConversationStore } from '../conversation/store.js';
import type { ProtocolChatMessage } from '../protocol/index.js';
import { isSessionId } from '../session/store.js';

/** Formato de `session.json` que esta versión entiende. */
const META_VERSION = 1;

/** Cuántas conversaciones se miran como mucho (las más recientes del ámbito). */
export const MAX_SOURCES = 40;
/** Cuántos mensajes de cada una (los últimos). */
export const MAX_MESSAGES_PER_SOURCE = 3000;

export type TranscriptScope = { agent: 'assistant' | 'companion' } | { cwd: string };

export interface TranscriptSource {
  sessionId: string;
  title: string;
  agent: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** Archivada (conversación nueva del `companion`). */
  archived: boolean;
  /** Ruta de su `conversation.jsonl`. */
  file: string;
}

export interface TranscriptHit {
  source: TranscriptSource;
  messageId: string;
  kind: 'user' | 'assistant';
  at: number;
  snippet: string;
  score: number;
}

const metaSchema = z.object({
  schemaVersion: z.number(),
  sessionId: z.string(),
  cwd: z.string(),
  agent: z.string().nullable(),
  routineId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Minúsculas y sin marcas diacríticas, para comparar. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** ¿`child` es `root` o está dentro? (sin mirar mayúsculas en Windows). */
function isWithin(child: string, root: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(`${r}/`) || c.startsWith(`${r}\\`);
}

function readTitle(dir: string): string {
  try {
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as {
      session?: { title?: unknown };
    };
    const title = snapshot.session?.title;
    return typeof title === 'string' ? title.slice(0, 120) : '';
  } catch {
    return '';
  }
}

function inScope(meta: z.infer<typeof metaSchema>, scope: TranscriptScope): boolean {
  if ('agent' in scope) return meta.agent === scope.agent;
  // Un proyecto: sus sesiones de código (ninguna de un agente embebido).
  return meta.agent !== 'assistant' && meta.agent !== 'companion' && isWithin(meta.cwd, scope.cwd);
}

/** La fuente de una carpeta de sesión, o `null` si no es legible, es de una rutina o está fuera del ámbito. */
function readSource(
  dir: string,
  id: string,
  archived: boolean,
  scope: TranscriptScope,
): TranscriptSource | null {
  try {
    const meta = metaSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    if (meta.schemaVersion > META_VERSION || meta.sessionId !== id) return null;
    // Nada de una rutina vuelve al contexto del chat principal (M16).
    if (meta.routineId || !inScope(meta, scope)) return null;
    const file = join(dir, 'conversation.jsonl');
    if (!existsSync(file)) return null;
    return {
      sessionId: id,
      title: readTitle(dir),
      agent: meta.agent,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived,
      file,
    };
  } catch {
    return null;
  }
}

/**
 * Las conversaciones de un ámbito, las más recientes primero. `exclude`: la
 * sesión que pregunta (su historial ya está en su contexto).
 */
export function listSources(
  sessionsDir: string,
  scope: TranscriptScope,
  opts: { exclude?: string } = {},
): TranscriptSource[] {
  const out: TranscriptSource[] = [];
  const visit = (root: string, archived: boolean) => {
    if (!existsSync(root)) return;
    for (const id of readdirSync(root)) {
      if (!isSessionId(id) || id === opts.exclude) continue;
      const source = readSource(join(root, id), id, archived, scope);
      if (source) out.push(source);
    }
  };
  visit(sessionsDir, false);
  visit(join(sessionsDir, 'archived'), true);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, MAX_SOURCES);
}

function openStore(source: TranscriptSource): FileConversationStore | null {
  try {
    return FileConversationStore.open(source.file, source.sessionId, { readOnly: true });
  } catch {
    // Formato más nuevo, ilegible, o bloqueado: no se lee.
    return null;
  }
}

const textOf = (m: ProtocolChatMessage): string | null =>
  m.kind === 'user' || m.kind === 'assistant' ? m.text : null;

/** Términos de una consulta: sin acentos, de 2+ caracteres, sin repetidos. */
export function queryTerms(query: string): string[] {
  const terms = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  return [...new Set(terms)].slice(0, 12);
}

/** Un fragmento del texto alrededor del primer término que aparece. */
export function snippetAround(text: string, terms: string[], width = 260): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const folded = fold(flat);
  // `fold` puede cambiar la longitud (descomposición): solo se usa su índice si coincide.
  const comparable = folded.length === flat.length;
  let at = -1;
  if (comparable) {
    for (const t of terms) {
      const i = folded.indexOf(t);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
  }
  if (flat.length <= width) return flat;
  const start = Math.max(0, (at === -1 ? 0 : at) - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface SearchOptions {
  limit?: number;
  /** Como mucho este número de coincidencias de una misma conversación. */
  perSession?: number;
}

/**
 * Busca `query` en las conversaciones dadas. Puntúa por la fracción de
 * términos presentes (más si aparece la frase tal cual); exige al menos la
 * mitad de los términos. Devuelve los mejores, el más reciente primero a igual
 * puntuación.
 */
export function searchTranscripts(
  sources: readonly TranscriptSource[],
  query: string,
  opts: SearchOptions = {},
): TranscriptHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const need = Math.max(1, Math.ceil(terms.length / 2));
  const phrase = fold(query).replace(/\s+/g, ' ').trim();
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const perSession = Math.max(opts.perSession ?? 2, 1);
  const hits: TranscriptHit[] = [];
  for (const source of sources) {
    const store = openStore(source);
    if (!store) continue;
    try {
      const count = Math.min(store.chatCount(), MAX_MESSAGES_PER_SOURCE);
      const messages = count > 0 ? store.listRecentChat(count) : [];
      const found: TranscriptHit[] = [];
      for (const m of messages) {
        const text = textOf(m);
        if (!text) continue;
        const folded = fold(text);
        const present = terms.filter((t) => folded.includes(t)).length;
        if (present < need) continue;
        const score = present / terms.length + (folded.includes(phrase) ? 0.5 : 0);
        found.push({
          source,
          messageId: m.id,
          kind: m.kind as 'user' | 'assistant',
          at: m.at,
          snippet: snippetAround(text, terms),
          score,
        });
      }
      found.sort((a, b) => b.score - a.score);
      hits.push(...found.slice(0, perSession));
    } finally {
      store.close();
    }
  }
  hits.sort((a, b) => b.score - a.score || b.source.updatedAt - a.source.updatedAt);
  return hits.slice(0, limit);
}

export interface ReadAround {
  source: TranscriptSource;
  messages: Array<{ id: string; kind: string; at: number; text: string }>;
}

/**
 * Los mensajes de texto alrededor de `messageId` en una conversación del
 * ámbito (`before` y `after` a cada lado). `null` si no está en el ámbito o el
 * mensaje no existe: no se distingue, para no revelar qué hay fuera.
 */
export function readAround(
  sources: readonly TranscriptSource[],
  sessionId: string,
  messageId: string,
  opts: { before?: number; after?: number } = {},
): ReadAround | null {
  const source = sources.find((s) => s.sessionId === sessionId);
  if (!source) return null;
  const store = openStore(source);
  if (!store) return null;
  try {
    const count = Math.min(store.chatCount(), MAX_MESSAGES_PER_SOURCE);
    const all = count > 0 ? store.listRecentChat(count) : [];
    const idx = all.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const before = Math.min(Math.max(opts.before ?? 3, 0), 8);
    const after = Math.min(Math.max(opts.after ?? 3, 0), 8);
    const slice = all.slice(Math.max(0, idx - before), idx + after + 1);
    const messages = slice.flatMap((m) => {
      const text = textOf(m);
      return text === null ? [] : [{ id: m.id, kind: m.kind, at: m.at, text }];
    });
    return { source, messages };
  } finally {
    store.close();
  }
}

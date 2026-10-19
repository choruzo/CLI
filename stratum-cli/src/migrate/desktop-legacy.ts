/**
 * M12 — migración **única y versionada** de las conversaciones de Stratum
 * Desktop D1–D7 (`~/.stratum/desktop/`) a sesiones Stratum normales en
 * `stratumd`.
 *
 * Antes de M12, Desktop tenía su propio runtime y guardaba cada conversación
 * en dos ficheros suyos: el historial del agente (`sessions/<id>.json`, el
 * formato de sesión de la CLI) y lo que pintaba (`conversations/<id>.json`).
 * Desde M12 eso ya no se lee: Desktop es un cliente del daemon. Para no perder
 * las conversaciones, esto las **traspasa** al daemon por el camino oficial de
 * M10 —el mismo de `/detach`—: se montan aquí, en este proceso, como una
 * sesión del agente `assistant` en su carpeta de siempre, se publican y se
 * traspasan. El daemon las adopta (mismo contexto del agente, la conversación
 * visible) y las guarda (M11). Nada escribe en el almacén del daemon por fuera.
 *
 * Una sola vez: lo hecho queda en `~/.stratum/desktop/imported.json`
 * (`LEGACY_IMPORT_VERSION`); lo de Desktop no se borra ni se modifica, y Desktop
 * nunca lo vuelve a leer (no es una segunda fuente de verdad). Un traspaso con
 * resultado desconocido **no** se reintenta solo: queda anotado y se dice.
 *
 * Lo que no se migra, a sabiendas: el razonamiento (la conversación del
 * protocolo no lo lleva), las tarjetas de fichero de cada turno (los ficheros
 * siguen en su carpeta) y los ficheros de una conversación que D3 archivó o
 * purgó (el `.tar.gz` queda donde estaba).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { z } from 'zod';
import type { Message } from '../agent/types.js';
import type { StratumConfig } from '../config/schema.js';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';
import { TRANSCRIPT_LIMITS, clipText, type ProtocolChatMessage } from '../protocol/index.js';
import { parseSession } from '../session/store.js';

const log = getLogger('migrate').child('desktop');

export const LEGACY_IMPORT_VERSION = 1;
const IMPORTED_FILE = 'imported.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function legacyDesktopDir(home: string = homedir()): string {
  return join(home, '.stratum', 'desktop');
}

/** La raíz de las carpetas de conversación (`desktop.workspaces.root`, D2). */
export function legacyWorkspacesRoot(config: StratumConfig, home: string = homedir()): string {
  const fallback = join(legacyDesktopDir(home), 'workspaces');
  const raw = config.desktop.workspaces.root?.trim();
  if (!raw) return fallback;
  const expanded = raw === '~' || /^~[\\/]/.test(raw) ? join(home, raw.slice(1)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : fallback;
}

// --- lo que guardaba Desktop (tolerante: lo que no encaja, no se migra) ---------

const transcriptTurnSchema = z.object({
  turnId: z.string(),
  user: z.object({
    text: z.string(),
    attachments: z.array(z.object({ path: z.string(), name: z.string() })).optional(),
  }),
  parts: z.array(
    z.union([
      z.object({ kind: z.literal('text'), text: z.string() }),
      z.object({ kind: z.literal('reasoning'), text: z.string() }),
      z.object({ kind: z.literal('tool'), id: z.string() }),
      z.object({ kind: z.literal('notice'), tone: z.string(), text: z.string() }),
    ]),
  ),
  toolCalls: z.record(
    z.object({ id: z.string(), name: z.string(), state: z.string(), input: z.string() }),
  ),
  status: z.string(),
  startedAt: z.string(),
});

const recordSchema = z.object({
  version: z.number().int(),
  conversationId: z.string(),
  title: z.string(),
  createdAt: z.string().optional(),
  transcript: z.array(z.unknown()),
});

export type LegacyTurn = z.infer<typeof transcriptTurnSchema>;

export interface LegacyConversation {
  conversationId: string;
  title: string;
  /** Historial del agente, tal como lo guardó (formato de sesión de la CLI). */
  messages: Message[];
  turns: LegacyTurn[];
  /** Su carpeta, si existe; si no, se crea vacía al importar. */
  folder: string;
  folderExists: boolean;
  /** D3 la comprimió (`<id>.tar.gz`): sus ficheros no vuelven solos. */
  archived: boolean;
}

export interface ImportRecord {
  status: 'imported' | 'unknown';
  sessionId?: string;
  at: string;
}

export interface ImportState {
  version: number;
  conversations: Record<string, ImportRecord>;
}

const importStateSchema = z.object({
  version: z.number().int(),
  conversations: z.record(
    z.object({
      status: z.enum(['imported', 'unknown']),
      sessionId: z.string().optional(),
      at: z.string(),
    }),
  ),
});

export class ImportStateError extends Error {}

/** Lo ya migrado. Un fichero de una versión más nueva no se toca. */
export function readImportState(desktopDir: string): ImportState {
  const path = join(desktopDir, IMPORTED_FILE);
  if (!existsSync(path)) return { version: LEGACY_IMPORT_VERSION, conversations: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new ImportStateError(`${path} está dañado: no se migra nada.`);
  }
  const parsed = importStateSchema.safeParse(raw);
  if (!parsed.success) throw new ImportStateError(`${path} está dañado: no se migra nada.`);
  if (parsed.data.version > LEGACY_IMPORT_VERSION) {
    throw new ImportStateError(`${path} lo escribió un Stratum más nuevo: no se toca.`);
  }
  return parsed.data;
}

export function writeImportState(desktopDir: string, state: ImportState): void {
  mkdirSync(desktopDir, { recursive: true });
  writeFileAtomic(join(desktopDir, IMPORTED_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export interface Discovered {
  conversations: LegacyConversation[];
  /** Lo que no se puede migrar, y por qué. */
  skipped: Array<{ conversationId: string; reason: string }>;
}

/** Las conversaciones de Desktop que aún no se migraron. */
export function discoverLegacyConversations(opts: {
  desktopDir: string;
  workspacesRoot: string;
  state: ImportState;
}): Discovered {
  const sessionsDir = join(opts.desktopDir, 'sessions');
  const out: Discovered = { conversations: [], skipped: [] };
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!UUID.test(id) || opts.state.conversations[id]) continue;
    let messages: Message[];
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir, name), 'utf-8')) as unknown;
      messages = parseSession(raw, id, join(sessionsDir, name)).messages;
    } catch (err) {
      out.skipped.push({
        conversationId: id,
        reason: `su historial no se puede leer (${errorText(err)})`,
      });
      continue;
    }
    let title = '';
    let turns: LegacyTurn[] = [];
    const recordPath = join(opts.desktopDir, 'conversations', name);
    if (existsSync(recordPath)) {
      try {
        const record = recordSchema.parse(JSON.parse(readFileSync(recordPath, 'utf-8')));
        if (record.version > 1) {
          out.skipped.push({
            conversationId: id,
            reason: 'la guardó una versión más nueva de Desktop',
          });
          continue;
        }
        title = record.title;
        turns = record.transcript.flatMap((t) => {
          const parsed = transcriptTurnSchema.safeParse(t);
          return parsed.success ? [parsed.data] : [];
        });
      } catch (err) {
        // Sin registro legible se migra igual: el contexto del agente es lo que importa.
        log.warn('legacy conversation record unreadable', { conversationId: id, err });
      }
    }
    const folder = join(opts.workspacesRoot, id);
    out.conversations.push({
      conversationId: id,
      title,
      messages,
      turns,
      folder,
      folderExists: existsSync(join(folder)),
      archived: existsSync(join(opts.workspacesRoot, `${id}.tar.gz`)),
    });
  }
  return out;
}

const toolState = (state: string): 'completed' | 'error' =>
  state === 'completed' ? 'completed' : 'error';

/**
 * Lo que pintaba Desktop, como la conversación del protocolo
 * (`ProtocolChatMessage`), con ids `m1`, `m2`… en orden. Sin el razonamiento:
 * la conversación del protocolo no lo lleva.
 */
export function legacyTranscriptToChat(turns: readonly LegacyTurn[]): ProtocolChatMessage[] {
  const out: ProtocolChatMessage[] = [];
  const text = (t: string) => clipText(t, TRANSCRIPT_LIMITS.textChars);
  let n = 0;
  for (const turn of turns) {
    const runId = `imported-${turn.turnId}`.slice(0, 128);
    const at = Number.isNaN(Date.parse(turn.startedAt)) ? 0 : Date.parse(turn.startedAt);
    const base = () => ({ id: `m${++n}`, runId, at });
    const attached = turn.user.attachments?.map((a) => a.path) ?? [];
    const userText =
      attached.length > 0
        ? `${turn.user.text}\n\n${attached.map((p) => `- ${p}`).join('\n')}`
        : turn.user.text;
    out.push({ ...base(), kind: 'user', text: text(userText) });
    for (const part of turn.parts) {
      if (part.kind === 'text' && part.text.trim()) {
        out.push({ ...base(), kind: 'assistant', text: text(part.text) });
      } else if (part.kind === 'tool') {
        const call = turn.toolCalls[part.id];
        if (!call) continue;
        out.push({
          ...base(),
          kind: 'tool',
          callId: call.id,
          name: call.name,
          description: clipText(call.input, TRANSCRIPT_LIMITS.descriptionChars),
          state: toolState(call.state),
        });
      }
    }
    if (turn.status === 'cancelled' || turn.status === 'error' || turn.status === 'interrupted') {
      const notice = turn.parts.find((p) => p.kind === 'notice');
      out.push({
        ...base(),
        kind: 'outcome',
        status: turn.status === 'cancelled' ? 'cancelled' : 'failed',
        text: notice && 'text' in notice ? text(notice.text) : '',
      });
    }
  }
  return out;
}

/** La carpeta de una conversación, lista para ser el directorio de su sesión. */
export function ensureFolder(folder: string): void {
  for (const sub of ['inputs', 'outputs', 'scratch'])
    mkdirSync(join(folder, sub), { recursive: true });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

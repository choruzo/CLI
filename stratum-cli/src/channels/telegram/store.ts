/**
 * M18 — `~/.stratum/daemon/telegram.json`: el token del bot y los chats
 * emparejados (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Vive en la carpeta **privada** del daemon (`ensurePrivateDir`, junto a
 * `approver.json`) y no en `.stratumrc.json`: el token da acceso al bot y un
 * emparejamiento da autoridad de aprobar, así que ninguno de los dos puede
 * acabar en un `config get`, en un fichero que se comparte ni en un repo. Las
 * tools del agente no llegan a esa carpeta (`PATH_RULES` en `tools/guards.ts`).
 *
 * Se escribe de forma atómica (temporal + `rename`, `0600`) y se valida con Zod
 * al leer. Un fichero que no valida **apaga el canal** (falla cerrado) y uno de
 * un Stratum más nuevo no se toca.
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { ensurePrivateDirSync } from '../../daemon/private-dir.js';
import { TELEGRAM_TOKEN_RE } from './api.js';

export const TELEGRAM_FILE = 'telegram.json';
export const TELEGRAM_SCHEMA_VERSION = 1;

const pairedSchema = z
  .object({
    /** Quién habla: el `from.id` de Telegram. */
    userId: z.number().int(),
    /** Su chat privado con el bot (adonde va el espejo). */
    chatId: z.number().int(),
    /** Nombre visible, para enseñarlo; no identifica a nadie. */
    name: z.string().max(200),
    username: z.string().max(64).optional(),
    pairedAt: z.string(),
  })
  .strict();

const fileSchema = z
  .object({
    schemaVersion: z.literal(TELEGRAM_SCHEMA_VERSION),
    token: z.string().regex(TELEGRAM_TOKEN_RE),
    bot: z.object({ id: z.number().int(), username: z.string().min(1).max(64) }).strict(),
    paired: z.array(pairedSchema).max(16),
    updatedAt: z.string(),
  })
  .strict();

export type TelegramPaired = z.infer<typeof pairedSchema>;
export type TelegramFile = z.infer<typeof fileSchema>;

export type TelegramFileState =
  | { state: 'absent' }
  /** No valida: el canal queda apagado hasta que `setup` lo rehaga. */
  | { state: 'invalid' }
  /** De un Stratum más nuevo: no se lee ni se toca. */
  | { state: 'newer'; schemaVersion: number }
  | { state: 'ok'; file: TelegramFile };

/** Lo que se puede enseñar del fichero: todo menos el token. */
export interface TelegramPublicState {
  bot: { id: number; username: string };
  paired: TelegramPaired[];
  updatedAt: string;
}

export function telegramFilePath(dir: string): string {
  return join(dir, TELEGRAM_FILE);
}

export function readTelegramFile(dir: string): TelegramFileState {
  let text: string;
  try {
    text = readFileSync(telegramFilePath(dir), 'utf8');
  } catch {
    return { state: 'absent' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > TELEGRAM_SCHEMA_VERSION) {
    return { state: 'newer', schemaVersion: version };
  }
  const parsed = fileSchema.safeParse(json);
  return parsed.success ? { state: 'ok', file: parsed.data } : { state: 'invalid' };
}

export function publicTelegramState(file: TelegramFile): TelegramPublicState {
  return {
    bot: { ...file.bot },
    paired: file.paired.map((p) => ({ ...p })),
    updatedAt: file.updatedAt,
  };
}

/** Escribe el fichero entero, validado, en la carpeta privada. */
export function writeTelegramFile(dir: string, file: TelegramFile): string {
  const valid = fileSchema.parse(file);
  ensurePrivateDirSync(dir);
  const path = telegramFilePath(dir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* sin permisos POSIX (Windows): el fichero queda con los de la carpeta */
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

export class TelegramFileNewerError extends Error {
  override readonly name = 'TelegramFileNewerError';

  constructor(readonly schemaVersion: number) {
    super(
      `telegram.json was written by a newer Stratum (schemaVersion ${schemaVersion}); ` +
        'it is left untouched.',
    );
  }
}

/**
 * Guarda el token de un bot ya comprobado con `getMe`. Los emparejamientos se
 * conservan si es **el mismo bot**; con otro bot se descartan, porque un chat
 * privado es con un bot concreto y la autoridad se dio para ese.
 *
 * @throws TelegramFileNewerError si el fichero es de un Stratum más nuevo.
 */
export function saveTelegramBot(
  dir: string,
  token: string,
  bot: { id: number; username: string },
  now: Date = new Date(),
): { path: string; keptPaired: number; droppedPaired: number } {
  const current = readTelegramFile(dir);
  if (current.state === 'newer') throw new TelegramFileNewerError(current.schemaVersion);
  const previous = current.state === 'ok' ? current.file.paired : [];
  const sameBot = current.state === 'ok' && current.file.bot.id === bot.id;
  const paired = sameBot ? previous : [];
  const path = writeTelegramFile(dir, {
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    token,
    bot: { id: bot.id, username: bot.username },
    paired,
    updatedAt: now.toISOString(),
  });
  return { path, keptPaired: paired.length, droppedPaired: previous.length - paired.length };
}

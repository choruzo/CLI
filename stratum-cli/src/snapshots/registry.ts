/**
 * Registro de turnos con cambios del agente: `turns-<sessionId>.json` (UX-1).
 *
 * Un turno se registra solo si su snapshot T0 difiere del T1 (algo cambió en el
 * work-tree). Es el estado del que `planRevert`/`revertTurns` parten, así que:
 *  - se escribe de forma atómica (`writeFileAtomic`);
 *  - se valida con Zod al leer, con `schemaVersion`;
 *  - un fichero escrito por un Stratum más nuevo **no se toca** y deja los
 *    snapshots desactivados para la sesión (reescribirlo perdería turnos).
 */
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('snapshots');

/** Versión del formato de `turns-<sessionId>.json` que entiende este core. */
export const SNAPSHOT_TURNS_SCHEMA_VERSION = 1;

/** Estado de un fichero en el diff del turno (de `git diff-tree --name-status`). */
export type TurnFileStatus = 'added' | 'modified' | 'deleted';

export interface TurnFileEntry {
  path: string;
  status: TurnFileStatus;
  /** Líneas añadidas (`git diff-tree --numstat`). Binarios: ausente, nunca 0. */
  additions?: number;
  /** Líneas borradas. Binarios: ausente, nunca 0. */
  deletions?: number;
}

/** Un turno con cambios, tal como vive en el registro y en `getUndoableTurns()`. */
export interface TurnRecord {
  /** Contador por sesión: solo cuentan los turnos con cambios. */
  turn: number;
  /** ISO 8601 del T0. */
  startedAt: string;
  /** ISO 8601 del T1. */
  endedAt: string;
  /** Hash del árbol antes del turno. */
  before: string;
  /** Hash del árbol después del turno. */
  after: string;
  /** Qué ficheros tocó el turno y cómo. */
  files: TurnFileEntry[];
  /** Ficheros descartados por `maxFileBytes`: sin snapshot, no revertibles. */
  skipped: string[];
}

const TurnFileEntrySchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

const TurnRecordSchema = z.object({
  turn: z.number().int().positive(),
  startedAt: z.string(),
  endedAt: z.string(),
  before: z.string().min(1),
  after: z.string().min(1),
  files: z.array(TurnFileEntrySchema),
  skipped: z.array(z.string()).default([]),
});

// `passthrough`: un campo que añada una versión compatible no se pierda al reescribir.
const TurnsFileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    turns: z.array(TurnRecordSchema),
  })
  .passthrough();

/** Resultado de leer el registro; `incompatible` desactiva los snapshots. */
export type LoadTurnsResult =
  | { ok: true; turns: TurnRecord[] }
  | { ok: false; reason: 'incompatible' | 'unreadable' };

export function loadTurnsFile(path: string): LoadTurnsResult {
  if (!existsSync(path)) return { ok: true, turns: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    log.warn('turns registry is unreadable; starting empty (never rewritten blindly)', {
      path,
      err,
    });
    return { ok: false, reason: 'unreadable' };
  }
  // Un fichero de una versión más nueva no se toca: los snapshots quedan
  // desactivados para esta sesión y el fichero queda intacto.
  const check = checkSchemaVersion(
    (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
    SNAPSHOT_TURNS_SCHEMA_VERSION,
  );
  if (!check.ok) {
    log.warn('turns registry has a newer schemaVersion; snapshots stay disabled', {
      path,
      found: check.version,
    });
    return { ok: false, reason: 'incompatible' };
  }
  const parsed = TurnsFileSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn('turns registry failed validation; starting empty', { path });
    return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, turns: parsed.data.turns };
}

/** Escritura atómica del registro. Siempre con `schemaVersion` actual. */
export function saveTurnsFile(path: string, turns: TurnRecord[]): void {
  writeFileAtomic(
    path,
    JSON.stringify({ schemaVersion: SNAPSHOT_TURNS_SCHEMA_VERSION, turns }, null, 2),
  );
}

/**
 * M20 — qué conectores tiene activos el `companion`:
 * `~/.stratum/companion/connectors.json` (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Lo escribe **solo el daemon** (`connectors.enable|disable`), como
 * `routines.json`; las sesiones del `companion` lo leen al empezar cada turno.
 * Mismas reglas que el resto del estado en disco: escritura atómica, Zod al
 * leer, y un fichero ilegible, inválido o de un Stratum más nuevo no se
 * reescribe nunca (y no activa nada: falla cerrado).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { CONNECTOR_ID_RE } from './manifest.js';

export const CONNECTORS_SCHEMA_VERSION = 1;
export const CONNECTORS_FILE = 'connectors.json';

export function connectorsFile(companionDir: string): string {
  return join(companionDir, CONNECTORS_FILE);
}

export interface EnabledConnector {
  id: string;
  /** ISO 8601. */
  enabledAt: string;
}

export type ConnectorsFileState =
  | { state: 'ok'; enabled: EnabledConnector[] }
  | { state: 'absent' }
  | { state: 'unreadable' | 'invalid'; error: string }
  | { state: 'newer'; schemaVersion: unknown };

const EnabledSchema = z
  .object({ id: z.string().regex(CONNECTOR_ID_RE), enabledAt: z.string().min(1) })
  .passthrough();

const FileSchema = z
  .object({ schemaVersion: z.unknown().optional(), enabled: z.array(EnabledSchema) })
  .passthrough();

/** Lee el fichero sin lanzar. */
export function readConnectorsFile(file: string): ConnectorsFileState {
  if (!existsSync(file)) return { state: 'absent' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    return { state: 'unreadable', error: (err as Error).message };
  }
  const version = checkSchemaVersion(
    (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
    CONNECTORS_SCHEMA_VERSION,
  );
  if (!version.ok) {
    return version.reason === 'newer'
      ? { state: 'newer', schemaVersion: version.version }
      : { state: 'invalid', error: 'schemaVersion is not valid' };
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    return { state: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  // Un id repetido se queda con la primera aparición.
  const seen = new Set<string>();
  const enabled: EnabledConnector[] = [];
  for (const e of parsed.data.enabled) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    enabled.push({ id: e.id, enabledAt: e.enabledAt });
  }
  return { state: 'ok', enabled };
}

/** Ids activos; un fichero que no se puede leer no activa nada. */
export function enabledConnectorIds(file: string): string[] {
  const s = readConnectorsFile(file);
  return s.state === 'ok' ? s.enabled.map((e) => e.id) : [];
}

export class ConnectorsStoreError extends Error {
  override readonly name = 'ConnectorsStoreError';
}

function writable(file: string): EnabledConnector[] {
  const s = readConnectorsFile(file);
  if (s.state === 'ok') return s.enabled;
  if (s.state === 'absent') return [];
  throw new ConnectorsStoreError(
    s.state === 'newer'
      ? `${CONNECTORS_FILE} is from a newer Stratum (schemaVersion ${String(s.schemaVersion)}); it will not be modified.`
      : `${CONNECTORS_FILE} is not valid (${s.error}); it will not be modified.`,
  );
}

function save(file: string, enabled: EnabledConnector[]): void {
  writeFileAtomic(
    file,
    `${JSON.stringify({ schemaVersion: CONNECTORS_SCHEMA_VERSION, enabled }, null, 2)}\n`,
  );
}

/** Activa `id`. Idempotente: devuelve `false` si ya lo estaba. */
export function enableConnector(file: string, id: string, now: Date = new Date()): boolean {
  const enabled = writable(file);
  if (enabled.some((e) => e.id === id)) return false;
  save(file, [...enabled, { id, enabledAt: now.toISOString() }]);
  return true;
}

/** Desactiva `id`. Idempotente: devuelve `false` si no estaba activo. */
export function disableConnector(file: string, id: string): boolean {
  const enabled = writable(file);
  if (!enabled.some((e) => e.id === id)) return false;
  save(
    file,
    enabled.filter((e) => e.id !== id),
  );
  return true;
}

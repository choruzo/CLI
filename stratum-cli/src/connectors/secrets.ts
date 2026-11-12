/**
 * M20, fase 4 — los secretos de los conectores:
 * `~/.stratum/daemon/connector-secrets.json` (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Como `telegram.json` (M18):
 * - Vive en la carpeta **privada** del daemon (`ensurePrivateDir`), a la que las
 *   tools del agente no llegan (`PATH_RULES`), y no en `.stratumrc.json`.
 * - **Solo lo escribe la CLI** (`stratum connectors setup`, por TTY y sin eco;
 *   *decidido por el usuario 2026-11-12*). El daemon solo lo lee al empezar
 *   cada turno y al listar, y del valor nunca dice nada: el protocolo solo sabe
 *   si cada nombre está configurado.
 * - El valor va al conector como variable de entorno del proceso cliente
 *   (`-e NOMBRE` sin valor en la orden: `box/connectors.ts`). Nunca a la config,
 *   los logs, la traza, el protocolo ni la caja del agente.
 * - Escritura atómica (temporal + `rename`, `0600`) y Zod al leer. Uno que no
 *   valida no da ningún secreto (los conectores que los piden no arrancan) y
 *   no se reescribe; uno de un Stratum más nuevo no se toca.
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { ensurePrivateDirSync } from '../daemon/private-dir.js';
import { CONNECTOR_ID_RE, type ConnectorManifest } from './manifest.js';

export const CONNECTOR_SECRETS_FILE = 'connector-secrets.json';
export const CONNECTOR_SECRETS_SCHEMA_VERSION = 1;

/** Mismo formato que los nombres del manifiesto (y que `-e NOMBRE`). */
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Un valor va a una variable de entorno: sin saltos de línea ni NUL. */
const VALUE_RE = /^[^\r\n\0]+$/;
export const MAX_SECRET_LENGTH = 8192;

const valueSchema = z.string().min(1).max(MAX_SECRET_LENGTH).regex(VALUE_RE);

const fileSchema = z
  .object({
    schemaVersion: z.literal(CONNECTOR_SECRETS_SCHEMA_VERSION),
    connectors: z.record(
      z.string().regex(CONNECTOR_ID_RE),
      z.record(z.string().regex(NAME_RE), valueSchema),
    ),
    updatedAt: z.string(),
  })
  .strict();

export type ConnectorSecretsFile = z.infer<typeof fileSchema>;

export type ConnectorSecretsState =
  | { state: 'absent' }
  /** No valida: ningún conector recibe secretos hasta rehacerlo. */
  | { state: 'invalid' }
  /** De un Stratum más nuevo: no se lee ni se toca. */
  | { state: 'newer'; schemaVersion: number }
  | { state: 'ok'; file: ConnectorSecretsFile };

export function connectorSecretsPath(dir: string): string {
  return join(dir, CONNECTOR_SECRETS_FILE);
}

/** Lee el fichero sin lanzar. */
export function readConnectorSecrets(dir: string): ConnectorSecretsState {
  let text: string;
  try {
    text = readFileSync(connectorSecretsPath(dir), 'utf8');
  } catch (err) {
    // Solo «no existe» es ausente; un fichero que está pero no se lee no da nada.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'invalid' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > CONNECTOR_SECRETS_SCHEMA_VERSION) {
    return { state: 'newer', schemaVersion: version };
  }
  const parsed = fileSchema.safeParse(json);
  return parsed.success ? { state: 'ok', file: parsed.data } : { state: 'invalid' };
}

/** ¿Vale `value` como valor de un secreto? `null` si vale; si no, por qué. */
export function secretValueProblem(value: string): string | null {
  if (value.length === 0) return 'it is empty';
  if (value.length > MAX_SECRET_LENGTH) return `it is longer than ${MAX_SECRET_LENGTH} characters`;
  if (!VALUE_RE.test(value)) return 'it cannot contain line breaks';
  return null;
}

/** Qué secretos pide el manifiesto y cuáles tiene; sin ningún valor. */
export interface SecretsStatus {
  /** Nombres que pide y no están (todos, si el fichero no se puede leer). */
  missing: string[];
  /** El fichero no se puede usar: por qué, para avisar. */
  unusable?: 'invalid' | 'newer';
}

export function secretsStatusOf(
  manifest: ConnectorManifest,
  state: ConnectorSecretsState,
): SecretsStatus {
  const names = manifest.secrets.map((s) => s.name);
  if (names.length === 0) return { missing: [] };
  if (state.state === 'invalid' || state.state === 'newer') {
    return { missing: names, unusable: state.state };
  }
  const have = state.state === 'ok' ? (state.file.connectors[manifest.id] ?? {}) : {};
  return { missing: names.filter((n) => have[n] === undefined) };
}

/**
 * Los valores que pide `manifest`, o `null` si falta alguno o el fichero no se
 * puede usar. Solo los nombres del manifiesto: nada más llega al conector.
 */
export function secretValuesFor(
  manifest: ConnectorManifest,
  state: ConnectorSecretsState,
): Record<string, string> | null {
  if (manifest.secrets.length === 0) return {};
  if (state.state !== 'ok') return null;
  const have = state.file.connectors[manifest.id] ?? {};
  const out: Record<string, string> = {};
  for (const { name } of manifest.secrets) {
    const v = have[name];
    if (v === undefined) return null;
    out[name] = v;
  }
  return out;
}

export class ConnectorSecretsError extends Error {
  override readonly name = 'ConnectorSecretsError';
}

function writable(dir: string): ConnectorSecretsFile['connectors'] {
  const s = readConnectorSecrets(dir);
  if (s.state === 'ok') return s.file.connectors;
  if (s.state === 'absent') return {};
  throw new ConnectorSecretsError(
    s.state === 'newer'
      ? `${CONNECTOR_SECRETS_FILE} is from a newer Stratum (schemaVersion ${s.schemaVersion}); it will not be modified.`
      : `${CONNECTOR_SECRETS_FILE} is not valid; it will not be modified. Delete ${connectorSecretsPath(dir)} and set the secrets again.`,
  );
}

function save(dir: string, connectors: ConnectorSecretsFile['connectors'], now: Date): string {
  const valid = fileSchema.parse({
    schemaVersion: CONNECTOR_SECRETS_SCHEMA_VERSION,
    connectors,
    updatedAt: now.toISOString(),
  });
  ensurePrivateDirSync(dir);
  const path = connectorSecretsPath(dir);
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

/**
 * Guarda `values` del conector `id` (se suman a los que ya tenía). Solo admite
 * nombres que pida su manifiesto.
 * @throws ConnectorSecretsError si el fichero no se puede modificar o un valor no vale.
 */
export function setConnectorSecrets(
  dir: string,
  manifest: ConnectorManifest,
  values: Record<string, string>,
  now: Date = new Date(),
): string {
  const allowed = new Set(manifest.secrets.map((s) => s.name));
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name)) {
      throw new ConnectorSecretsError(`Connector "${manifest.id}" does not use "${name}".`);
    }
    const problem = secretValueProblem(value);
    if (problem) throw new ConnectorSecretsError(`The value of ${name} is not valid: ${problem}.`);
  }
  const connectors = { ...writable(dir) };
  connectors[manifest.id] = { ...(connectors[manifest.id] ?? {}), ...values };
  return save(dir, connectors, now);
}

/**
 * Borra los secretos del conector `id` (o solo `name`).
 * @returns `false` si no había nada que borrar.
 */
export function clearConnectorSecrets(
  dir: string,
  id: string,
  name?: string,
  now: Date = new Date(),
): boolean {
  const connectors = { ...writable(dir) };
  const current = connectors[id];
  if (!current) return false;
  if (name === undefined) {
    delete connectors[id];
  } else {
    if (current[name] === undefined) return false;
    const rest = { ...current };
    delete rest[name];
    if (Object.keys(rest).length === 0) delete connectors[id];
    else connectors[id] = rest;
  }
  save(dir, connectors, now);
  return true;
}

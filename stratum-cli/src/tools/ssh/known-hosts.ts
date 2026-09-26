import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { writeFileAtomic } from '../../config/writer.js';
import type { SSHHostConfig } from '../../config/schema.js';
import type { DestructiveDecision } from '../../agent/types.js';
import { expandHome } from '../../config/paths.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('ssh');

export const DEFAULT_KNOWN_HOSTS_PATH = '~/.stratum/known_hosts.json';

/** Entrada de `known_hosts.json` (§12.14). */
export interface KnownHostEntry {
  fingerprint: string; // "SHA256:<base64>"
  algorithm: string; // "ssh-ed25519", "ssh-rsa", ...
  addedAt: string; // ISO 8601
  host: string; // host/IP real, para que el usuario reconozca la entrada
}

/**
 * Fingerprint SHA-256 en el formato de OpenSSH (`SHA256:<base64 sin padding>`),
 * calculado sobre la clave pública en formato wire — el mismo blob que muestra
 * `ssh-keygen -lf`, así que el usuario puede comparar a ojo.
 */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

const KnownHostEntrySchema = z
  .object({
    fingerprint: z.string().regex(/^SHA256:/),
    algorithm: z.string(),
    addedAt: z.string(),
    host: z.string(),
  })
  // Un campo que añada un Stratum más nuevo se conserva al reescribir.
  .passthrough();

const KnownHostsFileSchema = z.record(z.string(), KnownHostEntrySchema);

/**
 * `known_hosts.json` existe pero no se puede interpretar. Nunca se trata como
 * vacío: eso convertiría cada host de confianza en «primera conexión» (el TOFU
 * aceptaría cualquier clave) y la siguiente escritura borraría las huellas.
 */
export class KnownHostsCorruptError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(
      `${path} está dañado (${reason}).
` +
        '  No se verifica ninguna host key contra él ni se modifica: revísalo a mano, ' +
        'o muévelo a otro sitio para volver a confiar en cada host con `stratum ssh trust <alias>`.',
    );
    this.name = 'KnownHostsCorruptError';
    this.path = path;
  }
}

/**
 * Almacén TOFU en `~/.stratum/known_hosts.json`. Formato propio (no el de
 * OpenSSH) para no interferir con el `~/.ssh/known_hosts` del usuario.
 *
 * Falla cerrado: un fichero que existe y no valida lanza
 * `KnownHostsCorruptError` en toda lectura y escritura.
 */
export class KnownHostsStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_KNOWN_HOSTS_PATH) {
    this.path = expandHome(path);
  }

  list(): Record<string, KnownHostEntry> {
    if (!existsSync(this.path)) return {};
    // Un error de E/S también lanza: tampoco dice qué claves hay guardadas.
    const raw = readFileSync(this.path, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new KnownHostsCorruptError(this.path, `JSON inválido: ${(err as Error).message}`);
    }
    const result = KnownHostsFileSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.length ? ` en ${issue.path.join('.')}` : '';
      throw new KnownHostsCorruptError(this.path, `${issue?.message ?? 'forma inválida'}${where}`);
    }
    return result.data as Record<string, KnownHostEntry>;
  }

  read(alias: string): KnownHostEntry | undefined {
    const entries = this.list();
    return Object.hasOwn(entries, alias) ? entries[alias] : undefined;
  }

  private writeAll(entries: Record<string, KnownHostEntry>): void {
    writeFileAtomic(this.path, JSON.stringify(entries, null, 2) + '\n');
  }

  write(alias: string, entry: KnownHostEntry): void {
    const entries = this.list();
    // Validar antes de escribir: una entrada inválida dejaría el fichero
    // ilegible para todas las demás.
    entries[alias] = KnownHostEntrySchema.parse(entry) as KnownHostEntry;
    this.writeAll(entries);
  }

  remove(alias: string): boolean {
    const entries = this.list();
    if (!Object.hasOwn(entries, alias)) return false;
    delete entries[alias];
    this.writeAll(entries);
    return true;
  }
}

/**
 * Error de verificación de host key. `recoverable: false` en el caso de
 * mismatch: no hay override interactivo posible, el agente no debe reintentar.
 */
export class HostKeyError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = 'HostKeyError';
    this.recoverable = recoverable;
  }
}

export interface VerifyHostKeyOptions {
  alias: string;
  host: SSHHostConfig;
  /** Clave pública del servidor en formato wire, tal como la entrega ssh2. */
  key: Buffer;
  /** Algoritmo anunciado por el servidor (`ssh-ed25519`, ...). */
  algorithm: string;
  store: KnownHostsStore;
  /**
   * Gate interactivo para TOFU en la primera conexión. Se cablea al mismo
   * canal que las confirmaciones destructivas (`ToolContext.confirmDestructive`),
   * de modo que sin TTY la respuesta es deny y la conexión aborta.
   */
  confirm?: (description: string) => Promise<DestructiveDecision>;
}

/**
 * Verifica la clave del servidor según `hostKeyPolicy` (§12.14). Resuelve si la
 * conexión puede continuar; lanza `HostKeyError` si debe abortarse.
 */
export async function verifyHostKey(opts: VerifyHostKeyOptions): Promise<void> {
  const { alias, host, key, algorithm, store, confirm } = opts;
  const fingerprint = fingerprintOf(key);

  if (host.hostKeyPolicy === 'insecure') {
    log.warn('host key verification disabled', { alias, host: host.host, fingerprint });
    return;
  }

  if (host.hostKeyPolicy === 'strict') {
    // El schema ya garantiza que hostKeyHash existe con esta política.
    if (host.hostKeyHash !== fingerprint) {
      throw new HostKeyError(
        `HOST KEY MISMATCH for '${alias}' (${host.host}).\n` +
          `  Pinned:   ${host.hostKeyHash ?? '(sin hostKeyHash)'}\n` +
          `  Received: ${fingerprint} (${algorithm})\n` +
          `  hostKeyPolicy is 'strict': update ssh.hosts.${alias}.hostKeyHash in ` +
          '.stratumrc.json only if you trust the new key.',
        false,
      );
    }
    return;
  }

  // --- TOFU ---
  let known: KnownHostEntry | undefined;
  try {
    known = store.read(alias);
  } catch (err) {
    // Sin poder leer las claves guardadas no hay forma de distinguir un host
    // nuevo de un MITM: se aborta sin preguntar, como ante un mismatch.
    const reason = err instanceof Error ? err.message : String(err);
    throw new HostKeyError(`No se puede verificar la host key de '${alias}': ${reason}`, false);
  }

  if (known) {
    if (known.fingerprint === fingerprint) return;
    throw new HostKeyError(
      `HOST KEY MISMATCH for '${alias}' (${host.host}).\n` +
        `  Stored:   ${known.fingerprint} (${known.algorithm})\n` +
        `  Received: ${fingerprint} (${algorithm})\n` +
        '  This may indicate a MITM attack or the host was reinstalled.\n' +
        `  To update the key: stratum ssh trust ${alias} --force`,
      false,
    );
  }

  const description =
    `Host SSH nuevo: ${alias} (${host.host})\n` +
    `   Fingerprint: ${fingerprint} (${algorithm})\n` +
    '   ¿Confiar y añadir a known_hosts?';

  // Sin gate disponible (CI, salida a pipe, contexto sin TTY) se aborta: nunca
  // se confía en un host nuevo sin una decisión humana explícita.
  const decision = confirm ? await confirm(description).catch(() => 'deny' as const) : 'deny';

  // `allow-all` significa aquí "aprobar este host", nunca "confiar en todos los
  // hosts futuros": confiar en un fingerprint no puede extenderse al siguiente.
  if (decision !== 'approve' && decision !== 'allow-all') {
    throw new HostKeyError(
      `Host key de '${alias}' (${host.host}) no confiada.\n` +
        `  Fingerprint: ${fingerprint} (${algorithm})\n` +
        `  Para confiar en ella: stratum ssh trust ${alias}`,
      false,
    );
  }

  store.write(alias, {
    fingerprint,
    algorithm,
    addedAt: new Date().toISOString(),
    host: host.host,
  });
  log.info('host key trusted', { alias, host: host.host, fingerprint });
}

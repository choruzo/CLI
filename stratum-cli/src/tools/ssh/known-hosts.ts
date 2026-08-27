import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';
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

/**
 * Almacén TOFU en `~/.stratum/known_hosts.json`. Formato propio (no el de
 * OpenSSH) para no interferir con el `~/.ssh/known_hosts` del usuario.
 */
export class KnownHostsStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_KNOWN_HOSTS_PATH) {
    this.path = expandHome(path);
  }

  list(): Record<string, KnownHostEntry> {
    try {
      if (!existsSync(this.path)) return {};
      return JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, KnownHostEntry>;
    } catch (err) {
      log.warn('known_hosts read failed', { path: this.path, err });
      return {};
    }
  }

  read(alias: string): KnownHostEntry | undefined {
    return this.list()[alias];
  }

  /** Escritura atómica (tmp + rename), mismo patrón que `decisions.ts`. */
  private writeAll(entries: Record<string, KnownHostEntry>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.path);
  }

  write(alias: string, entry: KnownHostEntry): void {
    const entries = this.list();
    entries[alias] = entry;
    this.writeAll(entries);
  }

  remove(alias: string): boolean {
    const entries = this.list();
    if (!(alias in entries)) return false;
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
  const known = store.read(alias);

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

import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import type { StratumConfig, SSHHostConfig } from '../../config/schema.js';
import type { DestructiveDecision } from '../../agent/types.js';
import { buildConnectConfig, resolveHost } from './inventory.js';
import { KnownHostsStore, verifyHostKey, HostKeyError } from './known-hosts.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('ssh');

/** Backoff de reconexión para conexiones ya establecidas que se caen (§12.14). */
const RECONNECT_DELAYS_MS = [2000, 4000, 8000];
/** Margen por conexión al cerrar el pool. */
const CLOSE_TIMEOUT_MS = 2000;

export type ConfirmFn = (description: string) => Promise<DestructiveDecision>;

/**
 * Pool de conexiones SSH persistentes por alias (§12.14).
 *
 * Invariantes:
 *  - Apertura **lazy**: nada se conecta al arrancar Stratum, solo al primer uso.
 *  - `inflight` es el mutex de establecimiento: dos tool calls paralelas al
 *    mismo alias comparten una única promesa de conexión, no dos sockets
 *    (necesario porque `exec` sobre targets ssh no se serializa).
 *  - El `hostVerifier` se monta **siempre**, también sobre los jump hosts.
 */
export class SSHConnectionPool {
  private readonly connections = new Map<string, Client>();
  private readonly inflight = new Map<string, Promise<Client>>();
  /** Aliases que ya llegaron a estar establecidos: habilita el backoff. */
  private readonly established = new Set<string>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly knownHosts: KnownHostsStore;
  private closing = false;

  constructor(
    private readonly config: StratumConfig,
    knownHosts?: KnownHostsStore,
  ) {
    this.knownHosts = knownHosts ?? new KnownHostsStore();
  }

  host(alias: string): SSHHostConfig {
    return resolveHost(this.config, alias);
  }

  /** Aliases con conexión viva ahora mismo. */
  activeAliases(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Devuelve una conexión activa, se une a la que esté en vuelo, o abre una
   * nueva. `confirm` solo se usa en la primera conexión a un host sin entrada
   * en known_hosts (gate TOFU).
   */
  async getConnection(alias: string, confirm?: ConfirmFn): Promise<Client> {
    const existing = this.connections.get(alias);
    if (existing) return existing;

    const pending = this.inflight.get(alias);
    if (pending) return pending;

    const promise = this.openConnection(alias, confirm)
      .then((client) => {
        this.connections.set(alias, client);
        this.inflight.delete(alias);
        this.established.add(alias);
        return client;
      })
      .catch((err: unknown) => {
        this.inflight.delete(alias);
        throw err;
      });

    this.inflight.set(alias, promise);
    return promise;
  }

  private async openConnection(alias: string, confirm?: ConfirmFn): Promise<Client> {
    const host = this.host(alias);
    const cfg: ConnectConfig = await buildConnectConfig(host, alias);

    // Jump host: túnel TCP dentro de la conexión al bastión. La profundidad
    // máxima (2) y la ausencia de ciclos están validadas por el schema, así que
    // la recursión aquí no puede colgarse.
    if (host.jumpHost) {
      const bastion = await this.getConnection(host.jumpHost, confirm);
      cfg.sock = await forwardOut(bastion, host.host, host.port, host.jumpHost, alias);
      // Con `sock`, ssh2 ignora host/port: el destino ya es el otro extremo del túnel.
    }

    // La verificación de host key se monta aquí y no en `buildConnectConfig`
    // para que ninguna ruta de conexión pueda saltársela.
    cfg.hostVerifier = ((key: Buffer, cb: (ok: boolean) => void) => {
      verifyHostKey({
        alias,
        host,
        key,
        algorithm: detectKeyAlgorithm(key),
        store: this.knownHosts,
        confirm,
      }).then(
        () => cb(true),
        (err: unknown) => {
          hostKeyErrors.set(alias, err instanceof Error ? err : new Error(String(err)));
          cb(false);
        },
      );
    }) as ConnectConfig['hostVerifier'];

    const client = new Client();

    return new Promise<Client>((resolve, reject) => {
      let settled = false;

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        log.info('ssh connected', { alias, host: host.host, port: host.port });
        this.attachLifecycle(alias, client);
        resolve(client);
      };

      // Listener de error PERMANENTE, montado antes de conectar. ssh2 emite
      // 'error' de forma asíncrona incluso después de que la promesa se haya
      // resuelto o rechazado (p. ej. "Connection lost before handshake" tras un
      // destroy), y un 'error' sin listener en un EventEmitter tumba el proceso.
      const onError = (err: Error): void => {
        if (settled) {
          log.debug('ssh late error', { alias, err });
          return;
        }
        settled = true;
        client.removeListener('ready', onReady);
        // Si el fallo viene de la verificación de host key, el error real es el
        // de `verifyHostKey`, mucho más informativo que "handshake failed".
        const hostKeyErr = hostKeyErrors.get(alias);
        hostKeyErrors.delete(alias);
        const finalErr = hostKeyErr ?? err;
        log.warn('ssh connect failed', { alias, host: host.host, err: finalErr });
        try {
          client.destroy();
        } catch {
          /* ya destruido */
        }
        reject(finalErr);
      };

      client.on('error', onError);
      client.once('ready', onReady);

      try {
        client.connect(cfg);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Desalojo y reconexión de una conexión ya establecida. §12.14 distingue los
   * dos escenarios: la **primera** apertura que falla no tiene backoff (falla
   * de inmediato y el agente decide); una conexión que se cae **después** se
   * reintenta en background con 2s → 4s → 8s.
   */
  private attachLifecycle(alias: string, client: Client): void {
    const onGone = (): void => {
      if (this.connections.get(alias) !== client) return;
      this.connections.delete(alias);
      if (this.closing) return;
      log.warn('ssh connection lost', { alias });
      this.scheduleReconnect(alias, 0);
    };
    client.on('close', onGone);
    client.on('end', onGone);
    // Los errores posteriores los absorbe el listener permanente montado en
    // `openConnection`, que ya distingue "antes" de "después" de resolverse.
  }

  private scheduleReconnect(alias: string, attempt: number): void {
    if (this.closing || attempt >= RECONNECT_DELAYS_MS.length) {
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        log.warn('ssh reconnect exhausted', { alias, attempts: attempt });
      }
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt]!;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(alias);
      if (this.closing || this.connections.has(alias) || this.inflight.has(alias)) return;
      log.info('ssh reconnecting', { alias, attempt: attempt + 1, delay });
      // Sin `confirm`: una reconexión en background no puede abrir un prompt.
      // El host ya está en known_hosts (llegó a estar establecido), así que TOFU
      // no vuelve a preguntar; un mismatch aborta como debe.
      void this.getConnection(alias).catch(() => this.scheduleReconnect(alias, attempt + 1));
    }, delay);
    // No mantener vivo el event loop por un reintento en background.
    timer.unref?.();
    this.reconnectTimers.set(alias, timer);
  }

  /**
   * Cierra todas las conexiones. Orden inverso al de apertura: primero las
   * **hojas** (las que dependen de un bastión) y después los bastiones —
   * cerrar un bastión antes rompe los streams que lo atraviesan.
   */
  async closeAll(): Promise<void> {
    this.closing = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();

    const aliases = Array.from(this.connections.keys());
    const isBastion = new Set<string>();
    for (const alias of aliases) {
      const jump = this.config.ssh?.hosts[alias]?.jumpHost;
      if (jump) isBastion.add(jump);
    }
    const leaves = aliases.filter((a) => !isBastion.has(a));
    const bastions = aliases.filter((a) => isBastion.has(a));

    for (const group of [leaves, bastions]) {
      await Promise.all(group.map((alias) => this.closeOne(alias)));
    }

    this.connections.clear();
    this.inflight.clear();
    this.established.clear();
    this.closing = false;
  }

  private closeOne(alias: string): Promise<void> {
    const client = this.connections.get(alias);
    this.connections.delete(alias);
    if (!client) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn('ssh close timeout, destroying', { alias });
        try {
          client.destroy();
        } catch {
          /* ignorar */
        }
        resolve();
      }, CLOSE_TIMEOUT_MS);
      timer.unref?.();
      client.once('close', done);
      try {
        client.end();
      } catch {
        done();
      }
    });
  }
}

/**
 * Errores de verificación de host key indexados por alias. ssh2 solo permite
 * responder `false` desde el `hostVerifier`, perdiendo la causa; este mapa la
 * recupera para que el `tool_error` diga MISMATCH en vez de "handshake failed".
 */
const hostKeyErrors = new Map<string, Error>();

export { HostKeyError };

/** `forwardOut` promisificado, con un mensaje de error que nombra la cadena. */
function forwardOut(
  bastion: Client,
  targetHost: string,
  targetPort: number,
  bastionAlias: string,
  targetAlias: string,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    bastion.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
      if (err) {
        reject(
          new Error(
            `No se pudo abrir el túnel de "${bastionAlias}" a "${targetAlias}" ` +
              `(${targetHost}:${targetPort}): ${err.message}`,
          ),
        );
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Nombre del algoritmo de la clave pública. El formato wire de SSH empieza por
 * una cadena de longitud prefijada con su propio nombre (`ssh-ed25519`,
 * `ssh-rsa`, `ecdsa-sha2-nistp256`, ...).
 */
export function detectKeyAlgorithm(key: Buffer): string {
  try {
    if (key.length < 4) return 'unknown';
    const len = key.readUInt32BE(0);
    if (len === 0 || len > 64 || key.length < 4 + len) return 'unknown';
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

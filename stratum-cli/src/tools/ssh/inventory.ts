import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { ConnectConfig } from 'ssh2';
import type { StratumConfig, SSHHostConfig } from '../../config/schema.js';
import { expandHome } from '../../config/paths.js';

/**
 * Inventario SSH (§12.14): traduce un alias de `.stratumrc.json` → `ssh.hosts`
 * a la `ConnectConfig` de ssh2, resolviendo secretos y el socket del agente.
 *
 * El `hostVerifier` NO se monta aquí: lo añade el pool (`pool.ts`), para que
 * ninguna ruta de conexión pueda saltarse la verificación de host key.
 */

/** Nombre de la variable de entorno de fallback para el secreto de un alias. */
export function secretEnvVar(alias: string): string {
  return `STRATUM_SSH_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SECRET`;
}

/**
 * Resuelve un host del inventario. El mensaje de error se inyecta tal cual en
 * el `tool_error` recuperable, así que lista los alias disponibles para que el
 * modelo pueda reorientarse sin adivinar.
 */
export function resolveHost(config: StratumConfig, alias: string): SSHHostConfig {
  const hosts = config.ssh?.hosts ?? {};
  const host = hosts[alias];
  if (!host) {
    const available = Object.keys(hosts);
    const list = available.length > 0 ? available.join(', ') : '(inventario vacío)';
    throw new Error(
      `Host SSH "${alias}" no está en el inventario. Hosts disponibles: ${list}. ` +
        'Los hosts se definen en .stratumrc.json bajo la clave "ssh.hosts".',
    );
  }
  return host;
}

/**
 * Resuelve un secreto (password o passphrase) según su prefijo (§12.14):
 *   `env:<VAR>`  → process.env[VAR]
 *   `keychain:…` → no soportado en esta versión (ver nota abajo)
 *   otro         → valor literal
 *
 * En todos los casos, si el secreto no puede resolverse se prueba antes la
 * variable de fallback `STRATUM_SSH_<ALIAS>_SECRET`.
 *
 * Nota de desviación respecto a §12.14: el prefijo `keychain:<alias>` (keytar)
 * no está implementado — keytar es una dependencia nativa sin mantenimiento
 * activo y su coste de instalación no compensa frente a `env:`. El error
 * explica la alternativa en vez de fallar en silencio.
 */
export function resolveSecret(spec: string, alias: string): string {
  const fallback = (): string | undefined => process.env[secretEnvVar(alias)];

  if (spec.startsWith('env:')) {
    const varName = spec.slice('env:'.length);
    const value = process.env[varName] ?? fallback();
    if (value === undefined) {
      throw new Error(
        `El secreto del host "${alias}" apunta a la variable de entorno ${varName}, que no está definida. ` +
          `Defínela, o define ${secretEnvVar(alias)}.`,
      );
    }
    return value;
  }

  if (spec.startsWith('keychain:')) {
    const value = fallback();
    if (value !== undefined) return value;
    throw new Error(
      `El host "${alias}" usa el prefijo "keychain:", no soportado en esta versión de Stratum. ` +
        `Usa "env:<VARIABLE>" en la config, o define ${secretEnvVar(alias)} en el entorno.`,
    );
  }

  return spec;
}

/**
 * Socket del ssh-agent del sistema (§12.14). En Windows se prueba primero el
 * named pipe de OpenSSH y se cae a Pageant (PuTTY).
 */
export function resolveAgentSocket(): string {
  if (process.platform === 'win32') {
    const opensshPipe = '\\\\.\\pipe\\openssh-ssh-agent';
    return existsSync(opensshPipe) ? opensshPipe : 'pageant';
  }
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock) {
    throw new Error(
      'useAgent: true requiere SSH_AUTH_SOCK definido en el entorno. ' +
        'Ejecuta eval $(ssh-agent) o conecta un agente SSH.',
    );
  }
  return sock;
}

/**
 * Construye la `ConnectConfig` de ssh2 para un host. `sock` (jump host) y
 * `hostVerifier` los añade el pool.
 */
export async function buildConnectConfig(
  host: SSHHostConfig,
  alias: string,
): Promise<ConnectConfig> {
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.user,
    readyTimeout: host.connectTimeout,
  };

  if (host.privateKey) {
    const keyPath = expandHome(host.privateKey);
    try {
      cfg.privateKey = await readFile(keyPath);
    } catch (err) {
      throw new Error(
        `No se pudo leer la clave privada de "${alias}" en ${keyPath}: ${(err as Error).message}`,
      );
    }
    if (host.passphrase) cfg.passphrase = resolveSecret(host.passphrase, alias);
  }

  if (host.useAgent) cfg.agent = resolveAgentSocket();

  if (host.password) cfg.password = resolveSecret(host.password, alias);

  return cfg;
}

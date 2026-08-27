import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig } from '../../config/loader.js';
import type { StratumConfig, SSHHostConfig } from '../../config/schema.js';
import { SSHConnectionPool } from '../../tools/ssh/pool.js';
import { KnownHostsStore } from '../../tools/ssh/known-hosts.js';

/**
 * `stratum ssh` (Hito 9, §12.14). Plain text sin UI Ink, igual que
 * `stratum init` — sirve para inspeccionar el inventario y gestionar las host
 * keys antes de que el agente toque nada.
 */

function requireConfig(): StratumConfig {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${String(err)}\n`);
    process.exit(1);
  }
}

function requireHosts(config: StratumConfig): Record<string, SSHHostConfig> {
  const hosts = config.ssh?.hosts;
  if (!hosts || Object.keys(hosts).length === 0) {
    process.stdout.write('No hay hosts SSH configurados en .stratumrc.json.\n');
    process.stdout.write(
      'Añade hosts bajo la clave "ssh.hosts". Ejemplo:\n' +
        '  "ssh": { "hosts": { "dev": { "host": "10.0.0.5", "user": "javi", "privateKey": "~/.ssh/id_ed25519" } } }\n',
    );
    process.exit(0);
  }
  return hosts;
}

/** Pregunta sí/no por readline. Sin TTY devuelve false (nunca confía a ciegas). */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^(s|si|sí|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const sshList = new Command('list')
  .description('List SSH hosts from the inventory with live connectivity status')
  .action(async () => {
    const config = requireConfig();
    const hosts = requireHosts(config);
    const knownHosts = new KnownHostsStore();
    const trusted = knownHosts.list();
    const pool = new SSHConnectionPool(config, knownHosts);

    const aliases = Object.keys(hosts);
    // En paralelo: cada host está acotado por su propio connectTimeout, así que
    // un host muerto no retrasa al resto.
    const results = await Promise.all(
      aliases.map(async (alias) => {
        const started = Date.now();
        try {
          await pool.getConnection(alias);
          return { alias, ok: true, ms: Date.now() - started, error: '' };
        } catch (err) {
          return { alias, ok: false, ms: Date.now() - started, error: (err as Error).message };
        }
      }),
    );

    const connected = results.filter((r) => r.ok).length;
    process.stdout.write(
      `SSH hosts: ${connected} connected, ${results.length - connected} unreachable\n\n`,
    );

    const width = Math.max(...aliases.map((a) => a.length));
    for (const result of results) {
      const host = hosts[result.alias]!;
      const target = `${host.user}@${host.host}:${host.port}`;
      const icon = result.ok ? '●' : '○';
      const status = result.ok
        ? `[connected, ${result.ms}ms]`
        : `[error: ${result.error.split('\n')[0]}]`;
      const via = host.jumpHost ? ` (via ${host.jumpHost})` : '';
      process.stdout.write(
        `${icon} ${result.alias.padEnd(width)}  ${target.padEnd(32)} ${status}${via}\n`,
      );
      // El aviso solo tiene sentido si la conexión llegó a ver la host key. Un
      // ECONNREFUSED no dice nada sobre si la clave es de fiar.
      const sawHostKey = result.ok || /host key/i.test(result.error);
      if (host.hostKeyPolicy === 'tofu' && !trusted[result.alias] && sawHostKey) {
        process.stdout.write(
          `  ${' '.repeat(width)}  (host key sin confiar — usa: stratum ssh trust ${result.alias})\n`,
        );
      }
    }

    await pool.closeAll();
  });

const sshTrust = new Command('trust')
  .description('Show and store the host key fingerprint of an inventory host')
  .argument('<alias>', 'Host alias from ssh.hosts')
  .option('--force', 'Replace the stored key (use after reinstalling the host)')
  .option('--remove', 'Delete the stored key for this alias')
  .action(async (alias: string, opts: { force?: boolean; remove?: boolean }) => {
    const config = requireConfig();
    const hosts = requireHosts(config);
    const host = hosts[alias];
    if (!host) {
      process.stderr.write(
        `El host "${alias}" no está en el inventario. Disponibles: ${Object.keys(hosts).join(', ')}\n`,
      );
      process.exit(1);
    }

    const store = new KnownHostsStore();

    if (opts.remove) {
      const removed = store.remove(alias);
      process.stdout.write(
        removed
          ? `Entrada de "${alias}" eliminada de known_hosts.\n`
          : `"${alias}" no tenía entrada en known_hosts.\n`,
      );
      return;
    }

    // Para descubrir el fingerprint hay que conectar. Con --force se descarta
    // primero la entrada previa; si no, una entrada que no coincide aborta como
    // debe (un mismatch nunca se resuelve preguntando).
    if (opts.force) store.remove(alias);

    const pool = new SSHConnectionPool(config, store);
    try {
      await pool.getConnection(alias, async (description) => {
        process.stderr.write(`\n⚠  ${description}\n`);
        return (await askYesNo('   ¿Confiar y añadir a known_hosts? (s/N) ')) ? 'approve' : 'deny';
      });
      const entry = store.read(alias);
      if (entry) {
        process.stdout.write(
          `\n✓ ${alias} (${entry.host})\n` +
            `  Fingerprint: ${entry.fingerprint} (${entry.algorithm})\n` +
            `  Confiada el: ${entry.addedAt}\n`,
        );
      } else {
        // hostKeyPolicy strict/insecure: la conexión funcionó sin pasar por TOFU.
        process.stdout.write(
          `\n✓ Conexión con "${alias}" establecida (hostKeyPolicy: ${host.hostKeyPolicy}).\n` +
            '  Esta política no usa known_hosts, así que no hay entrada que guardar.\n',
        );
      }
    } catch (err) {
      process.stderr.write(`\n✗ ${(err as Error).message}\n`);
      await pool.closeAll();
      process.exit(1);
    }
    await pool.closeAll();
  });

export const sshCommand = new Command('ssh')
  .description('Manage the SSH host inventory and their host keys')
  .addCommand(sshList)
  .addCommand(sshTrust);

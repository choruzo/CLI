/**
 * Hosts SSH simulados para los escenarios: el `ssh2.Server` en proceso que ya
 * usan los tests (`tools/ssh/test-server.ts`), con un intérprete de comandos
 * declarativo. El protocolo es el real (handshake, auth, host key, exec); lo
 * simulado es lo que hay al otro lado.
 */
import { startTestServer, type TestServer } from '../tools/ssh/test-server.js';
import type { Scenario } from './scenario.js';

type SshSetup = NonNullable<Scenario['setup']['ssh']>;

const PASSWORD = 'stratum-eval';

export interface SshFixture {
  /** Sección `ssh.hosts` para el `.stratumrc.json` del escenario. */
  hosts: Record<string, Record<string, unknown>>;
  /** Comandos recibidos por cada host, en orden. */
  received(): Record<string, string[]>;
  close(): Promise<void>;
}

export async function startSshFixture(setup: SshSetup): Promise<SshFixture> {
  const servers: TestServer[] = [];
  const hosts: Record<string, Record<string, unknown>> = {};
  const received: Record<string, string[]> = {};

  for (const [alias, host] of Object.entries(setup.hosts)) {
    const rules = host.commands.map((r) => ({ ...r, re: new RegExp(r.match) }));
    const log: string[] = (received[alias] = []);
    const server = await startTestServer({
      password: PASSWORD,
      sftp: false,
      onExec: ({ command, stream }) => {
        log.push(command);
        const rule = rules.find((r) => r.re.test(command));
        if (!rule) {
          stream.stderr.write(`sh: 1: ${command.split(/\s+/)[0] ?? command}: not found\n`);
          stream.exit(127);
          stream.end();
          return;
        }
        if (rule.stdout) stream.write(rule.stdout);
        if (rule.stderr) stream.stderr.write(rule.stderr);
        stream.exit(rule.exitCode);
        stream.end();
      },
    });
    servers.push(server);
    hosts[alias] = {
      host: '127.0.0.1',
      port: server.port,
      user: 'eval',
      password: PASSWORD,
      // La host key es nueva en cada ejecución: se fija su huella en vez de
      // desactivar la verificación.
      hostKeyPolicy: 'strict',
      hostKeyHash: server.fingerprint,
      confirmAll: host.confirmAll,
    };
  }

  return {
    hosts,
    received: () => received,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

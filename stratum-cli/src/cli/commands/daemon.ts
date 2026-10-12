import { Command } from 'commander';
import { execa } from 'execa';
import { homedir } from 'os';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery, type DiscoveryResult } from '../../client/discovery.js';
import { loadConfig } from '../../config/loader.js';
import { DaemonAlreadyRunningError, probeIpc } from '../../daemon/endpoint.js';
import { Stratumd } from '../../daemon/daemon.js';
import { ProtocolError } from '../../ipc/codec.js';
import { UnknownOutcomeError } from '../../ipc/peer.js';
import { configureLogging, flushLogging, isLogLevel, type LogLevel } from '../../logging/index.js';
import type { Role } from '../../protocol/index.js';
import { cliVersion } from '../version.js';

/**
 * `stratum daemon`: el plano de control local (`stratumd`). `run` lo ejecuta en
 * primer plano; `start` lo lanza desligado de la terminal; `stop` y `status`
 * hablan con el que haya por el Stratum Protocol, como cualquier otro cliente.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ¿Hay un daemon publicado **y** escuchando? */
async function locateLive(): Promise<DiscoveryResult> {
  const found = await fileDiscovery().locate();
  if (found.status === 'found' && !(await probeIpc(found.endpoint.ipcPath))) {
    // El pid existe (o se reutilizó), pero nadie atiende: es un endpoint rancio.
    return { status: 'stale', pid: found.endpoint.pid };
  }
  return found;
}

async function connect(roles: Role[]): Promise<StratumClient> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum-cli', version: cliVersion(), roles },
    reconnect: false,
    requestTimeoutMs: 10_000,
  });
  await client.connect();
  return client;
}

function describe(found: DiscoveryResult): string {
  switch (found.status) {
    case 'absent':
      return 'not running';
    case 'stale':
      return `not running (stale endpoint left by pid ${found.pid})`;
    case 'invalid':
      return `endpoint cannot be read (${found.reason})`;
    case 'incompatible':
      return `running a different protocol version (v${found.protocol}, Stratum ${found.version})`;
    case 'found':
      return `running (pid ${found.endpoint.pid})`;
  }
}

const run = new Command('run')
  .description('Run the daemon in the foreground')
  .option('--log-level <level>', 'log level: trace|debug|info|warn|error|silent')
  .option('--debug', 'enable verbose debug logging (level debug + file sink)')
  .action(async (opts: { logLevel?: string; debug?: boolean }) => {
    if (opts.logLevel && !isLogLevel(opts.logLevel)) {
      process.stderr.write(`[fatal] Invalid --log-level: ${opts.logLevel}\n`);
      process.exitCode = 1;
      return;
    }
    // El daemon no pertenece a ningún proyecto: solo lee la config global. La de
    // cada sesión se carga desde su `cwd` al abrirla.
    const config = loadConfig(homedir());
    configureLogging(config, {
      level: (opts.logLevel as LogLevel | undefined) ?? 'info',
      debug: opts.debug,
    });

    let daemon: Stratumd;
    try {
      daemon = await Stratumd.start({
        version: cliVersion(),
        config,
        // Copia del entorno al arrancar: es el que verán las sesiones del daemon.
        env: { ...process.env },
      });
    } catch (err) {
      await flushLogging();
      process.stderr.write(
        err instanceof DaemonAlreadyRunningError
          ? `stratumd is already running (pid ${err.pid}).\n`
          : `[fatal] Cannot start stratumd: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`stratumd listening (pid ${process.pid})\n`);

    const stop = (): void => void daemon.shutdown('signal');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);

    const reason = await daemon.closed;
    process.stderr.write(`stratumd stopped (${reason})\n`);
    await flushLogging();
    // Con todo cerrado no debería quedar nada vivo; si queda, no retiene el proceso.
    process.exit(0);
  });

const start = new Command('start')
  .description('Start the daemon in the background')
  .action(async () => {
    const before = await locateLive();
    if (before.status === 'found') {
      process.stdout.write(`stratumd is already running (pid ${before.endpoint.pid}).\n`);
      return;
    }
    if (before.status === 'incompatible') {
      process.stderr.write(`stratumd is ${describe(before)}; stop it first.\n`);
      process.exitCode = 1;
      return;
    }
    // Desligado de esta terminal: sobrevive a quien lo arranca.
    const child = execa(
      process.execPath,
      [...process.execArgv, process.argv[1] ?? '', 'daemon', 'run'],
      { detached: true, stdio: 'ignore', cleanup: false, windowsHide: true, reject: false },
    );
    child.unref();
    void child.catch(() => undefined);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(150);
      const now = await locateLive();
      if (now.status === 'found') {
        process.stdout.write(`stratumd started (pid ${now.endpoint.pid}).\n`);
        return;
      }
    }
    process.stderr.write('stratumd did not come up. Try `stratum daemon run` to see why.\n');
    process.exitCode = 1;
  });

const stop = new Command('stop')
  .description('Stop the daemon')
  .option('--force', 'stop even with runs in progress')
  .action(async (opts: { force?: boolean }) => {
    const found = await locateLive();
    if (found.status !== 'found') {
      process.stdout.write(`stratumd is ${describe(found)}.\n`);
      return;
    }
    let client: StratumClient;
    try {
      client = await connect(['operator']);
    } catch (err) {
      process.stderr.write(
        `Cannot reach stratumd: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      await client.request('core.shutdown', opts.force ? { force: true } : {});
    } catch (err) {
      // Si corta la conexión antes de contestar, se está apagando: se comprueba abajo.
      if (!(err instanceof UnknownOutcomeError)) {
        process.stderr.write(
          err instanceof ProtocolError && err.code === 'BUSY'
            ? 'There are runs in progress. Use --force to stop anyway.\n'
            : `stratumd refused to stop: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        client.close();
        return;
      }
    }
    client.close();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await locateLive()).status !== 'found') {
        process.stdout.write('stratumd stopped.\n');
        return;
      }
      await sleep(150);
    }
    process.stderr.write('stratumd is still running.\n');
    process.exitCode = 1;
  });

const status = new Command('status')
  .description('Show whether the daemon is running')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const found = await locateLive();
    if (found.status !== 'found') {
      process.stdout.write(
        opts.json
          ? JSON.stringify({ running: false, endpoint: found.status }) + '\n'
          : `stratumd is ${describe(found)}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    let client: StratumClient;
    try {
      client = await connect(['observer']);
    } catch (err) {
      process.stderr.write(
        `Cannot reach stratumd: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      const info = await client.request('core.status', {});
      if (opts.json) {
        // Sin el token ni la ruta del canal: basta con saber que está y cómo va.
        process.stdout.write(
          JSON.stringify({ running: true, pid: found.endpoint.pid, ...info }) + '\n',
        );
        return;
      }
      const upSeconds = Math.max(0, Math.round((Date.now() - info.startedAt) / 1000));
      process.stdout.write(
        `stratumd is running (pid ${found.endpoint.pid}, Stratum ${info.server.version}, protocol v${info.protocol})\n` +
          `  uptime    ${upSeconds}s\n` +
          `  clients   ${info.clients}\n` +
          `  sessions  ${info.liveSessions}\n` +
          `  runs      ${info.activeRuns} active\n`,
      );
    } finally {
      client.close();
    }
  });

export const daemonCommand = new Command('daemon')
  .description('Local control plane (stratumd): run, start, stop, status')
  .addCommand(run)
  .addCommand(start)
  .addCommand(stop)
  .addCommand(status);

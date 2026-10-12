/**
 * Lo que `chat` y `run` necesitan para publicarse en `stratumd`: arrancar el
 * daemon desligado de la terminal y crear el puente de anfitrión par.
 *
 * Publicar es una mejora, nunca una dependencia: nada de aquí lanza, y sin
 * daemon la CLI hace exactamente lo mismo que antes.
 */
import { execa } from 'execa';
import { fileDiscovery, type DiscoveryResult } from '../client/discovery.js';
import type { StratumConfig } from '../config/schema.js';
import { probeIpc } from '../daemon/endpoint.js';
import {
  PeerHostBridge,
  type PeerHostBridgeOptions,
  type PeerHostControl,
} from '../host/peer-host-bridge.js';
import type { PublishedSession } from '../host/session-publisher.js';
import { cliVersion } from './version.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ¿Hay un daemon publicado **y** escuchando? */
export async function locateLiveDaemon(): Promise<DiscoveryResult> {
  const found = await fileDiscovery().locate();
  if (found.status === 'found' && !(await probeIpc(found.endpoint.ipcPath))) {
    // El pid existe (o se reutilizó), pero nadie atiende: es un endpoint rancio.
    return { status: 'stale', pid: found.endpoint.pid };
  }
  return found;
}

/** Lanza `stratum daemon run` desligado de esta terminal: sobrevive a quien lo arranca. */
export function spawnDaemon(): void {
  const child = execa(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? '', 'daemon', 'run'],
    { detached: true, stdio: 'ignore', cleanup: false, windowsHide: true, reject: false },
  );
  child.unref();
  void child.catch(() => undefined);
}

/**
 * Arranca el daemon y espera, como mucho `timeoutMs`, a que atienda.
 *
 * @throws Error si no llega a tiempo.
 */
export async function startDaemonAndWait(timeoutMs: number): Promise<DiscoveryResult> {
  spawnDaemon();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const now = await locateLiveDaemon();
    if (now.status === 'found') return now;
  }
  throw new Error('stratumd did not come up in time');
}

/**
 * El puente de una sesión de la CLI. `daemon.autoStart` decide si, a falta de
 * daemon, se arranca uno; con `false` (default) solo se publica si ya lo hay.
 * `STRATUM_NO_DAEMON=1` desactiva la publicación del todo.
 */
export function createCliBridge(opts: {
  session: PublishedSession;
  control: PeerHostControl;
  /** `stratum run`, `stratum chat`. */
  name: string;
  config: StratumConfig;
  overrides?: Partial<PeerHostBridgeOptions>;
}): PeerHostBridge | null {
  if (process.env['STRATUM_NO_DAEMON'] === '1') return null;
  return new PeerHostBridge({
    session: opts.session,
    control: opts.control,
    name: opts.name,
    version: cliVersion(),
    ...(opts.config.daemon.autoStart
      ? {
          autoStart: async () => {
            await startDaemonAndWait(6_000);
          },
        }
      : {}),
    ...opts.overrides,
  });
}

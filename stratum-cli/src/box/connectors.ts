/**
 * M20 — cómo se lanza un conector: un server MCP stdio cuya orden es
 * `<runtime> exec -i stratum-box-<n>-connectors node /opt/stratum/connectors/<id>/server.mjs`
 * (`docs/PRD_STRATUM_DOT.md` §23.11, *Cómo se lanza*).
 *
 * Solo `src/box/` compone esa orden, con argumentos fijos (`connectorExecArgs`)
 * y el `id` de un manifiesto del catálogo: nunca sale de la config ni del
 * modelo. Antes de cada conexión se comprueba, como `exec`, que la caja de
 * conectores existe, es de Stratum y está en marcha. Si no, el conector no
 * conecta y sus tools no se ofrecen. **Nunca cae al anfitrión ni a la caja
 * del agente.**
 */
import type { BoxConfig, McpServer } from '../config/schema.js';
import type { ConnectorManifest } from '../connectors/manifest.js';
import {
  cachedRuntime,
  defaultRunner,
  type ContainerRuntime,
  type RuntimeDetection,
  type RuntimeRunner,
} from './runtime.js';
import {
  connectorExecArgs,
  connectorsContainerName,
  isNoSuchObject,
  parseInspect,
} from './spec.js';

const CHECK_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 120_000;

/** Un conector listo para el `McpManager`. */
export interface ConnectorLaunch {
  config: McpServer;
  /** Lanza si la caja de conectores no está lista: el conector no se conecta. */
  beforeConnect: () => Promise<void>;
}

export interface ConnectorLaunchDeps {
  detect?: () => Promise<RuntimeDetection>;
  run?: RuntimeRunner;
}

export type ConnectorLaunchResult =
  | { ok: true; launches: ConnectorLaunch[] }
  | { ok: false; reason: string };

/** La caja de conectores no está lista. */
export class ConnectorsBoxUnavailableError extends Error {
  override readonly name = 'ConnectorsBoxUnavailableError';
}

/**
 * Las órdenes de los conectores de `manifests` en la caja de conectores de
 * `box`. Sin runtime de contenedores no hay ninguna.
 */
export async function connectorLaunches(
  box: BoxConfig,
  manifests: readonly ConnectorManifest[],
  deps: ConnectorLaunchDeps = {},
): Promise<ConnectorLaunchResult> {
  if (manifests.length === 0) return { ok: true, launches: [] };
  const run = deps.run ?? defaultRunner;
  const detected = await (deps.detect ?? (() => cachedRuntime(box.runtime)))();
  if (!detected.ok) return { ok: false, reason: detected.reason };
  const rt = detected.runtime;
  const launches = manifests.map((m) => ({
    config: {
      name: m.id,
      command: rt.bin,
      // Fase 4: los secretos irán como `-e NOMBRE` sin valor.
      args: connectorExecArgs(box.name, m.id),
      startupTimeout: STARTUP_TIMEOUT_MS,
      toolTimeout: TOOL_TIMEOUT_MS,
    },
    beforeConnect: () => assertConnectorsBoxRunning(rt, box.name, run),
  }));
  return { ok: true, launches };
}

/** Lanza `ConnectorsBoxUnavailableError` si la caja de conectores no está lista. */
export async function assertConnectorsBoxRunning(
  rt: ContainerRuntime,
  boxName: string,
  run: RuntimeRunner = defaultRunner,
): Promise<void> {
  const container = connectorsContainerName(boxName);
  const r = await run(rt.bin, ['container', 'inspect', container], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new ConnectorsBoxUnavailableError(
      isNoSuchObject(r.stderr)
        ? 'The connectors box does not exist yet. Start the box ("stratum box start", or from Dot).'
        : 'Could not check the connectors box.',
    );
  }
  let found;
  try {
    found = parseInspect(r.stdout);
  } catch {
    throw new ConnectorsBoxUnavailableError('Could not read the state of the connectors box.');
  }
  if (found.role !== 'connectors' || found.connectorsOf !== boxName || found.label !== undefined) {
    throw new ConnectorsBoxUnavailableError(
      `The container "${container}" was not created by Stratum as a connectors box.`,
    );
  }
  if (!found.running) {
    throw new ConnectorsBoxUnavailableError(
      'The connectors box is stopped. Start the box ("stratum box start", or from Dot).',
    );
  }
}

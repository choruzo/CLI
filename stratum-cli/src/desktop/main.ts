import { homedir } from 'os';
import { join } from 'path';
import { configureLogging, closeLogging, getLogger } from '../logging/index.js';
import { loadConfig } from '../config/loader.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import {
  CONFIG_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  SchemaVersionError,
} from '../config/schema-version.js';
import { closeExecRuntime } from '../tools/exec/runtime.js';
import { installResourceLoader, probeNatives } from './natives.js';
import { ShutdownRegistry, type ShutdownReason } from './lifecycle.js';
import { DESKTOP_PROTOCOL_VERSION, type CoreInfo, type SidecarErrorFrame } from './protocol.js';
import { startDesktopServer } from './server.js';
import { ConversationHost } from './conversation-host.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig, desktopDataDir } from './assistant-runtime.js';
import { WorkspaceManager, resolveWorkspaceSettings } from './workspace.js';
import { ProviderRouter } from '../providers/router.js';

/**
 * Arranque del sidecar `stratum-core` de Stratum Desktop (D0).
 *
 * Contrato con el proceso Tauri (`src-tauri/src/sidecar.rs`):
 * - `--ipc-path <ruta>`: named pipe o unix socket que Tauri eligió (15.10). El
 *   sidecar nunca decide el transporte ni lo anuncia por stdout.
 * - `STRATUM_DESKTOP_TOKEN` (entorno): token del handshake (15.1). Por entorno y
 *   no por argumento: la línea de comandos de un proceso la lee cualquier
 *   usuario de la máquina (`ps`, `/proc/<pid>/cmdline`); el entorno, no.
 * - `STRATUM_RESOURCES_DIR` (entorno): resources de Tauri, de donde salen los
 *   módulos nativos (15.2).
 * - `--watch-stdin`: stdin es un pipe con Tauri. Si se cierra, Tauri pidió el
 *   cierre o murió: el sidecar se apaga ordenadamente (15.11).
 *
 * stdout y stderr los redirige Tauri a `logs/sidecar.log`: aquí solo se escribe
 * log, nunca protocolo.
 */

declare const __VERSION__: string;

export const TOKEN_ENV = 'STRATUM_DESKTOP_TOKEN';
export const RESOURCES_ENV = 'STRATUM_RESOURCES_DIR';

/** 32 bytes en hexadecimal: lo que genera Tauri. Por debajo se rechaza. */
const MIN_TOKEN_LENGTH = 64;

export interface SidecarArgs {
  ipcPath: string | null;
  watchStdin: boolean;
  selfTest: boolean;
}

export function parseSidecarArgs(argv: string[]): SidecarArgs {
  const args: SidecarArgs = { ipcPath: null, watchStdin: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ipc-path') args.ipcPath = argv[++i] ?? null;
    else if (a.startsWith('--ipc-path=')) args.ipcPath = a.slice('--ipc-path='.length);
    else if (a === '--watch-stdin') args.watchStdin = true;
    else if (a === '--self-test') args.selfTest = true;
  }
  return args;
}

export function coreInfo(): CoreInfo {
  // `node:sea` solo existe con prefijo y desde Node 20.12; `getBuiltinModule`
  // evita que el bundler reescriba el especificador y funciona en ESM y en CJS.
  const seaMod = process.getBuiltinModule?.('node:sea') as { isSea(): boolean } | undefined;
  const sea = seaMod?.isSea() ?? false;
  return {
    version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev',
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    platform: process.platform,
    node: process.versions.node,
    sea,
  };
}

/**
 * Carga la config compartida con la CLI. No lanza: una config incompatible o
 * inválida se convierte en el `sidecar_error` que verá la UI, y el sidecar
 * sigue con los defaults para poder contestar y explicarlo.
 */
export function loadSharedConfig(startDir: string): {
  config: StratumConfig;
  error: SidecarErrorFrame | null;
} {
  try {
    return { config: loadConfig(startDir), error: null };
  } catch (err) {
    const defaults = StratumConfigSchema.parse({});
    if (err instanceof SchemaVersionError) {
      return {
        config: defaults,
        error: {
          type: 'sidecar_error',
          fatal: true,
          code: 'schema_incompatible',
          message: err.message,
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: defaults,
      error: {
        type: 'sidecar_error',
        fatal: true,
        code: 'config_invalid',
        message: `No se pudo cargar .stratumrc.json: ${message}`,
      },
    };
  }
}

export async function runSidecar(argv: string[]): Promise<number> {
  const args = parseSidecarArgs(argv);
  const resourcesDir = process.env[RESOURCES_ENV];
  if (resourcesDir) installResourceLoader(resourcesDir);

  if (args.selfTest) {
    // Verificación del empaquetado (build y CI): ¿arranca sin Node instalado y
    // cargan los nativos desde los resources?
    const natives = await probeNatives();
    process.stdout.write(JSON.stringify({ core: coreInfo(), natives }, null, 2) + '\n');
    return natives.every((n) => n.ok) ? 0 : 1;
  }

  const token = process.env[TOKEN_ENV] ?? '';
  // Que no lo herede ningún proceso hijo (tools `exec`, servers MCP).
  delete process.env[TOKEN_ENV];
  if (!args.ipcPath || token.length < MIN_TOKEN_LENGTH) {
    process.stderr.write(
      `stratum-core: faltan --ipc-path o ${TOKEN_ENV} (mínimo ${MIN_TOKEN_LENGTH} caracteres). ` +
        'Este binario lo lanza Stratum Desktop; no se ejecuta a mano.\n',
    );
    return 2;
  }

  // El sidecar arranca con cwd = home. El modo Chat no trabaja sobre ninguna
  // carpeta; el cwd de trabajo llega con el modo Code (D8, 15.3).
  const { config, error: startupError } = loadSharedConfig(homedir());
  configureLogging(config, { stderrEnabled: true });
  const log = getLogger('desktop');
  if (startupError)
    log.error('startup config error', { code: startupError.code, msg: startupError.message });

  const shutdown = new ShutdownRegistry();
  shutdown.onShutdown('logging', () => closeLogging());
  shutdown.onShutdown('exec-runtime', () => closeExecRuntime());

  let nativesPromise: ReturnType<typeof probeNatives> | null = null;
  const natives = (): ReturnType<typeof probeNatives> => (nativesPromise ??= probeNatives());
  // Arranca el sondeo ya: así el primer handshake no espera a cargar ONNX.
  void natives();

  // Modo Chat (D1): memoria y sesiones del asistente en ~/.stratum/desktop/.
  const dataDir = desktopDataDir();
  const assistantConfig = buildAssistantConfig(config, dataDir);
  // Workspaces por conversación (D2).
  const { settings: workspaceSettings, warning: workspaceWarning } = resolveWorkspaceSettings(
    config,
    dataDir,
  );
  if (workspaceWarning) log.warn(workspaceWarning);
  const workspaces = new WorkspaceManager(workspaceSettings);
  const conversations = new ConversationHost({
    config: assistantConfig,
    store: new DesktopSessionStore(join(dataDir, 'sessions')),
    makeRouter: () => new ProviderRouter(assistantConfig),
    startupError,
    workspaces,
  });

  let server;
  try {
    server = await startDesktopServer({
      ipcPath: args.ipcPath,
      token,
      core: coreInfo(),
      natives,
      startupError,
      conversations,
      workspaces: {
        root: workspaceSettings.root,
        maxFileBytes: workspaceSettings.maxFileBytes,
        maxWorkspaceBytes: workspaceSettings.maxWorkspaceBytes,
      },
    });
  } catch (err) {
    log.error('listen failed', { err, ipcPath: args.ipcPath });
    await shutdown.run();
    return 3;
  }
  shutdown.onShutdown('ipc-server', () => server.close());
  // Registrado después del servidor para ejecutarse antes (LIFO): los turnos se
  // cancelan y las sesiones se guardan mientras el log sigue abierto.
  shutdown.onShutdown('conversations', () => conversations.closeAll());

  return new Promise<number>((resolve) => {
    const stop = (reason: ShutdownReason, detail?: string): void => {
      if (shutdown.started) return;
      log.info('shutdown', { reason, detail });
      void shutdown.run().then((result) => {
        if (result.failed.length > 0 || result.timedOut) {
          process.stderr.write(`stratum-core: apagado incompleto ${JSON.stringify(result)}\n`);
        }
        resolve(0);
      });
    };

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') signals.push('SIGBREAK');
    for (const sig of signals) process.on(sig, () => stop('signal', sig));

    if (args.watchStdin) {
      process.stdin.on('end', () => stop('parent_gone', 'stdin end'));
      process.stdin.on('close', () => stop('parent_gone', 'stdin close'));
      process.stdin.on('error', () => stop('parent_gone', 'stdin error'));
      process.stdin.resume();
    }
  });
}

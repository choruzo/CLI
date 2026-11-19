/**
 * M22 — la sonda de los vigilantes: abre un conector por **el mismo camino que
 * una sesión** (`box/connectors.ts`: la caja de conectores, sus secretos como
 * `-e NOMBRE` y la comprobación de la caja antes de conectar), llama a sus
 * comprobaciones con los argumentos fijos de cada vigilante y cierra. Una
 * conexión por conector y ciclo.
 *
 * Suspendido (no un fallo) cuando no se puede ni intentar: conector desactivado,
 * fuera del catálogo, sin configurar, sin runtime o sin caja de conectores en
 * marcha. Como en una sesión, **nunca cae al anfitrión ni a la caja del agente**.
 */
import { BoxConfigSchema, type BoxConfig, type McpServer } from '../config/schema.js';
import {
  connectorLaunches,
  ConnectorsBoxUnavailableError,
  type ConnectorLaunchDeps,
} from '../box/connectors.js';
import { defaultEndpointDir } from '../client/discovery.js';
import { McpServerClient } from '../tools/mcp/client.js';
import { bundledCatalog } from '../connectors/active.js';
import type { ConnectorCatalog } from '../connectors/catalog.js';
import { checksOf } from '../connectors/manifest.js';
import {
  parseCheckResult,
  validateCheckArgs,
  type CheckArgValue,
  type CheckOutcome,
} from '../connectors/checks.js';
import { readConnectorSecrets, secretValuesFor } from '../connectors/secrets.js';
import { connectorsFile, readConnectorsFile } from '../connectors/store.js';

const CALL_TIMEOUT_MS = 30_000;

export interface ProbeCall {
  tool: string;
  args: Record<string, CheckArgValue>;
}

export type ProbeOutcome =
  | { kind: 'suspended'; reason: string }
  /** Un resultado por llamada, en el mismo orden. */
  | { kind: 'ran'; outcomes: CheckOutcome[] };

export interface WatchProbe {
  /** Nunca lanza por un fallo de una comprobación; puede lanzar si no se pudo conectar. */
  run(connector: string, calls: readonly ProbeCall[], signal?: AbortSignal): Promise<ProbeOutcome>;
}

/** Lo mínimo del cliente MCP, para poder sustituirlo en un test. */
export interface ProbeClient {
  connect(): Promise<void>;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectorProbeOptions {
  /** Datos del `companion` (`connectors.json`). */
  dataDir: string;
  box: BoxConfig | undefined;
  /** Carpeta privada del daemon (`connector-secrets.json`). */
  secretsDir?: string;
  catalog?: ConnectorCatalog;
  launch?: ConnectorLaunchDeps;
  callTimeoutMs?: number;
  /** Por defecto, `McpServerClient` con la comprobación de la caja antes de conectar. */
  client?: (config: McpServer, beforeConnect: () => Promise<void>) => ProbeClient;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function connectorProbe(opts: ConnectorProbeOptions): WatchProbe {
  const newClient =
    opts.client ??
    ((config, beforeConnect) =>
      new McpServerClient(
        config,
        { installDir: '~/.stratum/mcp', autoInstall: false },
        undefined,
        beforeConnect,
      ));

  return {
    async run(connector, calls, signal) {
      const state = readConnectorsFile(connectorsFile(opts.dataDir));
      if (state.state !== 'ok' || !state.enabled.some((e) => e.id === connector)) {
        // Falla cerrado, como una sesión: un `connectors.json` que no se entiende no activa nada.
        return { kind: 'suspended', reason: `the connector "${connector}" is not enabled` };
      }
      const entry = (opts.catalog ?? bundledCatalog()).get(connector);
      if (!entry) {
        return { kind: 'suspended', reason: `the connector "${connector}" is not in this Stratum` };
      }
      const { manifest } = entry;
      const declared = new Map(checksOf(manifest).map((c) => [c.tool, c]));
      let secrets: Record<string, string> = {};
      if (manifest.secrets.length > 0) {
        const values = secretValuesFor(
          manifest,
          readConnectorSecrets(opts.secretsDir ?? defaultEndpointDir()),
        );
        if (!values) {
          return {
            kind: 'suspended',
            reason: `the connector "${connector}" needs setup ("stratum connectors setup ${connector}")`,
          };
        }
        secrets = values;
      }
      const launched = await connectorLaunches(
        opts.box ?? BoxConfigSchema.parse({}),
        [{ manifest, secrets }],
        opts.launch,
      );
      if (!launched.ok) return { kind: 'suspended', reason: launched.reason };
      const launch = launched.launches[0]!;

      // El cliente comprueba la caja de conectores justo antes de lanzar el
      // proceso (`beforeConnect`): una sola vez por ciclo, y si no está lista,
      // suspendido, nunca un fallo de la comprobación.
      const client = newClient(launch.config, launch.beforeConnect);
      try {
        try {
          await client.connect();
        } catch (err) {
          if (err instanceof ConnectorsBoxUnavailableError) {
            return { kind: 'suspended', reason: err.message };
          }
          throw err;
        }
        const outcomes: CheckOutcome[] = [];
        for (const call of calls) {
          if (signal?.aborted) {
            outcomes.push({ ok: false, reason: 'the check was cancelled' });
            continue;
          }
          // Solo lo que el manifiesto declara como comprobación: nunca otra tool.
          const check = declared.get(call.tool);
          if (!check) {
            outcomes.push({ ok: false, reason: `"${call.tool}" is not a check of "${connector}"` });
            continue;
          }
          // Otra vez contra el manifiesto: `watches.json` se validó al crearlo,
          // pero el conector pudo cambiar de versión desde entonces.
          const args = validateCheckArgs(check, call.args);
          if (!args.ok) {
            outcomes.push({ ok: false, reason: args.error });
            continue;
          }
          try {
            const raw = await client.callTool(
              call.tool,
              { ...args.args },
              signal,
              opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
            );
            outcomes.push(parseCheckResult(raw));
          } catch (err) {
            outcomes.push({ ok: false, reason: messageOf(err) });
          }
        }
        return { kind: 'ran', outcomes };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

/**
 * M23 — `doctor.run`: el diagnóstico del `companion` visto desde el daemon,
 * que es quien sabe lo que pasa de verdad (el canal vivo, el autoarranque de la
 * caja, los vigilantes suspendidos, los ficheros en solo lectura).
 *
 * Solo lee y nunca arregla nada. No importa `daemon.ts`: todo entra por `deps`.
 * Los textos libres (motivos del runtime, errores del canal) se redactan antes
 * de salir: pueden traer lo que escupa un programa externo.
 */
import type { BoxManager } from '../box/manager.js';
import type { ConnectorCatalog } from '../connectors/catalog.js';
import type { StratumConfig } from '../config/schema.js';
import {
  doctorChecks,
  type DoctorConnectorsFacts,
  type DoctorFacts,
  type DoctorStoreFacts,
  type DoctorVoiceFacts,
  type DoctorWatchFacts,
} from '../doctor/checks.js';
import {
  connectorsFacts,
  modelFacts,
  telegramFactsFromStatus,
  voiceFacts,
} from '../doctor/collect.js';
import type { ProtocolChannelsStatus, ProtocolDoctorReport } from '../protocol/index.js';
import { redactSecrets } from '../security/redact-output.js';
import type { BoxAutostartState } from './box-autostart.js';

export interface DaemonDoctorDeps {
  version: string;
  pid: number;
  /** Versión de Stratum del cliente, solo si es la CLI (Dot tiene la suya). */
  clientVersion: string | null;
  config: StratumConfig;
  box: BoxManager;
  boxAutostart: BoxAutostartState;
  catalog: ConnectorCatalog;
  companionDir: string;
  secretsDir: string;
  /** `null`: el daemon no tiene canales. */
  channels: () => ProtocolChannelsStatus | null;
  /** Provider y modelo de la sesión principal del `companion`, si la hay. */
  companionModel: { provider: string; model: string } | null;
  stores: DoctorStoreFacts[];
  watches: DoctorWatchFacts | null;
  /** M23 — la última comprobación de acceso de cada conector (`HealthMonitor`). */
  access?: ReadonlyMap<string, { status: 'ok' | 'auth' | 'unreachable' | 'error'; detail: string }>;
  /** M25 — lo que vieron las notas de voz de este daemon; ausente sin notas de voz. */
  voice?: () => DoctorVoiceFacts['live'];
  /** Para los tests: el directorio del modelo y si el runtime se resuelve. */
  voiceModelDir?: string;
  voiceRuntime?: () => boolean;
  /** Arranque al iniciar sesión; `null` si no se puede saber. */
  loginAutostart: () => Promise<{ enabled: boolean; detail: string | null } | null>;
  now: number;
}

/** M23 — suma a cada conector lo que dijo su última comprobación de acceso. */
function withAccess(
  access: DaemonDoctorDeps['access'],
  facts: DoctorConnectorsFacts | null,
): DoctorConnectorsFacts | null {
  if (!facts || !access) return facts;
  return {
    ...facts,
    enabled: facts.enabled.map((k) => {
      const a = access.get(k.id);
      return a ? { ...k, access: { status: a.status, detail: clean(a.detail) ?? '' } } : k;
    }),
  };
}

function clean(text: string | null | undefined): string | null {
  return text ? redactSecrets(text).text : null;
}

export async function daemonDoctorReport(d: DaemonDoctorDeps): Promise<ProtocolDoctorReport> {
  const [boxStatus, connectorsBox, model, login, voice] = await Promise.all([
    d.box.status(),
    d.box.connectorsStatus(),
    modelFacts({ config: d.config, session: d.companionModel, probe: true }),
    d.loginAutostart().catch(() => null),
    voiceFacts({
      voice: d.config.voice,
      live: d.voice ? d.voice() : null,
      ...(d.voiceModelDir ? { dir: d.voiceModelDir } : {}),
      ...(d.voiceRuntime ? { runtime: d.voiceRuntime } : {}),
    }),
  ]);
  const channels = d.channels();
  const facts: DoctorFacts = {
    daemon: {
      running: { version: d.version, pid: d.pid },
      clientVersion: d.clientVersion,
      loginAutostart: login,
    },
    box: {
      enabled: boxStatus.enabled,
      // Lo que hace este daemon, que puede no coincidir con la config si se cambió después.
      autostart: d.boxAutostart.phase !== 'off',
      desktop: boxStatus.desktop,
      status: {
        state: boxStatus.state,
        runtime: boxStatus.runtime,
        reason: clean(boxStatus.reason),
        outdated: boxStatus.outdated,
      },
      autostartRun: { phase: d.boxAutostart.phase, reason: clean(d.boxAutostart.reason) },
    },
    connectors: withAccess(
      d.access,
      connectorsFacts({
        catalog: d.catalog,
        companionDir: d.companionDir,
        secretsDir: d.secretsDir,
        box: {
          state: connectorsBox.state,
          reason: clean(connectorsBox.reason),
          outdated: connectorsBox.outdated,
        },
      }),
    ),
    telegram: channels ? telegramFactsFromStatus(channels.telegram) : null,
    model,
    voice,
    stores: d.stores,
    watches: d.watches,
  };
  const checks = doctorChecks(facts).map((c) =>
    c.area === 'telegram' && c.detail ? { ...c, detail: clean(c.detail) } : c,
  );
  return { checkedAt: d.now, checks };
}

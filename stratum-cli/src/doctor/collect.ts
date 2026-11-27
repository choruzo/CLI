/**
 * M23 — reunir los hechos de `doctor` que se leen igual desde el daemon y desde
 * la CLI sin daemon: ficheros del `companion`, secretos (solo sus nombres) y el
 * provider del modelo. Solo lee; nunca escribe ni arregla.
 */
import { createRequire } from 'module';
import type { ConnectorCatalog } from '../connectors/catalog.js';
import { readConnectorSecrets } from '../connectors/secrets.js';
import { connectorsFile, readConnectorsFile } from '../connectors/store.js';
import type { StratumConfig, VoiceConfig } from '../config/schema.js';
import { voiceModelDir, voiceModelStatus } from '../voice/model-store.js';
import { fetchModelInfos } from '../providers/utils.js';
import type { ProtocolTelegramStatus } from '../protocol/index.js';
import type {
  DoctorConnectorsFacts,
  DoctorModelFacts,
  DoctorTelegramFacts,
  DoctorVoiceFacts,
  FileState,
} from './checks.js';

const PROBE_TIMEOUT_MS = 3000;

function fileState(state: string): FileState {
  if (state === 'ok' || state === 'absent' || state === 'newer') return state;
  return 'invalid';
}

/**
 * Los conectores activos, si les falta algún secreto (por nombre) y la caja de
 * conectores. `box`: la ya consultada, o `null` si no se pudo mirar.
 */
export function connectorsFacts(opts: {
  catalog: ConnectorCatalog;
  companionDir: string;
  secretsDir: string;
  box: DoctorConnectorsFacts['box'];
}): DoctorConnectorsFacts {
  const file = readConnectorsFile(connectorsFile(opts.companionDir));
  const enabled = file.state === 'ok' ? file.enabled : [];
  const needsSecrets = enabled.some(
    (e) => (opts.catalog.get(e.id)?.manifest.secrets?.length ?? 0) > 0,
  );
  // Solo se mira qué nombres hay: ningún valor sale de aquí.
  const secrets = needsSecrets
    ? readConnectorSecrets(opts.secretsDir)
    : ({ state: 'absent' } as const);
  const saved = secrets.state === 'ok' ? secrets.file.connectors : {};
  return {
    file: fileState(file.state),
    secretsFile: fileState(secrets.state),
    enabled: enabled.map((e) => {
      const manifest = opts.catalog.get(e.id)?.manifest;
      if (!manifest) return { id: e.id, name: e.id, unknown: true, missing: [], oauth: false };
      const have = saved[e.id] ?? {};
      return {
        id: e.id,
        name: manifest.name,
        unknown: false,
        missing: (manifest.secrets ?? []).map((s) => s.name).filter((n) => !have[n]),
        oauth: manifest.oauth !== undefined,
      };
    }),
    box: opts.box,
  };
}

/** Del estado del canal vivo (daemon). */
export function telegramFactsFromStatus(status: ProtocolTelegramStatus): DoctorTelegramFacts {
  const file: FileState =
    status.state === 'not-configured'
      ? 'absent'
      : status.state === 'invalid'
        ? 'invalid'
        : status.state === 'newer'
          ? 'newer'
          : 'ok';
  return {
    configEnabled: status.state !== 'disabled',
    file,
    paired: status.paired.length,
    live: {
      state: status.state,
      lastError: status.lastError
        ? { kind: status.lastError.kind, message: status.lastError.message }
        : null,
    },
  };
}

/**
 * El modelo del asistente: de su sesión, si la hay; si no, el por defecto. Con
 * `probe`, pregunta a `/models` (≤ 3 s); la visión, solo la declarada.
 */
export async function modelFacts(opts: {
  config: StratumConfig;
  session: { provider: string; model: string } | null;
  probe: boolean;
}): Promise<DoctorModelFacts | null> {
  const providers = opts.config.provider?.providers ?? {};
  const fallbackProvider = opts.config.provider?.default;
  const provider = opts.session?.provider ?? fallbackProvider;
  if (!provider) return null;
  const entry = providers[provider];
  const model = opts.session?.model ?? entry?.model;
  if (!model) return null;
  let probe: DoctorModelFacts['probe'] = 'not-checked';
  if (entry && opts.probe) {
    try {
      const infos = await fetchModelInfos(entry.baseUrl, entry.apiKey, {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      // Un backend que no lista nada no dice que el modelo no exista.
      probe = infos.length === 0 || infos.some((m) => m.id === model) ? 'listed' : 'unlisted';
    } catch {
      // Sin el detalle: puede nombrar la URL del backend.
      probe = 'unreachable';
    }
  }
  return {
    provider,
    model,
    source: opts.session ? 'session' : 'default',
    providerKnown: entry !== undefined,
    probe,
    vision: entry?.models?.[model]?.vision !== undefined,
  };
}

/** `onnxruntime-node` se resuelve desde aquí. Solo la ruta: no carga el nativo. */
export function voiceRuntimeResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

/**
 * M25 — la voz: la config, el modelo (sin `verify`) y el runtime. `live` lo
 * pone el daemon con `VoiceNotes.health()`; la CLI sin daemon pasa `null`.
 */
export async function voiceFacts(opts: {
  voice: VoiceConfig;
  live: DoctorVoiceFacts['live'];
  dir?: string;
  runtime?: () => boolean;
}): Promise<DoctorVoiceFacts> {
  const base = {
    enabled: opts.voice.enabled,
    language: opts.voice.language,
    device: opts.voice.device,
  };
  if (!opts.voice.enabled) {
    return { ...base, model: 'missing', runtime: true, live: null };
  }
  let model: DoctorVoiceFacts['model'];
  try {
    model = (await voiceModelStatus({ dir: opts.dir ?? voiceModelDir() })).state;
  } catch {
    model = 'corrupt';
  }
  return {
    ...base,
    model,
    runtime: (opts.runtime ?? voiceRuntimeResolvable)(),
    live: opts.live,
  };
}

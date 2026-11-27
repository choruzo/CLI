/**
 * M23 — `stratum doctor` y `doctor.run`: de unos hechos ya reunidos a una lista
 * de comprobaciones. **Puro**: no lee disco, red ni runtime; quien llama
 * reúne los hechos (el daemon, con lo que solo él sabe; la CLI sin daemon,
 * con lo que puede leer) y un hecho `null` es «no se sabe aquí» y su
 * comprobación no sale.
 *
 * Solo describe. Ninguna comprobación arregla nada: `fix` es lo que puede
 * hacer la persona. Nunca entra un secreto ni un valor de un secreto: los
 * hechos solo traen nombres y estados.
 */
import {
  DOCTOR_LIMITS,
  type ProtocolDoctorArea,
  type ProtocolDoctorCheck,
  type ProtocolDoctorStatus,
} from '../protocol/index.js';

export type FileState = 'absent' | 'ok' | 'invalid' | 'newer';

export interface DoctorBoxFacts {
  enabled: boolean;
  autostart: boolean;
  desktop: boolean;
  status: {
    state: 'unavailable' | 'absent' | 'stopped' | 'running';
    runtime: 'podman' | 'docker' | null;
    reason: string | null;
    outdated: boolean;
  };
  /** Lo que hizo `box.autostart` en este daemon; `null` sin daemon. */
  autostartRun: { phase: string; reason: string | null } | null;
}

export interface DoctorConnectorFacts {
  id: string;
  name: string;
  /** Fuera del catálogo de este Stratum (activo en `connectors.json`, pero no existe). */
  unknown: boolean;
  /** Nombres de los secretos que faltan, nunca valores. */
  missing: string[];
  oauth: boolean;
  /**
   * M23 — lo que dijo su última comprobación de acceso, hecha por el daemon
   * desde la caja de conectores (`daemon/health-monitor.ts`). Ausente o `null`:
   * no se sabe aquí (sin daemon, sin comprobación declarada o aún sin pasada).
   */
  access?: { status: 'ok' | 'auth' | 'unreachable' | 'error'; detail: string } | null;
}

export interface DoctorConnectorsFacts {
  file: FileState;
  secretsFile: FileState;
  enabled: DoctorConnectorFacts[];
  box: {
    state: 'unavailable' | 'absent' | 'stopped' | 'running';
    reason: string | null;
    outdated: boolean;
  } | null;
}

export interface DoctorTelegramFacts {
  /** `channels.telegram.enabled` en la config global. */
  configEnabled: boolean;
  file: FileState;
  paired: number;
  /** Lo que ve el canal vivo del daemon; `null` sin daemon. */
  live: {
    state: string;
    lastError: { kind: string; message: string } | null;
  } | null;
}

export interface DoctorModelFacts {
  provider: string;
  model: string;
  /** De la sesión del `companion`, o el por defecto si aún no hay sesión. */
  source: 'session' | 'default';
  /** El alias existe en la config. */
  providerKnown: boolean;
  /** `listed`: `/models` lo trae. `unlisted`: responde sin él. `unreachable`: no responde. */
  probe: 'listed' | 'unlisted' | 'unreachable' | 'not-checked';
  vision: boolean;
}

/**
 * M25 — las notas de voz. `model` sale de `voiceModelStatus` sin `verify` (las
 * sumas de 4 GB son de `stratum voice status --verify`). `live` solo lo sabe el
 * daemon (`VoiceNotes.health()`): en memoria, desde que arrancó.
 */
export interface DoctorVoiceFacts {
  enabled: boolean;
  language: string;
  device: 'auto' | 'gpu' | 'cpu';
  model: 'missing' | 'incomplete' | 'outdated' | 'corrupt' | 'ready';
  /** `onnxruntime-node` se resuelve (sin cargarlo). */
  runtime: boolean;
  /** `null`: sin daemon. */
  live: {
    lastNote: { device: 'gpu' | 'cpu' | 'unconfirmed'; at: number } | null;
    lastFailure: {
      kind: 'model' | 'runtime' | 'load' | 'crashed' | 'timeout' | 'failed';
      at: number;
    } | null;
  } | null;
}

export interface DoctorDaemonFacts {
  /** `null`: no se sabe (la CLI sin poder preguntar). */
  running: { version: string; pid: number | null } | false | null;
  clientVersion: string | null;
  /** Arranque al iniciar sesión (`stratum daemon autostart`). */
  loginAutostart: { enabled: boolean; detail: string | null } | null;
}

export interface DoctorStoreFacts {
  name: 'routines.json' | 'reminders.json' | 'watches.json' | 'connectors.json';
  readOnly: boolean;
}

export interface DoctorWatchFacts {
  active: number;
  suspended: number;
  failing: number;
}

export interface DoctorFacts {
  daemon: DoctorDaemonFacts;
  box: DoctorBoxFacts | null;
  connectors: DoctorConnectorsFacts | null;
  telegram: DoctorTelegramFacts | null;
  model: DoctorModelFacts | null;
  /** M25 — ausente o `null`: no se sabe aquí. */
  voice?: DoctorVoiceFacts | null;
  stores: DoctorStoreFacts[] | null;
  watches: DoctorWatchFacts | null;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function check(
  id: string,
  area: ProtocolDoctorArea,
  status: ProtocolDoctorStatus,
  title: string,
  detail: string | null = null,
  fix: string | null = null,
): ProtocolDoctorCheck {
  return {
    id: clip(id, DOCTOR_LIMITS.idChars),
    area,
    status,
    title: clip(title, DOCTOR_LIMITS.titleChars),
    detail: detail === null ? null : clip(detail, DOCTOR_LIMITS.textChars),
    fix: fix === null ? null : clip(fix, DOCTOR_LIMITS.textChars),
  };
}

function daemonChecks(d: DoctorDaemonFacts): ProtocolDoctorCheck[] {
  const out: ProtocolDoctorCheck[] = [];
  if (d.running === false) {
    out.push(
      check(
        'daemon.running',
        'daemon',
        'fail',
        'The daemon is not running',
        'Dot, Telegram, routines, reminders and watches need it.',
        'stratum daemon start',
      ),
    );
  } else if (d.running) {
    out.push(
      check(
        'daemon.running',
        'daemon',
        'ok',
        `The daemon is running (Stratum ${d.running.version})`,
        d.running.pid !== null ? `pid ${d.running.pid}` : null,
      ),
    );
    if (d.clientVersion !== null && d.clientVersion !== d.running.version) {
      out.push(
        check(
          'daemon.version',
          'daemon',
          'warn',
          `The daemon runs Stratum ${d.running.version}; this CLI is ${d.clientVersion}`,
          'An older daemon keeps running until it is restarted.',
          'stratum daemon stop, then stratum daemon start',
        ),
      );
    }
  }
  if (d.loginAutostart) {
    out.push(
      d.loginAutostart.enabled
        ? check(
            'daemon.autostart',
            'daemon',
            'ok',
            'The daemon starts when you log in',
            d.loginAutostart.detail,
          )
        : check(
            'daemon.autostart',
            'daemon',
            'off',
            'The daemon does not start when you log in',
            'After a restart nothing runs until Dot or a command starts it.',
            'stratum daemon autostart on',
          ),
    );
  }
  return out;
}

function boxChecks(b: DoctorBoxFacts): ProtocolDoctorCheck[] {
  const out: ProtocolDoctorCheck[] = [];
  const s = b.status;
  if (s.state === 'unavailable') {
    out.push(
      check(
        'box.runtime',
        'box',
        b.enabled ? 'fail' : 'warn',
        'No container runtime available',
        s.reason ?? 'Neither Podman nor Docker answered.',
        'Install Podman or Docker (or start Docker Desktop), then stratum box start',
      ),
    );
  } else {
    out.push(check('box.runtime', 'box', 'ok', `Container runtime: ${s.runtime ?? 'unknown'}`));
    if (s.state === 'running') {
      out.push(check('box.state', 'box', 'ok', 'The box is running'));
    } else {
      out.push(
        check(
          'box.state',
          'box',
          b.enabled ? 'warn' : 'off',
          s.state === 'absent' ? 'The box has not been created' : 'The box is stopped',
          b.enabled ? 'The assistant cannot run commands or use its screen until it starts.' : null,
          'stratum box start',
        ),
      );
    }
    if (s.outdated) {
      out.push(
        check(
          'box.image',
          'box',
          'warn',
          'The box was created with another image or settings',
          'Its next start recreates it; its home is kept.',
          'stratum box start',
        ),
      );
    }
  }
  if (!b.enabled) {
    out.push(
      check(
        'box.enabled',
        'box',
        'off',
        'Sessions cannot use the box',
        'Without it the assistant has no exec and no screen.',
        'Set "box.enabled": true in the global config',
      ),
    );
  }
  if (!b.autostart) {
    out.push(
      check(
        'box.autostart',
        'box',
        'off',
        'The box does not start with the daemon',
        'After a restart it stays stopped until someone starts it.',
        'Set "box.autostart": true in the global config',
      ),
    );
  } else if (b.autostartRun) {
    const { phase, reason } = b.autostartRun;
    const status: ProtocolDoctorStatus =
      phase === 'failed' ? 'fail' : phase === 'started' || phase === 'skipped-busy' ? 'ok' : 'warn';
    const title =
      phase === 'started'
        ? 'The box started with the daemon'
        : phase === 'failed'
          ? 'The box did not start with the daemon'
          : phase === 'waiting-runtime'
            ? 'Waiting for the container runtime to start the box'
            : phase === 'starting'
              ? 'Starting the box (the first time it builds its image)'
              : phase === 'skipped-busy'
                ? 'The box was already being started or stopped'
                : 'The box starts with the daemon';
    out.push(
      check(
        'box.autostart',
        'box',
        status,
        title,
        reason,
        phase === 'failed' ? 'stratum box start' : null,
      ),
    );
  } else {
    out.push(check('box.autostart', 'box', 'ok', 'The box starts with the daemon'));
  }
  return out;
}

function fileProblem(file: FileState, name: string): string | null {
  if (file === 'invalid') return `${name} is damaged`;
  if (file === 'newer') return `${name} is from a newer Stratum`;
  return null;
}

function connectorChecks(c: DoctorConnectorsFacts, boxEnabled: boolean): ProtocolDoctorCheck[] {
  const out: ProtocolDoctorCheck[] = [];
  const fileIssue = fileProblem(c.file, 'connectors.json');
  if (fileIssue) {
    out.push(
      check(
        'connectors.file',
        'connectors',
        'fail',
        fileIssue,
        'No connector is active until it can be read.',
        'Fix or remove ~/.stratum/companion/connectors.json',
      ),
    );
  }
  if (c.enabled.length === 0) {
    if (!fileIssue)
      out.push(check('connectors.enabled', 'connectors', 'off', 'No connector is enabled'));
    return out;
  }
  if (c.box) {
    if (c.box.state === 'running') {
      out.push(
        check(
          'connectors.box',
          'connectors',
          c.box.outdated ? 'warn' : 'ok',
          'The connectors box is running',
          c.box.outdated
            ? 'It was created with another image; the next box start recreates it.'
            : null,
          c.box.outdated ? 'stratum box start' : null,
        ),
      );
    } else {
      out.push(
        check(
          'connectors.box',
          'connectors',
          boxEnabled ? 'fail' : 'warn',
          c.box.state === 'unavailable'
            ? 'The connectors box is unavailable'
            : 'The connectors box is not running',
          c.box.reason ?? 'Connector tools are not offered without it.',
          'stratum box start',
        ),
      );
    }
  }
  const secretsIssue = fileProblem(c.secretsFile, 'connector-secrets.json');
  for (const k of c.enabled) {
    const id = `connector.${k.id}`;
    if (k.unknown) {
      out.push(
        check(
          id,
          'connectors',
          'warn',
          `Connector "${k.id}" is enabled but this Stratum does not have it`,
          null,
          `stratum connectors disable ${k.id}`,
        ),
      );
      continue;
    }
    if (k.missing.length > 0) {
      out.push(
        check(
          id,
          'connectors',
          'fail',
          `${k.name}: needs setup`,
          secretsIssue ?? `Missing: ${k.missing.join(', ')}.`,
          `stratum connectors setup ${k.id}`,
        ),
      );
      continue;
    }
    if (k.access && k.access.status !== 'ok') {
      out.push(
        k.access.status === 'auth'
          ? check(
              id,
              'connectors',
              'fail',
              `${k.name}: the authorization was rejected`,
              k.access.detail || 'It expired or was revoked.',
              `stratum connectors setup ${k.id}`,
            )
          : check(
              id,
              'connectors',
              'warn',
              `${k.name}: did not answer the last check`,
              k.access.detail || null,
            ),
      );
      continue;
    }
    if (k.access) {
      out.push(
        check(
          id,
          'connectors',
          'ok',
          `${k.name}: configured and answering`,
          'Its last access check from the connectors box worked.',
        ),
      );
      continue;
    }
    out.push(
      check(
        id,
        'connectors',
        'ok',
        `${k.name}: configured`,
        k.oauth
          ? 'If its OAuth app is in Testing mode, the authorization expires 7 days after setup; when its tools ask to authorize again, repeat the setup.'
          : null,
        k.oauth ? `stratum connectors setup ${k.id}` : null,
      ),
    );
  }
  return out;
}

function telegramChecks(t: DoctorTelegramFacts): ProtocolDoctorCheck[] {
  if (t.file === 'absent') {
    return [
      check(
        'telegram',
        'telegram',
        'off',
        'Telegram is not set up',
        null,
        'stratum channels telegram setup',
      ),
    ];
  }
  const fileIssue = fileProblem(t.file, 'telegram.json');
  if (fileIssue) {
    return [
      check(
        'telegram',
        'telegram',
        'fail',
        fileIssue,
        'The channel stays off until it is set up again.',
        'stratum channels telegram setup',
      ),
    ];
  }
  if (!t.configEnabled) {
    return [
      check(
        'telegram',
        'telegram',
        'off',
        'Telegram is set up but turned off',
        null,
        'stratum channels telegram setup',
      ),
    ];
  }
  const out: ProtocolDoctorCheck[] = [];
  const live = t.live;
  if (live?.state === 'unauthorized') {
    out.push(
      check(
        'telegram',
        'telegram',
        'fail',
        'Telegram rejects the bot token',
        'The bot may have been deleted or its token revoked.',
        'stratum channels telegram setup',
      ),
    );
  } else if (live && live.state !== 'running') {
    out.push(check('telegram', 'telegram', 'warn', `Telegram channel: ${live.state}`));
  } else if (live?.lastError) {
    out.push(
      check(
        'telegram',
        'telegram',
        'warn',
        'Telegram is failing to receive messages',
        `${live.lastError.kind}: ${live.lastError.message}`,
      ),
    );
  } else {
    out.push(
      check(
        'telegram',
        'telegram',
        'ok',
        live ? 'Telegram is receiving messages' : 'Telegram is set up',
      ),
    );
  }
  if (t.paired === 0) {
    out.push(
      check(
        'telegram.paired',
        'telegram',
        'warn',
        'No Telegram chat is paired',
        'Nobody can talk to the assistant from Telegram yet.',
        'stratum channels telegram pair',
      ),
    );
  }
  return out;
}

function modelChecks(m: DoctorModelFacts, needsVision: boolean): ProtocolDoctorCheck[] {
  const out: ProtocolDoctorCheck[] = [];
  const label = `${m.provider}/${m.model}`;
  const whose = m.source === 'session' ? "The assistant's model" : 'The default model';
  if (!m.providerKnown) {
    out.push(
      check(
        'model.provider',
        'model',
        'fail',
        `${whose} uses provider "${m.provider}", which is not in the config`,
        'The daemon falls back to the default provider when it reopens the session.',
        'stratum provider',
      ),
    );
  } else if (m.probe === 'unreachable') {
    out.push(
      check(
        'model.provider',
        'model',
        'fail',
        `Provider "${m.provider}" does not answer`,
        `${whose} is ${label}. It may be down or the key may have expired.`,
      ),
    );
  } else if (m.probe === 'unlisted') {
    out.push(
      check(
        'model.provider',
        'model',
        'warn',
        `Provider "${m.provider}" does not list ${m.model}`,
        `${whose} is ${label}; it may have been retired.`,
      ),
    );
  } else {
    out.push(
      check(
        'model.provider',
        'model',
        'ok',
        `${whose}: ${label}`,
        m.probe === 'not-checked' ? 'The provider was not contacted.' : null,
      ),
    );
  }
  if (needsVision) {
    out.push(
      m.vision
        ? check('model.vision', 'model', 'ok', `${label} can see the box screen`)
        : check(
            'model.vision',
            'model',
            'warn',
            `${label} has no vision declared`,
            'Without it the assistant cannot use the box screen.',
            `Declare provider.providers.${m.provider}.models.${m.model}.vision in the global config, if the model has vision`,
          ),
    );
  }
  return out;
}

const VOICE_FAILURE: Record<
  NonNullable<NonNullable<DoctorVoiceFacts['live']>['lastFailure']>['kind'],
  string
> = {
  model: 'the speech model could not be downloaded',
  runtime: 'onnxruntime-node is not installed',
  load: 'the speech model did not load',
  crashed: 'the voice worker crashed',
  timeout: 'the voice worker took too long',
  failed: 'the transcription failed',
};

function voiceChecks(v: DoctorVoiceFacts): ProtocolDoctorCheck[] {
  if (!v.enabled) {
    return [
      check(
        'voice.enabled',
        'voice',
        'off',
        'Voice notes are off',
        'Telegram voice notes are not transcribed.',
        'Set "voice.enabled": true in the global config',
      ),
    ];
  }
  const out: ProtocolDoctorCheck[] = [];
  if (!v.runtime) {
    out.push(
      check(
        'voice.runtime',
        'voice',
        'fail',
        'onnxruntime-node is not installed',
        'It is an optional dependency of Stratum; without it no voice note is transcribed.',
        'Reinstall Stratum: npm install -g stratum-cli',
      ),
    );
  }
  const lang = `Language: ${v.language}.`;
  if (v.model === 'ready') {
    out.push(check('voice.model', 'voice', 'ok', 'Speech model ready (Canary-1B-v2)', lang));
  } else {
    const title =
      v.model === 'missing'
        ? 'The speech model is not downloaded'
        : v.model === 'incomplete'
          ? 'The speech model download is incomplete'
          : v.model === 'outdated'
            ? 'The speech model is from another version'
            : 'The speech model is damaged';
    out.push(
      check(
        'voice.model',
        'voice',
        'warn',
        title,
        `The next voice note downloads it again (about 4 GB) and waits for it. ${lang}`,
        'stratum voice download',
      ),
    );
  }
  if (!v.live) return out;
  const { lastNote, lastFailure } = v.live;
  if (lastFailure && (!lastNote || lastFailure.at >= lastNote.at)) {
    out.push(
      check(
        'voice.last',
        'voice',
        'fail',
        `The last voice note failed: ${VOICE_FAILURE[lastFailure.kind]}`,
        'The next one tries again.',
        'stratum voice status',
      ),
    );
  }
  const note = lastNote;
  if (!note) {
    out.push(
      check(
        'voice.device',
        'voice',
        'ok',
        'No voice note since the daemon started',
        `The device is decided when the first note loads the model (setting: ${v.device}).`,
      ),
    );
  } else if (note.device === 'gpu') {
    out.push(check('voice.device', 'voice', 'ok', 'Voice notes run on the GPU (WebGPU)'));
  } else if (note.device === 'cpu' && v.device === 'cpu') {
    out.push(check('voice.device', 'voice', 'ok', 'Voice notes run on the CPU, as configured'));
  } else if (note.device === 'cpu') {
    out.push(
      check(
        'voice.device',
        'voice',
        'warn',
        'Voice notes fell back to the CPU',
        'WebGPU did not work: each note takes several times longer and the worker uses 4–5 GB of RAM.',
        'Update the GPU driver, or set "voice.device": "cpu" in the global config',
      ),
    );
  } else {
    out.push(
      check(
        'voice.device',
        'voice',
        'warn',
        'The GPU could not be confirmed for voice notes',
        'The load probe was slower than expected; the notes may be running on the CPU.',
      ),
    );
  }
  return out;
}

function storeChecks(stores: DoctorStoreFacts[]): ProtocolDoctorCheck[] {
  return stores
    .filter((s) => s.readOnly)
    .map((s) =>
      check(
        `data.${s.name}`,
        'data',
        'fail',
        `${s.name} cannot be modified`,
        'It is damaged or from a newer Stratum; it is left untouched.',
        `Check ~/.stratum/companion/${s.name}`,
      ),
    );
}

function watchChecks(w: DoctorWatchFacts): ProtocolDoctorCheck[] {
  const out: ProtocolDoctorCheck[] = [];
  if (w.suspended > 0) {
    out.push(
      check(
        'data.watches.suspended',
        'data',
        'warn',
        `${w.suspended} of ${w.active} active watches are suspended`,
        'Their connector cannot be reached (usually the box is stopped).',
        'stratum box start',
      ),
    );
  }
  if (w.failing > 0) {
    out.push(
      check(
        'data.watches.failing',
        'data',
        'warn',
        `${w.failing} of ${w.active} active watches keep failing`,
        null,
        'stratum watches list',
      ),
    );
  }
  return out;
}

/** Las comprobaciones, en orden: daemon, caja, conectores, Telegram, modelo, voz, datos. */
export function doctorChecks(f: DoctorFacts): ProtocolDoctorCheck[] {
  const boxEnabled = f.box?.enabled ?? false;
  const needsVision = Boolean(f.box?.enabled && f.box.desktop);
  const all = [
    ...daemonChecks(f.daemon),
    ...(f.box ? boxChecks(f.box) : []),
    ...(f.connectors ? connectorChecks(f.connectors, boxEnabled) : []),
    ...(f.telegram ? telegramChecks(f.telegram) : []),
    ...(f.model ? modelChecks(f.model, needsVision) : []),
    ...(f.voice ? voiceChecks(f.voice) : []),
    ...(f.stores ? storeChecks(f.stores) : []),
    ...(f.watches ? watchChecks(f.watches) : []),
  ];
  return all.slice(0, DOCTOR_LIMITS.checks);
}

/** El peor estado de una lista (`off` no cuenta como problema). */
export function worstStatus(checks: ProtocolDoctorCheck[]): ProtocolDoctorStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

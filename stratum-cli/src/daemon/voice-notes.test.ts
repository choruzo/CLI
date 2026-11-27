import { describe, expect, it } from 'vitest';
import type { VoiceConfig } from '../config/schema.js';
import {
  VoiceQueueFullError,
  VoiceRuntimeUnavailableError,
  VoiceWorkerError,
} from '../voice/client.js';
import { VoiceDecodeError } from '../voice/opus.js';
import { VoiceTooLongError } from '../voice/transcribe.js';
import type { VoiceTranscript } from '../voice/worker-protocol.js';
import {
  VOICE_MAX_WAITING,
  VoiceModelUnavailableError,
  VoiceNotes,
  VoiceNotesClosedError,
  VoiceNotesDisabledError,
  type VoiceClientPort,
  type VoiceModelDownload,
  type VoiceNotesOptions,
  voiceFailureKind,
} from './voice-notes.js';

/**
 * M25 fase 3 — `VoiceNotes`, con **todo** inyectado: ni worker, ni modelo, ni
 * WASM. Lo que se comprueba es la política: la cola (1 activa + 3 en espera),
 * la descarga del modelo de la nota en curso, el corte por duración, el cliente
 * cuando cambia la config y el cierre.
 */

/** Una config `voice` como la de verdad, con lo que el test quiera cambiar. */
function voiceConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return { enabled: true, language: 'es', device: 'auto', idleUnloadMinutes: 10, ...over };
}

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

/** PCM de 48 kHz de `seconds` segundos (lo que devolvería el decodificador). */
function pcm48(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * 48_000));
}

/** Lo que el cliente falso devuelve; por defecto, una nota de un trozo en GPU. */
function transcript(over: Partial<VoiceTranscript> = {}): VoiceTranscript {
  const durationSec = over.durationSec ?? 4;
  return {
    text: 'hola',
    durationSec,
    capped: false,
    ms: 1_000,
    device: 'gpu',
    chunks: [{ start: 0, end: durationSec * 16_000, reason: 'end', skipped: false }],
    ...over,
  };
}

class FakeClient implements VoiceClientPort {
  readonly calls: Float32Array[] = [];
  closed = false;

  constructor(private readonly reply: VoiceTranscript | Error = transcript()) {}

  async transcribe(pcm16k: Float32Array): Promise<VoiceTranscript> {
    this.calls.push(pcm16k);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }

  close(): void {
    this.closed = true;
  }
}

/** Una promesa que el test suelta a mano. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  notes: VoiceNotes;
  clients: FakeClient[];
  /** Los `device` con los que se creó cada cliente, en orden. */
  devices: string[];
  /** Fases de la descarga vistas, como `start`/`progress`/`done`/`failed`. */
  phases: string[];
  /** Descargas del modelo que llegaron a empezar. */
  downloads: number;
  /** Bytes que se pidieron a `getBytes` (los descarga el canal). */
  requested: number;
  /** Bytes que se le pasan a cada nota por defecto. */
  bytes: () => Promise<Uint8Array>;
  /** Cambia la config que se lee en cada nota. */
  setConfig: (cfg: VoiceConfig) => void;
  /** Cambia lo que dice el estado del modelo. */
  setModelReady: (ready: boolean) => void;
}

function harness(
  over: Partial<VoiceNotesOptions> & {
    ready?: boolean;
    downloadModel?: VoiceModelDownload;
    transcript?: VoiceTranscript | Error;
    seconds?: number;
  } = {},
): Harness {
  let config = voiceConfig();
  let modelReady = over.ready !== false;
  const clients: FakeClient[] = [];
  const devices: string[] = [];
  const phases: string[] = [];
  let downloads = 0;
  let requested = 0;
  const downloadModel =
    over.downloadModel ??
    (async () => {
      // La de verdad deja el modelo listo; la falsa, también.
      modelReady = true;
    });
  const notes = new VoiceNotes({
    config: () => config,
    dir: '/modelos/canary',
    // Todo inyectado: ni config del usuario, ni modelo, ni WASM.
    modelStatus: async () => ({ state: modelReady ? 'ready' : 'missing' }),
    downloadModel: (opts) => {
      downloads++;
      return downloadModel(opts);
    },
    decode: async () => ({
      pcm: pcm48(over.seconds ?? 4),
      sampleRate: 48_000,
    }),
    client: (cfg: VoiceConfig) => {
      const client = new FakeClient(over.transcript ?? transcript());
      clients.push(client);
      devices.push(cfg.device);
      return client;
    },
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    ...(over.modelStatus ? { modelStatus: over.modelStatus } : {}),
    ...(over.decode ? { decode: over.decode } : {}),
    ...(over.client ? { client: over.client } : {}),
  });
  const h: Harness = {
    notes,
    clients,
    devices,
    phases,
    get downloads() {
      return downloads;
    },
    get requested() {
      return requested;
    },
    bytes: () => {
      requested++;
      return Promise.resolve(OGG);
    },
    setConfig: (cfg) => {
      config = cfg;
    },
    setModelReady: (ready) => {
      modelReady = ready;
    },
  };
  return h;
}

/** Los hooks que arma el canal, apuntando las fases. */
function hooks(sink: string[]): {
  onModelDownload: (phase: string, info: { percent?: number }) => void;
} {
  return {
    onModelDownload: (phase, info) =>
      sink.push(info.percent === undefined ? phase : `${phase}:${info.percent}`),
  };
}

/** Deja correr las promesas pendientes (el `pump` de la cola es asíncrono). */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('VoiceNotes', () => {
  it('con la voz apagada no se transcribe nada ni se piden los bytes', async () => {
    const h = harness();
    h.setConfig(voiceConfig({ enabled: false }));
    await expect(h.notes.transcribe(h.bytes)).rejects.toBeInstanceOf(VoiceNotesDisabledError);
    expect(h.requested).toBe(0);
    expect(h.clients).toEqual([]);
  });

  it('con el modelo listo: pide los bytes, decodifica, baja a 16 kHz y devuelve el texto con sus metadatos', async () => {
    const h = harness({ seconds: 4 });
    const result = await h.notes.transcribe(h.bytes);
    expect(result).toEqual({
      text: 'hola',
      durationSec: 4,
      capped: false,
      device: 'gpu',
      ms: expect.any(Number),
      decodeMs: expect.any(Number),
      chunks: 1,
      skipped: 0,
    });
    // Los bytes se piden al empezar la nota, no al admitirla.
    expect(h.requested).toBe(1);
    // El PCM que llega al worker es el de 16 kHz: un tercio de muestras.
    expect(h.clients[0]!.calls[0]).toHaveLength(4 * 16_000);
    // Y el audio no se queda pegado a nada: el resultado no lleva bytes.
    expect(JSON.stringify(result)).not.toMatch(/pcm|bytes|audio/i);
  });

  it('cuenta los trozos saltados y el recortado', async () => {
    const chunks: VoiceTranscript['chunks'] = [
      { start: 0, end: 16_000, reason: 'silence', skipped: true },
      { start: 16_000, end: 64_000, reason: 'end', skipped: false, capped: true },
    ];
    const h = harness({
      transcript: transcript({ chunks, capped: true, warning: 'se usó la CPU' }),
      seconds: 4,
    });
    const result = await h.notes.transcribe(h.bytes);
    expect(result.capped).toBe(true);
    expect(result.chunks).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.warning).toBe('se usó la CPU');
  });

  it('la descarga del modelo la hace la nota en curso; las demás esperan detrás y la encuentran hecha', async () => {
    const gate = deferred<void>();
    const phases: string[] = [];
    const h = harness({
      ready: false,
      downloadModel: async ({ onProgress }) => {
        // Los porcentajes pueden repetirse: solo cuentan 25, 50 y 75, una vez cada uno.
        for (const pct of [10, 25, 40, 50, 60, 75, 90, 100]) {
          onProgress?.({ bytes: pct, total: 100 });
        }
        await gate.promise;
        h.setModelReady(true);
      },
    });
    const a = h.notes.transcribe(h.bytes, hooks(phases));
    const b = h.notes.transcribe(h.bytes, hooks(phases));
    // Todavía esperando al modelo: ni worker, ni transcripción, ni bytes.
    expect(h.clients).toEqual([]);
    expect(h.requested).toBe(0);
    expect(h.notes.busy).toBe(true);
    gate.resolve();
    await Promise.all([a, b]);
    expect(h.downloads).toBe(1);
    expect(phases).toEqual(['start', 'progress:25', 'progress:50', 'progress:75', 'done']);
    // Un solo cliente: la segunda nota ya se lo encuentra.
    expect(h.clients).toHaveLength(1);
    expect(h.notes.busy).toBe(false);
  });

  it('una descarga que falla rechaza la nota, y la siguiente lo reintenta', async () => {
    let attempt = 0;
    let ready = false;
    const h = harness({
      modelStatus: async () => ({ state: ready ? 'ready' : 'missing' }),
      downloadModel: async () => {
        attempt++;
        if (attempt === 1) throw new Error('sin red');
        ready = true;
      },
    });
    const phases: string[] = [];
    await expect(h.notes.transcribe(h.bytes, hooks(phases))).rejects.toBeInstanceOf(
      VoiceModelUnavailableError,
    );
    expect(phases).toEqual(['start', 'failed']);
    // La segunda nota vuelve a intentarlo, y esta vez va.
    const result = await h.notes.transcribe(h.bytes);
    expect(result.text).toBe('hola');
    expect(attempt).toBe(2);
  });

  it('admite 1 activa y 3 en espera; la quinta se rechaza en el acto, sin descargar nada', async () => {
    const gate = deferred<void>();
    const h = harness({
      decode: async () => {
        await gate.promise;
        return { pcm: pcm48(4), sampleRate: 48_000 };
      },
    });
    const first = h.notes.transcribe(h.bytes);
    const rest = [
      h.notes.transcribe(h.bytes),
      h.notes.transcribe(h.bytes),
      h.notes.transcribe(h.bytes),
    ];
    const fifth = h.notes.transcribe(h.bytes);
    // La admisión es síncrona: en este mismo instante no se ha bajado ni un byte.
    expect(h.requested).toBe(0);
    // La quinta no cabe: ni se queda esperando ni pide sus bytes.
    await expect(fifth).rejects.toBeInstanceOf(VoiceQueueFullError);
    gate.resolve();
    await Promise.all([first, ...rest]);
    // Solo las cuatro admitidas descargaron lo suyo.
    expect(h.requested).toBe(1 + VOICE_MAX_WAITING);
    // Con la cola vacía, vuelve a entrar.
    await expect(h.notes.transcribe(h.bytes)).resolves.toMatchObject({ text: 'hola' });
  });

  it('las atiende de una en una y por orden de llegada', async () => {
    const order: string[] = [];
    const h = harness();
    const notes = ['a', 'b', 'c', 'd'].map((name) =>
      h.notes.transcribe(async () => {
        order.push(name);
        return OGG;
      }),
    );
    await Promise.all(notes);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('un cambio de config con una nota en vuelo no la rompe y se aplica a la siguiente', async () => {
    const gate = deferred<void>();
    const h = harness({
      decode: async () => {
        await gate.promise;
        return { pcm: pcm48(4), sampleRate: 48_000 };
      },
    });
    const first = h.notes.transcribe(h.bytes);
    await settle();
    // La nota en vuelo ya leyó su config: cambiar la del usuario no la rompe.
    h.setConfig(voiceConfig({ device: 'cpu' }));
    gate.resolve();
    await expect(first).resolves.toMatchObject({ text: 'hola' });
    expect(h.devices).toEqual(['auto']);
    // La siguiente sí lo nota.
    await h.notes.transcribe(h.bytes);
    expect(h.devices).toEqual(['auto', 'cpu']);
    // Y el cliente viejo se cerró al rehacerse.
    expect(h.clients[0]!.closed).toBe(true);
  });

  it('más de 300 s es VoiceTooLongError', async () => {
    const h = harness({ seconds: 301 });
    await expect(h.notes.transcribe(h.bytes)).rejects.toBeInstanceOf(VoiceTooLongError);
    expect(h.clients).toEqual([]);
  });

  it('300 s justos entran', async () => {
    const h = harness({ seconds: 300 });
    await expect(h.notes.transcribe(h.bytes)).resolves.toMatchObject({ durationSec: 300 });
  });

  it('si cambian dispositivo, idioma o desinactividad entre notas, el cliente se rehace', async () => {
    const h = harness();
    await h.notes.transcribe(h.bytes);
    // La misma config reutiliza el worker.
    await h.notes.transcribe(h.bytes);
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0]!.closed).toBe(false);
    h.setConfig(voiceConfig({ device: 'cpu' }));
    await h.notes.transcribe(h.bytes);
    expect(h.clients).toHaveLength(2);
    expect(h.clients[0]!.closed).toBe(true);
    h.setConfig(voiceConfig({ device: 'cpu', idleUnloadMinutes: 30 }));
    await h.notes.transcribe(h.bytes);
    expect(h.clients).toHaveLength(3);
    expect(h.clients[1]!.closed).toBe(true);
  });

  it('close durante el estado del modelo: rechaza todo con VoiceNotesClosedError y no crea cliente', async () => {
    const gate = deferred<{ state: 'missing' }>();
    const h = harness({ modelStatus: () => gate.promise });
    const pending = h.notes.transcribe(h.bytes);
    await settle();
    h.notes.close();
    await expect(pending).rejects.toBeInstanceOf(VoiceNotesClosedError);
    // Aunque el estado del modelo llegue después, no se sigue: ni descarga ni worker.
    gate.resolve({ state: 'missing' });
    await settle();
    expect(h.downloads).toBe(0);
    expect(h.requested).toBe(0);
    expect(h.clients).toEqual([]);
    expect(h.notes.busy).toBe(false);
  });

  it('close durante getBytes: rechaza con VoiceNotesClosedError y no crea cliente', async () => {
    const gate = deferred<Uint8Array>();
    const h = harness();
    const pending = h.notes.transcribe(() => gate.promise);
    await settle();
    h.notes.close();
    await expect(pending).rejects.toBeInstanceOf(VoiceNotesClosedError);
    gate.resolve(OGG);
    await settle();
    expect(h.clients).toEqual([]);
    expect(h.notes.busy).toBe(false);
  });

  it('close durante la decodificación: rechaza con VoiceNotesClosedError y no crea cliente', async () => {
    const gate = deferred<void>();
    const h = harness({
      decode: async () => {
        await gate.promise;
        return { pcm: pcm48(4), sampleRate: 48_000 };
      },
    });
    const pending = h.notes.transcribe(h.bytes);
    await settle();
    h.notes.close();
    await expect(pending).rejects.toBeInstanceOf(VoiceNotesClosedError);
    gate.resolve();
    await settle();
    expect(h.clients).toEqual([]);
    // Y una nota después del cierre tampoco entra.
    await expect(h.notes.transcribe(h.bytes)).rejects.toBeInstanceOf(VoiceNotesClosedError);
  });

  it('close con una nota esperando detrás: la que espera también rechaza, y con su motivo', async () => {
    const gate = deferred<void>();
    const h = harness({
      decode: async () => {
        await gate.promise;
        return { pcm: pcm48(4), sampleRate: 48_000 };
      },
    });
    const active = h.notes.transcribe(h.bytes);
    const waiting = h.notes.transcribe(h.bytes);
    await settle();
    h.notes.close();
    await expect(active).rejects.toBeInstanceOf(VoiceNotesClosedError);
    await expect(waiting).rejects.toBeInstanceOf(VoiceNotesClosedError);
    // La que esperaba no llegó a pedir sus bytes.
    expect(h.requested).toBe(1);
    gate.resolve();
    await settle();
    expect(h.notes.busy).toBe(false);
  });

  it('close durante la descarga del modelo la aborta y rechaza', async () => {
    const gate = deferred<void>();
    const h = harness({
      ready: false,
      downloadModel: async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          void gate.promise.then(resolve);
          signal?.addEventListener('abort', () => reject(new Error('abortada')), { once: true });
        });
      },
    });
    const pending = h.notes.transcribe(h.bytes);
    await settle();
    expect(h.notes.busy).toBe(true);
    h.notes.close();
    await expect(pending).rejects.toBeInstanceOf(VoiceNotesClosedError);
    expect(h.notes.busy).toBe(false);
  });

  it('close con el worker vivo lo cierra', async () => {
    const h = harness();
    await h.notes.transcribe(h.bytes);
    h.notes.close();
    expect(h.clients[0]!.closed).toBe(true);
    expect(h.notes.busy).toBe(false);
  });

  it('un fallo del decodificador sale tal cual (el canal lo cuenta como fallo auxiliar)', async () => {
    const h = harness({
      decode: async () => {
        throw new VoiceDecodeError('no es opus');
      },
    });
    await expect(h.notes.transcribe(h.bytes)).rejects.toBeInstanceOf(VoiceDecodeError);
  });

  it('health: sin notas no sabe nada; tras una, su dispositivo; un fallo del runtime cuenta', async () => {
    const h = harness();
    expect(h.notes.health()).toEqual({ lastNote: null, lastFailure: null });
    await h.notes.transcribe(h.bytes);
    expect(h.notes.health()).toEqual({
      lastNote: { device: 'gpu', at: expect.any(Number) },
      lastFailure: null,
    });
    const broken = harness({ transcript: new VoiceRuntimeUnavailableError('sin ORT') });
    await expect(broken.notes.transcribe(broken.bytes)).rejects.toThrow('sin ORT');
    expect(broken.notes.health().lastFailure).toEqual({ kind: 'runtime', at: expect.any(Number) });
  });

  it('health: un fallo de la propia nota (OGG roto, demasiado larga) no es de salud', async () => {
    const h = harness({ seconds: 301 });
    await expect(h.notes.transcribe(h.bytes)).rejects.toBeInstanceOf(VoiceTooLongError);
    expect(h.notes.health().lastFailure).toBeNull();
    expect(voiceFailureKind(new VoiceDecodeError('x'))).toBeNull();
    expect(voiceFailureKind(new VoiceWorkerError('x', 'too_long'))).toBeNull();
    expect(voiceFailureKind(new VoiceWorkerError('x', 'load_failed'))).toBe('load');
    expect(voiceFailureKind(new VoiceModelUnavailableError('x'))).toBe('model');
  });
});

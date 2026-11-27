import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import { VOICE_UPLOAD_LIMITS } from '../protocol/model.js';
import type { VoiceNoteResult } from './voice-notes.js';
import {
  VOICE_MAX_OPEN_UPLOADS,
  VoiceUploads,
  type VoiceUploadLimits,
  type VoiceUploadTimer,
  type VoiceUploadsOptions,
} from './voice-uploads.js';

/**
 * M25 fase 4 — las subidas de un push-to-talk, con **todo** inyectado: quien
 * transcribe, los temporizadores y los ids. Lo que se prueba es la política de
 * §35: una subida por conexión, `seq` consecutivo, tope de duración, plazo de
 * inactividad, y que un `uploadId` que no es de esa conexión no existe.
 */

/** Lo que el transcriptor falso devuelve; por defecto, una nota de un trozo. */
function result(over: Partial<VoiceNoteResult> = {}): VoiceNoteResult {
  return {
    text: 'hola',
    durationSec: 2,
    capped: false,
    device: 'gpu',
    ms: 900,
    decodeMs: 0,
    chunks: 1,
    skipped: 0,
    ...over,
  };
}

class FakeTranscriber {
  readonly calls: Float32Array[] = [];

  constructor(private readonly reply: VoiceNoteResult | Error = result()) {}

  async transcribePcm(pcm16k: Float32Array): Promise<VoiceNoteResult> {
    this.calls.push(pcm16k);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

/** Un temporizador que el test ve y puede vencer a mano. */
interface FakeTimer extends VoiceUploadTimer {
  readonly id: number;
  readonly ms: number;
  readonly fire: () => void;
}

/** El reloj de los plazos: los arma `VoiceUploads` y los vence el test. */
function clock(): {
  setTimer: (fire: () => void, ms: number) => VoiceUploadTimer;
  clearTimer: (timer: VoiceUploadTimer) => void;
  /** Los plazos vivos, en orden de creación. */
  live: () => FakeTimer[];
  /** Vence el plazo de inactividad (el que vence solo). */
  expire: () => void;
} {
  const live: FakeTimer[] = [];
  let next = 0;
  return {
    setTimer: (fire, ms) => {
      const timer: FakeTimer = { id: ++next, ms, fire, unref: () => undefined };
      live.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = live.findIndex((t) => t.id === (timer as FakeTimer).id);
      if (at >= 0) live.splice(at, 1);
    },
    live: () => [...live],
    expire: () => {
      const timer = live.shift();
      timer?.fire();
    },
  };
}

/** PCM16 LE mono en base64, como lo manda un cliente. */
function base64Pcm(samples: Int16Array | number): string {
  const count = typeof samples === 'number' ? samples : samples.length;
  const bytes = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    bytes.writeInt16LE(typeof samples === 'number' ? 1_000 : samples[i]!, i * 2);
  }
  return bytes.toString('base64');
}

/** Un segundo de audio a 16 kHz. */
const ONE_SECOND = VOICE_UPLOAD_LIMITS.sampleRate;

interface Harness {
  uploads: VoiceUploads;
  transcriber: FakeTranscriber;
  clock: ReturnType<typeof clock>;
  /** Las subidas que se han emitido, en orden (para comprobar los ids). */
  ids: string[];
}

function harness(
  over: {
    limits?: Partial<VoiceUploadLimits>;
    transcriber?: FakeTranscriber;
    randomId?: () => string;
  } = {},
): Harness {
  let next = 0;
  const time = clock();
  const ids: string[] = [];
  const transcriber = over.transcriber ?? new FakeTranscriber();
  const options: VoiceUploadsOptions = {
    transcriber,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    randomId:
      over.randomId ??
      (() => {
        const id = `subida-${++next}`;
        ids.push(id);
        return id;
      }),
    ...(over.limits ? { limits: { ...VOICE_UPLOAD_LIMITS, ...over.limits } } : {}),
  };
  return { uploads: new VoiceUploads(options), transcriber, clock: time, ids };
}

/** El código y el motivo de un rechazo, como los vería el cliente. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) return 'OK';
  if (err instanceof ProtocolError) {
    const reason = err.data?.reason;
    return `${err.code}${reason ? `:${reason}` : ''}`;
  }
  return `threw ${String(err)}`;
}

/** Lo mismo, para lo que lanza en el acto (no devuelve promesa). */
function thrownBy(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    if (err instanceof ProtocolError) {
      const reason = err.data?.reason;
      return `${err.code}${reason ? `:${reason}` : ''}`;
    }
    return `threw ${String(err)}`;
  }
}

describe('VoiceUploads (M25 fase 4)', () => {
  it('begin devuelve los topes del protocolo y un id al azar que no se adivina', () => {
    // Sin `randomId` inyectado: 16 bytes al azar, y dos subidas nunca coinciden.
    const transcriber = new FakeTranscriber();
    const uploads = new VoiceUploads({ transcriber });
    const first = uploads.begin(1, 'ses_1');
    expect(first).toEqual({
      uploadId: expect.stringMatching(/^[0-9a-f]{32}$/),
      sampleRate: 16_000,
      maxSeconds: 300,
      chunkBytes: 65_536,
    });
    expect(uploads.begin(1, 'ses_1').uploadId).not.toBe(first.uploadId);
  });

  it('una subida abierta por conexión: abrir otra tira la anterior', () => {
    const h = harness();
    const first = h.uploads.begin(1, 'ses_1');
    const second = h.uploads.begin(1, 'ses_1');
    expect(h.uploads.count).toBe(1);
    expect(thrownBy(() => h.uploads.append(1, first.uploadId, 0, base64Pcm(ONE_SECOND)))).toBe(
      'NOT_FOUND',
    );
    expect(() => h.uploads.append(1, second.uploadId, 0, base64Pcm(ONE_SECOND))).not.toThrow();
  });

  it('como mucho VOICE_MAX_OPEN_UPLOADS abiertas en todo el daemon: la siguiente es voice-busy', () => {
    const h = harness();
    for (let conn = 1; conn <= VOICE_MAX_OPEN_UPLOADS; conn++) h.uploads.begin(conn, 'ses_1');
    let reason: unknown;
    try {
      h.uploads.begin(99, 'ses_1');
    } catch (err) {
      reason = (err as ProtocolError).data?.reason;
    }
    expect(reason).toBe('voice-busy');
    // Reabrir desde una conexión que ya tiene una no suma: sustituye.
    expect(() => h.uploads.begin(1, 'ses_1')).not.toThrow();
    expect(h.uploads.count).toBe(VOICE_MAX_OPEN_UPLOADS);
  });

  it('append acumula los trozos y cuenta los segundos', () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    expect(h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND)).seconds).toBeCloseTo(1, 6);
    expect(h.uploads.append(1, uploadId, 1, base64Pcm(ONE_SECOND / 2)).seconds).toBeCloseTo(1.5);
    expect(h.uploads.append(1, uploadId, 2, base64Pcm(ONE_SECOND / 2)).seconds).toBeCloseTo(2);
  });

  it('un seq que no es el siguiente es INVALID_PARAMS voice-seq y tira la subida', () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    // Un hueco: el 2 sí y el 1 no.
    expect(thrownBy(() => h.uploads.append(1, uploadId, 2, base64Pcm(ONE_SECOND)))).toBe(
      'INVALID_PARAMS:voice-seq',
    );
    expect(h.uploads.count).toBe(0);
  });

  it('un seq repetido también tira la subida', () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    expect(thrownBy(() => h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND)))).toBe(
      'INVALID_PARAMS:voice-seq',
    );
    expect(h.uploads.count).toBe(0);
  });

  it('un trozo con bytes impares o más grande que chunkBytes es INVALID_PARAMS y no rompe la subida', () => {
    const h = harness({ limits: { chunkBytes: 8 } });
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    expect(
      thrownBy(() => h.uploads.append(1, uploadId, 0, Buffer.from([1, 2, 3]).toString('base64'))),
    ).toBe('INVALID_PARAMS');
    // 10 bytes pares, pero por encima del tope del test.
    expect(thrownBy(() => h.uploads.append(1, uploadId, 0, base64Pcm(5)))).toBe('INVALID_PARAMS');
    // La subida sigue viva y el mismo `seq` sigue valiendo.
    expect(h.uploads.count).toBe(1);
    expect(h.uploads.append(1, uploadId, 0, base64Pcm(2)).seconds).toBeCloseTo(2 / 16_000, 6);
  });

  it('pasarse de maxSeconds es INVALID_PARAMS voice-too-long y tira la subida', () => {
    const h = harness({ limits: { maxSeconds: 2 } });
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    expect(thrownBy(() => h.uploads.append(1, uploadId, 1, base64Pcm(ONE_SECOND + 1)))).toBe(
      'INVALID_PARAMS:voice-too-long',
    );
    expect(h.uploads.count).toBe(0);
  });

  it('end transcribe el audio acumulado, ya a 16 kHz en Float32, con sus metadatos', async () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(7, 'ses_1');
    // Un segundo de audio, con los extremos del PCM16 en las primeras muestras.
    const samples = new Int16Array(ONE_SECOND);
    samples.set([-32_768, 16_384, 0, 8_192]);
    h.uploads.append(7, uploadId, 0, base64Pcm(samples));
    const done = await h.uploads.end(7, uploadId);
    expect(done.transcript).toEqual({
      text: 'hola',
      durationSec: 2,
      capped: false,
      device: 'gpu',
    });
    expect(done.meta).toEqual({
      durationSec: 2,
      device: 'gpu',
      ms: 900,
      decodeMs: 0,
      chunks: 1,
      skipped: 0,
      capped: false,
    });
    // La sesión de `voice.begin` viaja hasta aquí: es en qué traza se anota.
    expect(done.sessionId).toBe('ses_1');
    // Al transcriptor le llega el PCM normalizado a [-1, 1), entero.
    const pcm = h.transcriber.calls[0]!;
    expect(pcm).toHaveLength(ONE_SECOND);
    expect([...pcm.slice(0, 4)]).toEqual([-1, 0.5, 0, 0.25]);
  });

  it('end con menos de minSeconds es INVALID_PARAMS voice-too-short y la subida se tira', async () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    // Medio segundo menos una muestra.
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND / 2 - 1));
    expect(await failure(h.uploads.end(1, uploadId))).toBe('INVALID_PARAMS:voice-too-short');
    expect(h.uploads.count).toBe(0);
    expect(h.transcriber.calls).toEqual([]);
  });

  it('end saca la subida del mapa antes de esperar: el segundo end es NOT_FOUND', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      calls: [] as Float32Array[],
      async transcribePcm(pcm: Float32Array): Promise<VoiceNoteResult> {
        this.calls.push(pcm);
        await gate;
        return result();
      },
    };
    const uploads = new VoiceUploads({ transcriber: slow, randomId: () => 'subida-lenta' });
    const { uploadId } = uploads.begin(1, 'ses_1');
    uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    const pending = uploads.end(1, uploadId);
    // Mientras el modelo trabaja, la subida ya no está: ni otro `end` ni un `append`.
    expect(uploads.count).toBe(0);
    expect(await failure(uploads.end(1, uploadId))).toBe('NOT_FOUND');
    expect(thrownBy(() => uploads.append(1, uploadId, 1, base64Pcm(ONE_SECOND)))).toBe('NOT_FOUND');
    release();
    await expect(pending).resolves.toMatchObject({ transcript: { text: 'hola' } });
  });

  it('un uploadId de otra conexión, o desconocido, es NOT_FOUND', async () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    expect(thrownBy(() => h.uploads.append(2, uploadId, 0, base64Pcm(ONE_SECOND)))).toBe(
      'NOT_FOUND',
    );
    expect(await failure(h.uploads.end(2, uploadId))).toBe('NOT_FOUND');
    expect(thrownBy(() => h.uploads.cancel(2, uploadId))).toBe('NOT_FOUND');
    expect(thrownBy(() => h.uploads.append(1, 'inventado', 0, base64Pcm(4)))).toBe('NOT_FOUND');
    // Y la del dueño sigue intacta.
    expect(h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND)).seconds).toBeCloseTo(1, 6);
  });

  it('cancel tira la subida sin transcribirla', async () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    h.uploads.cancel(1, uploadId);
    expect(h.uploads.count).toBe(0);
    expect(await failure(h.uploads.end(1, uploadId))).toBe('NOT_FOUND');
    expect(h.transcriber.calls).toEqual([]);
  });

  it('el plazo de inactividad tira la subida, y cada append lo reinicia', () => {
    const h = harness();
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    expect(h.clock.live()).toHaveLength(1);
    expect(h.clock.live()[0]!.ms).toBe(VOICE_UPLOAD_LIMITS.idleMs);
    // Un trozo reinicia el plazo: el anterior ya no vale y solo queda uno vivo.
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    expect(h.clock.live()).toHaveLength(1);
    h.clock.expire();
    expect(h.uploads.count).toBe(0);
  });

  it('dropConnection tira solo la subida de esa conexión', () => {
    const h = harness();
    h.uploads.begin(1, 'ses_1');
    const other = h.uploads.begin(2, 'ses_1');
    h.uploads.dropConnection(1);
    expect(h.uploads.count).toBe(1);
    expect(h.uploads.append(2, other.uploadId, 0, base64Pcm(ONE_SECOND)).seconds).toBeCloseTo(1, 6);
    // Sin subida abierta, no hay nada que tirar y no lanza.
    expect(() => h.uploads.dropConnection(1)).not.toThrow();
  });

  it('close tira todo, cancela los plazos y después begin ya no abre nada', () => {
    const h = harness();
    h.uploads.begin(1, 'ses_1');
    h.uploads.begin(2, 'ses_1');
    h.uploads.close();
    expect(h.uploads.count).toBe(0);
    expect(h.clock.live()).toHaveLength(0);
    expect(thrownBy(() => h.uploads.begin(1, 'ses_1'))).toBe('UNAVAILABLE:voice-closed');
  });

  it('un fallo del transcriptor sale tal cual: lo traduce el daemon', async () => {
    const broken = new FakeTranscriber(new Error('el worker se cayó'));
    const h = harness({ transcriber: broken });
    const { uploadId } = h.uploads.begin(1, 'ses_1');
    h.uploads.append(1, uploadId, 0, base64Pcm(ONE_SECOND));
    await expect(h.uploads.end(1, uploadId)).rejects.toThrow('el worker se cayó');
    // La subida se tira igual: no se puede reintentar el `end`.
    expect(h.uploads.count).toBe(0);
  });
});

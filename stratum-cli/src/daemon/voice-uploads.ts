/**
 * M25 fase 4 — las subidas de un push-to-talk (`docs/protocol.md` §35).
 *
 * Un cliente abre una subida con `voice.begin`, manda el audio mientras la
 * persona mantiene el atajo (`voice.append`, PCM16 LE mono a 16 kHz en base64)
 * y recibe el texto con `voice.end`. El texto vuelve **solo a quien lo pidió**:
 * ni eventos ni conversación.
 *
 * Cuatro reglas que no se rompen:
 * - **el audio solo vive en memoria**: ni disco, ni log, ni traza;
 * - **una subida abierta por conexión**: `begin` tira la anterior;
 * - el búfer crece **con tope** (`maxSeconds × sampleRate` muestras) y se suelta
 *   en cuanto la subida se tira, salga bien o mal;
 * - la subida se tira **antes** de esperar a la transcripción, así que un `end`
 *   o un `append` repetido es `NOT_FOUND` y nada se queda colgado.
 *
 * No importa `daemon.ts`: las dependencias (quien transcribe, el reloj, los
 * temporizadores y los ids) entran por el constructor.
 */

import { randomBytes } from 'crypto';
import { ProtocolError } from '../ipc/codec.js';
import { VOICE_UPLOAD_LIMITS, type ProtocolVoiceTranscript } from '../protocol/model.js';
import { VOICE_MAX_WAITING, type VoiceNoteResult } from './voice-notes.js';

/** Lo único que se le pide a las notas de voz: transcribir PCM ya a 16 kHz. */
export interface VoicePcmTranscriber {
  transcribePcm(pcm16k: Float32Array): Promise<VoiceNoteResult>;
}

/** Los topes de una subida: los del protocolo, o los de un test. */
export interface VoiceUploadLimits {
  /** La única frecuencia que se acepta. */
  sampleRate: number;
  /** Lo que dura una subida, como mucho. */
  maxSeconds: number;
  /** Menos que esto es un toque sin querer (`voice-too-short`). */
  minSeconds: number;
  /** Bytes de PCM de un `append` (antes de base64). */
  chunkBytes: number;
  /** Una subida sin `append` en este plazo se tira. */
  idleMs: number;
}

/** Un temporizador; el de Node trae `unref` (no retiene el bucle de eventos). */
export interface VoiceUploadTimer {
  unref?: () => void;
}

/**
 * Subidas abiertas a la vez en todo el daemon, sumando todas las conexiones: lo
 * que cabe en la cola de transcripción (1 activa + 3 en espera). Cada una puede
 * llegar a 9,6 MB, así que sin tope muchas conexiones juntarían mucha memoria.
 */
export const VOICE_MAX_OPEN_UPLOADS = 1 + VOICE_MAX_WAITING;

export interface VoiceUploadsOptions {
  transcriber: VoicePcmTranscriber;
  /** Tope global de subidas abiertas. Por defecto, {@link VOICE_MAX_OPEN_UPLOADS}. */
  maxOpen?: number;
  limits?: VoiceUploadLimits;
  setTimer?: (fire: () => void, ms: number) => VoiceUploadTimer;
  clearTimer?: (timer: VoiceUploadTimer) => void;
  /**
   * El id de una subida. Por defecto, 16 bytes al azar: **no se adivina**, que es
   * lo que separa una subida de otra conexión de la propia.
   */
  randomId?: () => string;
}

/**
 * Los metadatos de la nota, los mismos que los de una nota de Telegram: a la
 * traza van estos y **nunca** el texto ni el audio.
 */
export interface VoiceUploadMeta {
  durationSec: number;
  device: ProtocolVoiceTranscript['device'];
  ms: number;
  decodeMs: number;
  chunks: number;
  skipped: number;
  capped: boolean;
}

/** Lo que devuelve `voice.end` ya con la subida cerrada. */
export interface VoiceUploadEnd {
  transcript: ProtocolVoiceTranscript;
  /** Para la traza de la sesión. */
  meta: VoiceUploadMeta;
  /** La sesión de `voice.begin`: en qué traza se anota la nota. */
  sessionId: string;
}

/** Una subida abierta. El `pcm` crece con tope y se suelta al tirarla. */
interface Upload {
  readonly id: string;
  readonly connId: number;
  /** La sesión de `voice.begin`, solo para saber en qué traza se anota. */
  readonly sessionId: string;
  /**
   * El siguiente `seq` que se acepta (empieza en 0). Se llama `nextSeq` y no
   * `seq` a propósito: el daemon no numera eventos (`architecture.test.ts`).
   */
  nextSeq: number;
  /** Muestras Int16 acumuladas (LE mono a 16 kHz), con su capacidad. */
  pcm: Int16Array;
  /** Cuántas muestras de `pcm` son audio de verdad. */
  length: number;
  timer: VoiceUploadTimer | null;
}

function defaultSetTimer(fire: () => void, ms: number): VoiceUploadTimer {
  const timer: VoiceUploadTimer = setTimeout(fire, ms);
  // No retiene el proceso: un daemon sin trabajo se apaga aunque quede un plazo.
  timer.unref?.();
  return timer;
}

function defaultClearTimer(timer: VoiceUploadTimer): void {
  clearTimeout(timer as NodeJS.Timeout);
}

export class VoiceUploads {
  private readonly limits: VoiceUploadLimits;
  private readonly setTimer: (fire: () => void, ms: number) => VoiceUploadTimer;
  private readonly clearTimer: (timer: VoiceUploadTimer) => void;
  private readonly randomId: () => string;
  /** Las subidas abiertas, por `uploadId`. */
  private readonly open = new Map<string, Upload>();
  /** La subida abierta de cada conexión (una, y solo una). */
  private readonly byConnection = new Map<number, string>();
  private closed = false;

  constructor(private readonly opts: VoiceUploadsOptions) {
    this.limits = opts.limits ?? VOICE_UPLOAD_LIMITS;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.clearTimer = opts.clearTimer ?? defaultClearTimer;
    this.randomId = opts.randomId ?? (() => randomBytes(16).toString('hex'));
  }

  /** Las subidas abiertas ahora mismo (diagnóstico y tests). */
  get count(): number {
    return this.open.size;
  }

  /**
   * Abre una subida para esa conexión, tirando la que tuviera abierta.
   *
   * @throws ProtocolError `UNAVAILABLE` (`voice-closed`) si ya se cerró, o
   *   (`voice-busy`) si ya hay {@link VOICE_MAX_OPEN_UPLOADS} abiertas en otras conexiones.
   */
  begin(
    connId: number,
    sessionId: string,
  ): { uploadId: string; sampleRate: number; maxSeconds: number; chunkBytes: number } {
    if (this.closed) {
      throw new ProtocolError('UNAVAILABLE', 'Voice uploads are closed.', {
        reason: 'voice-closed',
      });
    }
    // Una subida abierta por conexión: abrir otra tira la anterior.
    this.dropConnection(connId);
    if (this.open.size >= (this.opts.maxOpen ?? VOICE_MAX_OPEN_UPLOADS)) {
      throw new ProtocolError('UNAVAILABLE', 'Too many recordings at once.', {
        reason: 'voice-busy',
      });
    }
    const upload: Upload = {
      id: this.randomId(),
      connId,
      sessionId,
      nextSeq: 0,
      // La capacidad arranca en un segundo y se dobla al vuelo: la reserva del
      // máximo (300 s) al empezar sería de casi 10 MB para nada.
      pcm: new Int16Array(Math.min(this.limits.sampleRate, this.maxSamples)),
      length: 0,
      timer: null,
    };
    this.open.set(upload.id, upload);
    this.byConnection.set(connId, upload.id);
    this.armIdle(upload);
    return {
      uploadId: upload.id,
      sampleRate: this.limits.sampleRate,
      maxSeconds: this.limits.maxSeconds,
      chunkBytes: this.limits.chunkBytes,
    };
  }

  /**
   * Añade un trozo de audio. `seq` empieza en 0 y es consecutivo: un hueco o una
   * repetición **tira la subida**.
   *
   * @throws ProtocolError `NOT_FOUND`, `INVALID_PARAMS` (`voice-seq`, `voice-too-long`).
   */
  append(connId: number, uploadId: string, seq: number, pcmBase64: string): { seconds: number } {
    const upload = this.lookup(connId, uploadId);
    if (seq !== upload.nextSeq) {
      const expected = upload.nextSeq;
      this.drop(upload);
      throw new ProtocolError('INVALID_PARAMS', `Expected chunk ${expected}, got ${seq}.`, {
        reason: 'voice-seq',
      });
    }
    const bytes = Buffer.from(pcmBase64, 'base64');
    // PCM16: un número par de bytes, y como mucho lo que cabe en un mensaje.
    if (bytes.byteLength % 2 !== 0 || bytes.byteLength > this.limits.chunkBytes) {
      throw new ProtocolError('INVALID_PARAMS', 'The audio chunk is not PCM16 within the limit.');
    }
    const samples = bytes.byteLength / 2;
    if (upload.length + samples > this.maxSamples) {
      this.drop(upload);
      throw new ProtocolError('INVALID_PARAMS', 'The recording is too long.', {
        reason: 'voice-too-long',
      });
    }
    this.write(upload, bytes);
    upload.nextSeq++;
    // Sigue subiendo: el plazo de inactividad vuelve a empezar.
    this.armIdle(upload);
    return { seconds: upload.length / this.limits.sampleRate };
  }

  /**
   * Cierra la subida y la transcribe. La subida sale del mapa **antes** de
   * esperar: un `end` o un `append` repetido es `NOT_FOUND`. El búfer se suelta
   * siempre, salga bien o mal.
   *
   * @throws ProtocolError `NOT_FOUND`, `INVALID_PARAMS` (`voice-too-short`).
   */
  async end(connId: number, uploadId: string): Promise<VoiceUploadEnd> {
    const upload = this.lookup(connId, uploadId);
    const { sessionId } = upload;
    const samples = upload.length;
    // A Float32 y fuera: el Int16 se suelta antes de esperar al modelo.
    const pcm = new Float32Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = upload.pcm[i]! / 32768;
    this.drop(upload);
    if (samples < Math.round(this.limits.minSeconds * this.limits.sampleRate)) {
      throw new ProtocolError('INVALID_PARAMS', 'The recording is too short.', {
        reason: 'voice-too-short',
      });
    }
    const result = await this.opts.transcriber.transcribePcm(pcm);
    return {
      sessionId,
      transcript: {
        text: result.text,
        durationSec: result.durationSec,
        capped: result.capped,
        device: result.device,
      },
      meta: {
        durationSec: result.durationSec,
        device: result.device,
        ms: result.ms,
        decodeMs: result.decodeMs,
        chunks: result.chunks,
        skipped: result.skipped,
        capped: result.capped,
      },
    };
  }

  /**
   * Tira la subida sin transcribirla.
   *
   * @throws ProtocolError `NOT_FOUND`.
   */
  cancel(connId: number, uploadId: string): void {
    this.drop(this.lookup(connId, uploadId));
  }

  /** La conexión se fue: su subida abierta se tira. */
  dropConnection(connId: number): void {
    const id = this.byConnection.get(connId);
    if (id === undefined) return;
    const upload = this.open.get(id);
    if (upload) this.drop(upload);
    else this.byConnection.delete(connId);
  }

  /** Se apaga el daemon: fuera todas y ningún plazo pendiente. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const upload of [...this.open.values()]) this.drop(upload);
    this.open.clear();
    this.byConnection.clear();
  }

  // -------------------------------------------------------------------------

  /** El tope de muestras de una subida: ni una más, nunca. */
  private get maxSamples(): number {
    return Math.floor(this.limits.maxSeconds * this.limits.sampleRate);
  }

  /**
   * La subida de esa conexión. Un id desconocido, de **otra** conexión, ya
   * terminado o tirado es igual de invisible: `NOT_FOUND`.
   */
  private lookup(connId: number, uploadId: string): Upload {
    const upload = this.open.get(uploadId);
    if (!upload || upload.connId !== connId) {
      throw new ProtocolError('NOT_FOUND', 'Voice upload not found.');
    }
    return upload;
  }

  /** Copia el trozo al búfer, que crece doblando y nunca pasa del tope. */
  private write(upload: Upload, bytes: Buffer): void {
    const samples = bytes.byteLength / 2;
    const needed = upload.length + samples;
    if (upload.pcm.length < needed) {
      const grown = Math.max(needed, upload.pcm.length * 2);
      const next = new Int16Array(Math.min(this.maxSamples, grown));
      next.set(upload.pcm.subarray(0, upload.length));
      upload.pcm = next;
    }
    // El PCM del protocolo es little-endian, corra donde corra el daemon.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples; i++) {
      upload.pcm[upload.length + i] = view.getInt16(i * 2, true);
    }
    upload.length = needed;
  }

  /** (Re)arma el plazo de inactividad: al vencer, la subida se tira sola. */
  private armIdle(upload: Upload): void {
    this.disarm(upload);
    const timer = this.setTimer(() => {
      // Si mientras tanto la subida ya se tiró, esto no toca nada más.
      if (this.open.get(upload.id) === upload) this.drop(upload);
    }, this.limits.idleMs);
    timer.unref?.();
    upload.timer = timer;
  }

  private disarm(upload: Upload): void {
    if (upload.timer === null) return;
    this.clearTimer(upload.timer);
    upload.timer = null;
  }

  /** Tira la subida: fuera del mapa, sin plazo y con el búfer suelto. */
  private drop(upload: Upload): void {
    this.disarm(upload);
    this.open.delete(upload.id);
    if (this.byConnection.get(upload.connId) === upload.id) {
      this.byConnection.delete(upload.connId);
    }
    upload.pcm = new Int16Array(0);
    upload.length = 0;
  }
}

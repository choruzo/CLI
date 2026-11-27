/**
 * M25 (voz) — de PCM de 16 kHz a texto: trocear, saltar lo casi mudo y
 * transcribir en orden.
 *
 * El troceo no es un lujo: una nota entera pierde un 86,8 % de palabras (fase 1),
 * y los trozos casi mudos **inventan texto** (un 17,1 % de error en el control
 * con silencio añadido). Por eso el filtro va antes de llamar al modelo, no
 * después de leer su salida.
 */

import { chunk, isNearSilent, NEAR_SILENT_DBFS, type ChunkReason } from './chunk.js';
import type {
  VoiceDeviceInUse,
  VoiceTranscript,
  VoiceTranscriptChunk,
  VoiceTranscriptDevice,
} from './worker-protocol.js';

/** Frecuencia del PCM que entra: la del modelo. */
export const VOICE_SAMPLE_RATE = 16_000;

/** Duración máxima de una nota. Telegram corta en 5 min y el encoder de Canary falla más allá. */
export const VOICE_MAX_SECONDS = 300;

/** Lo que se le pide al motor (lo cumple `CanaryEngine`; los tests pasan uno falso). */
export interface TranscribeEngine {
  readonly device: VoiceDeviceInUse;
  readonly warning?: string;
  transcribe(
    pcm16k: Float32Array,
    opts: { language: string },
  ): Promise<{ text: string; encMs: number; decMs: number; outputTokens: number; capped: boolean }>;
}

export class VoiceTooLongError extends Error {
  constructor(
    message: string,
    readonly seconds?: number,
  ) {
    super(message);
    this.name = 'VoiceTooLongError';
  }
}

export interface TranscribeOptions {
  /** Idioma de Canary (`voice.language`). */
  language: string;
  /** Tope de duración. 300 s justos entran; una muestra más, no. */
  maxSeconds?: number;
  /** Umbral de «casi mudo» (dBFS de RMS). Provisional, ver `chunk.ts`. */
  nearSilentDbfs?: number;
  /** Milisegundos de reloj de pared (los tests lo pasan falso). */
  now?: () => number;
}

/**
 * Transcribe un PCM mono de 16 kHz.
 *
 * @throws VoiceTooLongError si pasa de `maxSeconds`.
 */
export async function transcribePcm(
  engine: TranscribeEngine,
  pcm16k: Float32Array,
  opts: TranscribeOptions,
): Promise<VoiceTranscript> {
  const maxSeconds = opts.maxSeconds ?? VOICE_MAX_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error('transcribePcm: maxSeconds > 0');
  }
  const durationSec = pcm16k.length / VOICE_SAMPLE_RATE;
  if (pcm16k.length > maxSeconds * VOICE_SAMPLE_RATE) {
    throw new VoiceTooLongError(
      `el audio dura ${durationSec.toFixed(1)} s y el máximo son ${maxSeconds} s`,
      durationSec,
    );
  }

  const now = opts.now ?? (() => Date.now());
  const started = now();
  const windows = chunk(pcm16k, {
    sampleRate: VOICE_SAMPLE_RATE,
    targetSec: 25,
    maxSec: 30,
  });

  const texts: string[] = [];
  const chunks: VoiceTranscriptChunk[] = [];
  let capped = false;
  /** ¿Se llegó a ejecutar el encoder en algún trozo? Sin eso no hay confirmación. */
  let ranEncoder = false;
  for (const window of windows) {
    const reason: ChunkReason = window.reason;
    if (
      isNearSilent(pcm16k, window.start, window.end, {
        thresholdDbfs: opts.nearSilentDbfs ?? NEAR_SILENT_DBFS,
        sampleRate: VOICE_SAMPLE_RATE,
      })
    ) {
      // No se manda al decoder: inventaría texto.
      chunks.push({ start: window.start, end: window.end, reason, skipped: true });
      continue;
    }
    const slice = pcm16k.subarray(window.start, window.end);
    const t0 = now();
    const result = await engine.transcribe(slice, { language: opts.language });
    ranEncoder = true;
    const ms = now() - t0;
    if (result.text.trim() !== '') texts.push(result.text);
    if (result.capped) capped = true;
    chunks.push({
      start: window.start,
      end: window.end,
      reason,
      skipped: false,
      capped: result.capped,
      ms,
    });
  }

  // Un solo espacio entre trozos, sin espacios dobles.
  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  // Todo mudo: no se ejecutó el encoder, así que no hay dispositivo que
  // confirmar. Se dice `unconfirmed` en vez de mentir con el que se pidió.
  const device: VoiceTranscriptDevice = ranEncoder ? engine.device : 'unconfirmed';

  return {
    text,
    durationSec,
    capped,
    ms: now() - started,
    device,
    ...(engine.warning !== undefined ? { warning: engine.warning } : {}),
    chunks,
  };
}

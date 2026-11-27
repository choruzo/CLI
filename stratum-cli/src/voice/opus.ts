/**
 * M25 fase 3 — de los bytes de una nota de voz de Telegram (OGG/Opus) a PCM.
 *
 * El decodificador es WASM (`ogg-opus-decoder`): sin `ffmpeg`, sin binarios
 * nativos y sin tocar el disco. Opus decodifica siempre a 48 kHz.
 *
 * La decodificación es **incremental y acotada**: el OGG entra a trozos, cada
 * trozo se decodifica y se mezcla a mono en el momento, y en cuanto lo
 * acumulado pasa del tope se corta y se rechaza la nota. Así una nota de una
 * hora no llega nunca a reservar el PCM de una hora: como mucho ~301 s.
 *
 * El audio **solo vive en memoria**: no se escribe en ningún sitio, y el
 * decodificador se libera siempre, también cuando el fichero viene roto, la
 * nota se pasa de duración o alguien aborta a mitad.
 */

import { OggOpusDecoder } from 'ogg-opus-decoder';
import { VOICE_MAX_SECONDS, VoiceTooLongError } from './transcribe.js';

/** Los bytes no eran un OGG/Opus que se pueda decodificar, o no salió audio. */
export class VoiceDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceDecodeError';
  }
}

/** Lo que sale de decodificar: PCM mono y su frecuencia (48 kHz). */
export interface DecodedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

/** Las frecuencias que se admiten: la de Opus (48 kHz) y la del modelo (16 kHz). */
const ALLOWED_SAMPLE_RATES: readonly number[] = [48_000, 16_000];

/**
 * Lo que se le pasa al decodificador de una vez: un trozo del OGG. Pequeño a
 * propósito: el PCM temporal de un trozo (antes de mezclarlo) crece con él. A
 * 6 kbit/s, 16 KiB son ~22 s, unos 8 MB en estéreo como mucho.
 */
export const DECODE_CHUNK_BYTES = 16 * 1024;

/** Canales que se admiten: una nota de voz es mono; estéreo se mezcla. */
export const OGG_OPUS_MAX_CHANNELS = 2;

/**
 * Tamaño máximo de un paquete Opus. El mayor posible son 120 ms con 48 tramas
 * de 1 275 bytes (~61 KB): con 64 KiB no se rechaza nada legítimo, y un paquete
 * «continuado» por muchas páginas no llega a acumularse en el parser.
 */
export const OGG_OPUS_MAX_PACKET_BYTES = 64 * 1024;

/** Lo que se sabe de un OGG/Opus **antes** de decodificarlo. */
export interface OggOpusInfo {
  channels: number;
  /** Muestras a 48 kHz que dan **los paquetes** (por su TOC), menos el pre-skip. */
  samples: number;
  /** Lo mismo, en segundos. */
  seconds: number;
  /**
   * Dónde cortar el OGG para el decodificador: finales de página, de forma que
   * cada trozo lleve como mucho `DECODE_SLICE_SECONDS` de audio (más una página).
   */
  slices: number[];
}

/** Audio que se le pasa al decodificador de una vez, cortando por páginas. */
export const DECODE_SLICE_SECONDS = 10;

/** Un paquete Opus no dura más de 120 ms (RFC 6716 §3.2.5). */
const OPUS_MAX_PACKET_SAMPLES = 5_760;

/**
 * Muestras a 48 kHz de un paquete Opus, por su byte TOC (RFC 6716 §3.1). Un
 * paquete vacío (0 bytes) es una pérdida y no suma.
 *
 * @throws VoiceDecodeError si el paquete está mal formado o pasa de 120 ms.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  // Tamaño de trama en muestras a 48 kHz: SILK (0–11), híbrido (12–15), CELT (16–31).
  const frame =
    config < 12
      ? [480, 960, 1_920, 2_880][config % 4]!
      : config < 16
        ? [480, 960][config % 2]!
        : [120, 240, 480, 960][config % 4]!;
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2)
      throw new VoiceDecodeError('paquete Opus de código 3 sin cuenta de tramas');
    frames = packet[1]! & 0x3f;
    if (frames === 0) throw new VoiceDecodeError('paquete Opus con 0 tramas');
  }
  const samples = frames * frame;
  if (samples > OPUS_MAX_PACKET_SAMPLES) {
    throw new VoiceDecodeError('un paquete Opus pasa de 120 ms');
  }
  return samples;
}

/**
 * Recorre las páginas del OGG **sin decodificar** y comprueba lo que acota el
 * coste de decodificarlo. Un OGG/Opus de una nota de voz es un solo flujo:
 * - páginas `OggS` (versión 0) seguidas hasta el final, sin basura, con un solo
 *   serial y números de página consecutivos;
 * - la primera página, y solo ella, lleva BOS, y trae **sola y entera** la
 *   cabecera `OpusHead` (como manda RFC 7845), con 1 o 2 canales;
 * - la segunda cabecera es `OpusTags`;
 * - EOS, si lo hay, solo en la última página;
 * - la marca de continuación de cada página cuadra con si la anterior dejó un
 *   paquete a medias, y ningún paquete queda abierto al final;
 * - ningún paquete pasa de `OGG_OPUS_MAX_PACKET_BYTES` ni de 120 ms.
 *
 * La duración sale de **los propios paquetes** (su TOC), no del `granule` que
 * declara el fichero: así el audio que el decodificador va a producir queda
 * acotado aunque el fichero mienta.
 *
 * @throws VoiceDecodeError si algo de eso no cuadra.
 */
export function inspectOggOpus(bytes: Uint8Array): OggOpusInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let pageIndex = 0;
  let serial = 0;
  let sequence = 0;
  let sawEos = false;
  let channels = 0;
  let preSkip = 0;
  /** Paquetes completos vistos: 0 = `OpusHead`, 1 = `OpusTags`, el resto, audio. */
  let packets = 0;
  /** Trozos del paquete en curso (puede venir de páginas anteriores). */
  let parts: Uint8Array[] = [];
  let partBytes = 0;
  let samples = 0;
  let sliceStartSamples = 0;
  const slices: number[] = [];

  const finishPacket = (): void => {
    const packet =
      parts.length === 1
        ? parts[0]!
        : (() => {
            const joined = new Uint8Array(partBytes);
            let at = 0;
            for (const part of parts) {
              joined.set(part, at);
              at += part.length;
            }
            return joined;
          })();
    if (packets === 0) {
      if (packet.length < 19 || new TextDecoder().decode(packet.subarray(0, 8)) !== 'OpusHead') {
        throw new VoiceDecodeError('el OGG no empieza por una cabecera Opus');
      }
      if (packet[8] !== 1) throw new VoiceDecodeError('versión de OpusHead desconocida');
      channels = packet[9]!;
      preSkip = packet[10]! | (packet[11]! << 8);
      if (channels < 1 || channels > OGG_OPUS_MAX_CHANNELS) {
        throw new VoiceDecodeError(
          `la nota tiene ${channels} canales y solo se admiten ${OGG_OPUS_MAX_CHANNELS}`,
        );
      }
    } else if (packets === 1) {
      if (packet.length < 8 || new TextDecoder().decode(packet.subarray(0, 8)) !== 'OpusTags') {
        throw new VoiceDecodeError('al OGG le falta la cabecera OpusTags');
      }
    } else {
      // RFC 7845 §3: un paquete de audio de 0 bytes es malformado.
      if (packet.length === 0) throw new VoiceDecodeError('el OGG trae un paquete de audio vacío');
      samples += opusPacketSamples(packet);
    }
    packets++;
    parts = [];
    partBytes = 0;
  };

  while (offset < bytes.length) {
    if (
      offset + 27 > bytes.length ||
      bytes[offset] !== 0x4f || // O
      bytes[offset + 1] !== 0x67 || // g
      bytes[offset + 2] !== 0x67 || // g
      bytes[offset + 3] !== 0x53 // S
    ) {
      throw new VoiceDecodeError(`no es un OGG válido (sin página en el byte ${offset})`);
    }
    if (bytes[offset + 4] !== 0) throw new VoiceDecodeError('versión de OGG desconocida');
    if (sawEos) throw new VoiceDecodeError('el OGG sigue después de su página final (EOS)');
    const flags = bytes[offset + 5]!;
    const continued = (flags & 0x01) !== 0;
    const bos = (flags & 0x02) !== 0;
    const eos = (flags & 0x04) !== 0;
    const pageSerial = view.getUint32(offset + 14, true);
    const pageSequence = view.getUint32(offset + 18, true);
    if (pageIndex === 0) {
      if (!bos) throw new VoiceDecodeError('la primera página del OGG no lleva BOS');
      serial = pageSerial;
    } else {
      if (bos) throw new VoiceDecodeError('el OGG trae más de un flujo: no es una nota de voz');
      if (pageSerial !== serial) {
        throw new VoiceDecodeError('el OGG trae más de un flujo: no es una nota de voz');
      }
      if (pageSequence !== sequence + 1) {
        throw new VoiceDecodeError('faltan o sobran páginas en el OGG');
      }
    }
    sequence = pageSequence;
    // La continuación tiene que cuadrar con lo que dejó la página anterior.
    if (continued !== partBytes > 0 || (pageIndex === 0 && continued)) {
      throw new VoiceDecodeError('la continuación de las páginas del OGG no cuadra');
    }
    const segments = bytes[offset + 26]!;
    const tableEnd = offset + 27 + segments;
    if (tableEnd > bytes.length) throw new VoiceDecodeError('página de OGG cortada');
    let body = tableEnd;
    for (let i = 0; i < segments; i++) {
      const lacing = bytes[offset + 27 + i]!;
      if (body + lacing > bytes.length) throw new VoiceDecodeError('página de OGG cortada');
      partBytes += lacing;
      if (partBytes > OGG_OPUS_MAX_PACKET_BYTES) {
        throw new VoiceDecodeError(`un paquete del OGG pasa de ${OGG_OPUS_MAX_PACKET_BYTES} bytes`);
      }
      parts.push(bytes.subarray(body, body + lacing));
      body += lacing;
      if (lacing < 255) finishPacket();
    }
    // `OpusHead` va sola y entera en la primera página.
    if (pageIndex === 0 && (packets !== 1 || partBytes > 0)) {
      throw new VoiceDecodeError('la primera página del OGG tiene que traer solo OpusHead');
    }
    // Y `OpusTags`, sola y entera en la segunda: el decodificador (`codec-parser`)
    // reconoce las cabeceras por número de página y lee como audio todo lo que
    // viene a partir de la tercera.
    if (pageIndex === 1 && (packets !== 2 || partBytes > 0)) {
      throw new VoiceDecodeError('la segunda página del OGG tiene que traer solo OpusTags');
    }
    if (eos) sawEos = true;
    offset = body;
    pageIndex++;
    // Se corta por páginas: cada trozo, como mucho ~10 s de audio (más una página).
    if (samples - sliceStartSamples >= DECODE_SLICE_SECONDS * 48_000) {
      slices.push(offset);
      sliceStartSamples = samples;
    }
  }
  if (packets === 0) throw new VoiceDecodeError('el OGG no trae cabecera Opus');
  if (packets === 1) throw new VoiceDecodeError('al OGG le falta la cabecera OpusTags');
  if (partBytes > 0) throw new VoiceDecodeError('el OGG acaba con un paquete a medias');
  if (slices.at(-1) !== bytes.length) slices.push(bytes.length);
  const net = Math.max(0, samples - preSkip);
  return { channels, samples: net, seconds: net / 48_000, slices };
}

/** Lo que devuelve el decodificador en cada trozo (`ogg-opus-decoder`). */
export interface DecodedChunk {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
  errors: readonly { message?: string }[];
}

/**
 * Lo mínimo del decodificador que se usa. Sus tipos dicen que `decode` es
 * síncrono, pero en la 1.7.5 devuelve una promesa: se acepta lo uno y lo otro.
 */
export interface OggOpusDecoderPort {
  ready: Promise<void>;
  decode(data: Uint8Array): DecodedChunk | Promise<DecodedChunk>;
  flush(): DecodedChunk | Promise<DecodedChunk>;
  free(): void;
}

export interface DecodeOggOpusOptions {
  /** Tope de duración (300 s por defecto). Se corta ~1 s por encima. */
  maxSeconds?: number;
  /** Cómo se crea el decodificador. Los tests pasan uno falso para contar trozos. */
  createDecoder?: () => OggOpusDecoderPort;
  /**
   * Recorrer las páginas antes de decodificar (`inspectOggOpus`). Solo los tests
   * con un decodificador falso, que no llevan un OGG de verdad, lo apagan.
   */
  inspect?: boolean;
}

/** Todo lo que decodifique una nota; los tests pasan uno falso. */
export type DecodeOggOpus = (
  bytes: Uint8Array,
  opts?: DecodeOggOpusOptions,
) => Promise<DecodedAudio>;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultDecoder(): OggOpusDecoderPort {
  return new OggOpusDecoder({ forceStereo: false });
}

/**
 * El PCM mono, creciendo por duplicación y **nunca** por encima del tope: lo
 * que no cabe se descarta, y quien llama corta en cuanto pasa algo.
 */
class MonoBuffer {
  private buffer = new Float32Array(0);
  private length = 0;

  constructor(private readonly capacity: number) {}

  get samples(): number {
    return this.length;
  }

  /**
   * Mezcla los canales a mono (la media) **directamente** en el búfer, sin un
   * intermedio del tamaño del trozo.
   *
   * @returns cuántas muestras no cupieron (0 si entró todo).
   */
  pushMixed(channels: readonly Float32Array[], frames: number): number {
    const room = Math.max(0, this.capacity - this.length);
    const take = Math.min(frames, room);
    if (take > 0) {
      this.grow(this.length + take);
      const base = this.length;
      const only = channels[0];
      if (channels.length === 1 && only) {
        this.buffer.set(only.subarray(0, take), base);
      } else {
        for (let i = 0; i < take; i++) {
          let sum = 0;
          for (const channel of channels) sum += channel[i] ?? 0;
          this.buffer[base + i] = sum / channels.length;
        }
      }
      this.length += take;
    }
    return frames - take;
  }

  /** Lo decodificado, sin copia: una vista del búfer. */
  toFloat32Array(): Float32Array {
    return this.buffer.subarray(0, this.length);
  }

  private grow(wanted: number): void {
    if (wanted <= this.buffer.length) return;
    // Se duplica (amortizado) pero sin pasar del tope: nada de reservar de más.
    let size = Math.max(this.buffer.length * 2, 64 * 1024);
    while (size < wanted) size *= 2;
    const next = new Float32Array(Math.min(size, this.capacity));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
}

/**
 * Decodifica una nota de voz OGG/Opus, por trozos y con tope de duración.
 *
 * Con varios canales los mezcla en mono (la media): el modelo solo entiende
 * uno. Una nota de voz de Telegram es mono, pero un fichero de fuera puede no
 * serlo.
 *
 * @throws VoiceDecodeError si el decodificador da errores, la frecuencia no es
 *   48 kHz ni 16 kHz, o no sale ninguna muestra.
 * @throws VoiceTooLongError si pasa de `maxSeconds` (se corta a mitad, sin
 *   decodificar el resto).
 */
export async function decodeOggOpus(
  bytes: Uint8Array,
  opts: DecodeOggOpusOptions = {},
): Promise<DecodedAudio> {
  const maxSeconds = opts.maxSeconds ?? VOICE_MAX_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new VoiceDecodeError(`maxSeconds tiene que ser > 0 (llegó ${maxSeconds})`);
  }
  // Antes de crear el decodificador: canales, paquetes y duración declarada.
  // Un primer paquete cortado (el que tiene que ser la cabecera) no pasa.
  let slices: number[] | undefined;
  if (opts.inspect !== false) {
    const info = inspectOggOpus(bytes);
    if (info.seconds > maxSeconds + 1) {
      throw new VoiceTooLongError(
        `la nota dura ${Math.round(info.seconds)} s y el máximo son ${maxSeconds} s`,
        info.seconds,
      );
    }
    slices = info.slices;
  }
  const decoder = (opts.createDecoder ?? defaultDecoder)();
  try {
    await decoder.ready;
    let sampleRate: number | undefined;
    let mono: MonoBuffer | undefined;

    // Un segundo de margen sobre el tope: así una nota de 300 s justos entra y
    // una de 301 no llega a reservarse entera.
    const absorb = (chunk: DecodedChunk): void => {
      if (chunk.errors.length > 0) {
        const first = chunk.errors[0];
        throw new VoiceDecodeError(
          `el decodificador de Opus dio ${chunk.errors.length} error(es): ${first?.message ?? 'sin detalle'}`,
        );
      }
      if (chunk.channelData.length === 0 || chunk.samplesDecoded === 0) return;
      if (sampleRate === undefined) {
        if (!ALLOWED_SAMPLE_RATES.includes(chunk.sampleRate)) {
          throw new VoiceDecodeError(
            `el audio viene a ${chunk.sampleRate} Hz y solo se admite 48 kHz o 16 kHz`,
          );
        }
        sampleRate = chunk.sampleRate;
        mono ??= new MonoBuffer(Math.round(maxSeconds * sampleRate) + sampleRate);
      } else if (chunk.sampleRate !== sampleRate) {
        throw new VoiceDecodeError('el audio cambia de frecuencia a mitad de la nota');
      }
      if (chunk.channelData.length > OGG_OPUS_MAX_CHANNELS) {
        throw new VoiceDecodeError(`el decodificador dio ${chunk.channelData.length} canales`);
      }
      // Canales de distinta longitud serían audio perdido al mezclar: no se admite.
      if (chunk.channelData.some((channel) => channel.length !== chunk.samplesDecoded)) {
        throw new VoiceDecodeError('el decodificador dio canales de distinta longitud');
      }
      const frames = chunk.samplesDecoded;
      if (!mono) return;
      if (mono.pushMixed(chunk.channelData, frames) > 0) {
        // Se para aquí: el resto del OGG no se decodifica.
        throw new VoiceTooLongError(
          `la nota pasa de ${maxSeconds} s; no se decodifica entera`,
          maxSeconds,
        );
      }
    };

    // Con el OGG inspeccionado, se corta por páginas (~10 s de audio por trozo);
    // sin él (solo los tests con un decodificador falso), por bytes.
    const ends: number[] = slices ?? [];
    if (!slices) {
      for (let at = DECODE_CHUNK_BYTES; at < bytes.length; at += DECODE_CHUNK_BYTES) ends.push(at);
      ends.push(bytes.length);
    }
    let from = 0;
    for (const end of ends) {
      if (end <= from) continue;
      absorb(await decoder.decode(bytes.subarray(from, end)));
      from = end;
    }
    // Lo que el decodificador guarde para el final (la última página).
    absorb(await decoder.flush());

    if (!mono || !sampleRate || mono.samples === 0) {
      throw new VoiceDecodeError('la nota de voz no tiene audio');
    }
    return { pcm: mono.toFloat32Array(), sampleRate };
  } catch (err) {
    if (err instanceof VoiceDecodeError || err instanceof VoiceTooLongError) throw err;
    // Un fallo del WASM se cuenta como nota ilegible, nunca se deja pasar crudo.
    throw new VoiceDecodeError(`el decodificador de Opus falló: ${reasonOf(err)}`);
  } finally {
    // Siempre, también si la nota se pasó de larga o venía rota: si no, el WASM
    // se queda cargado.
    decoder.free();
  }
}

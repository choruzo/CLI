import { describe, expect, it } from 'vitest';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { MONO_2S_OGG, STEREO_2S_OGG } from './__fixtures__/ogg-opus.js';
import {
  DECODE_CHUNK_BYTES,
  decodeOggOpus,
  inspectOggOpus,
  VoiceDecodeError,
  type DecodedChunk,
  type OggOpusDecoderPort,
} from './opus.js';
import { VoiceTooLongError } from './transcribe.js';

/**
 * M25 fase 3 — la decodificación de OGG/Opus (`opus.ts`), con el WASM de verdad.
 *
 * Los dos OGG de `__fixtures__/ogg-opus.ts` son notas reales de 2 s: una mono y
 * otra estéreo. Lo que se fija aquí es el contrato: se decodifica **entera**,
 * sale **mono**, y una nota que pasa del tope se corta a mitad sin llegar a
 * decodificarla (nunca se reserva el PCM de una hora).
 */

/** Un decodificador falso que cuenta los trozos y devuelve lo que se le diga. */
class FakeDecoder implements OggOpusDecoderPort {
  readonly ready = Promise.resolve();
  received = 0;
  flushed = false;
  freed = false;

  constructor(private readonly chunk: (n: number) => DecodedChunk | undefined) {}

  decode(): DecodedChunk {
    this.received++;
    return this.chunk(this.received) ?? empty();
  }

  flush(): DecodedChunk {
    this.flushed = true;
    return empty();
  }

  free(): void {
    this.freed = true;
  }
}

function empty(): DecodedChunk {
  return { channelData: [], samplesDecoded: 0, sampleRate: 48_000, errors: [] };
}

/** PCM de `seconds` segundos, en un solo canal, como lo daría el decodificador. */
function chunkOf(channels: Float32Array[], sampleRate = 48_000): DecodedChunk {
  return {
    channelData: channels,
    samplesDecoded: channels[0]?.length ?? 0,
    sampleRate,
    errors: [],
  };
}

describe('decodeOggOpus', () => {
  it('una nota de 2 s se decodifica entera, a 48 kHz y en mono', async () => {
    const decoded = await decodeOggOpus(MONO_2S_OGG);
    expect(decoded.sampleRate).toBe(48_000);
    // 2 s exactos, con el margen de las muestras de pre-skip del códec.
    expect(decoded.pcm.length / decoded.sampleRate).toBeCloseTo(2, 1);
    expect(decoded.pcm.some((sample) => sample !== 0)).toBe(true);
  });

  it('con varios canales sale mono: la media de los canales', async () => {
    const decoded = await decodeOggOpus(STEREO_2S_OGG);
    // La referencia: el mismo fichero decodificado de una vez, con sus canales.
    const raw = new OggOpusDecoder({ forceStereo: false });
    await raw.ready;
    const full = await raw.decodeFile(STEREO_2S_OGG);
    raw.free();

    expect(full.channelData).toHaveLength(2);
    expect(decoded.pcm).toHaveLength(full.samplesDecoded);
    const [left, right] = full.channelData as [Float32Array, Float32Array];
    for (const i of [1_000, 20_000, 50_000, 90_000]) {
      expect(decoded.pcm[i]!).toBeCloseTo(((left[i] ?? 0) + (right[i] ?? 0)) / 2, 6);
    }
    // Y de verdad es mono (una muestra por instante), no dos entreverados.
    expect(decoded.pcm.length).toBeLessThan((left.length + right.length) * 0.6);
  });

  it('la mezcla a mono es la media exacta de los canales', async () => {
    const decoder = new FakeDecoder(() =>
      chunkOf([new Float32Array([1, -1, 0.5]), new Float32Array([0.5, 0.5, -0.5])]),
    );
    const decoded = await decodeOggOpus(new Uint8Array(DECODE_CHUNK_BYTES), {
      createDecoder: () => decoder,
      inspect: false,
    });
    expect(Array.from(decoded.pcm)).toEqual([0.75, -0.25, 0]);
  });

  it('más de 301 s se corta a mitad: el resto del OGG no se decodifica', async () => {
    // 40 trozos de OGG, y cada trozo «decodifica» 60 s: el tope (301 s) se pasa
    // en el sexto, así que los otros 34 no llegan a mirarse.
    const chunks = 40;
    const chunk = chunkOf([new Float32Array(60 * 16_000)], 16_000);
    const decoder = new FakeDecoder(() => chunk);
    const ogg = new Uint8Array(chunks * DECODE_CHUNK_BYTES);

    await expect(
      decodeOggOpus(ogg, { createDecoder: () => decoder, inspect: false }),
    ).rejects.toBeInstanceOf(VoiceTooLongError);
    // 5 trozos (300 s) caben en el tope de 301 s; el 6.º lo pasa y ahí se para.
    expect(decoder.received).toBe(6);
    // Se suelta el trozo que se estaba mezclando y no se llega al `flush`.
    expect(decoder.flushed).toBe(false);
    expect(decoder.freed).toBe(true);
  });

  it('300 s justos entran; un segundo más, no', async () => {
    const second = chunkOf([new Float32Array(16_000)], 16_000);
    const cap = new FakeDecoder(() => second);
    // 300 trozos de 1 s: 300 s caben en el tope + el segundo de margen.
    const decoded = await decodeOggOpus(new Uint8Array(300 * DECODE_CHUNK_BYTES), {
      createDecoder: () => cap,
      inspect: false,
    });
    expect(decoded.pcm.length).toBe(300 * 16_000);
  });

  it('una frecuencia que no es 48 kHz ni 16 kHz se rechaza', async () => {
    const decoder = new FakeDecoder(() => chunkOf([new Float32Array(100)], 44_100));
    await expect(
      decodeOggOpus(new Uint8Array(16), { createDecoder: () => decoder, inspect: false }),
    ).rejects.toBeInstanceOf(VoiceDecodeError);
  });

  it('unos bytes vacíos no son una nota: VoiceDecodeError', async () => {
    await expect(decodeOggOpus(new Uint8Array())).rejects.toBeInstanceOf(VoiceDecodeError);
  });

  it('lo que no es OGG/Opus tampoco: VoiceDecodeError', async () => {
    const garbage = new TextEncoder().encode('esto no es un ogg opus, ni de lejos');
    await expect(decodeOggOpus(garbage)).rejects.toBeInstanceOf(VoiceDecodeError);
  });

  it('el mensaje del error no lleva el audio ni su tamaño', async () => {
    const error = await decodeOggOpus(new Uint8Array([1, 2, 3, 4])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceDecodeError);
    expect((error as Error).message).not.toMatch(/[0-9a-f]{16}/);
  });

  it('el decodificador se libera también cuando los bytes vienen rotos', async () => {
    const decoder = new FakeDecoder(() => ({
      ...empty(),
      errors: [{ message: 'página rota' }],
    }));
    await expect(
      decodeOggOpus(new Uint8Array(DECODE_CHUNK_BYTES), {
        createDecoder: () => decoder,
        inspect: false,
      }),
    ).rejects.toBeInstanceOf(VoiceDecodeError);
    expect(decoder.freed).toBe(true);
  });
});

/** Copia de un OGG con la cabecera de su primera página cambiada. */
function patched(ogg: Uint8Array, change: (copy: Uint8Array) => void): Uint8Array {
  const copy = new Uint8Array(ogg);
  change(copy);
  return copy;
}

/** Byte donde empieza el cuerpo de la primera página (la de `OpusHead`). */
function firstBody(ogg: Uint8Array): number {
  return 27 + ogg[26]!;
}

/** Offset de la última página (la última aparición de `OggS`). */
function lastPage(ogg: Uint8Array): number {
  for (let i = ogg.length - 4; i >= 0; i--) {
    if (ogg[i] === 0x4f && ogg[i + 1] === 0x67 && ogg[i + 2] === 0x67 && ogg[i + 3] === 0x53) {
      return i;
    }
  }
  throw new Error('sin páginas');
}

describe('inspectOggOpus: lo que acota la decodificación, antes de decodificar', () => {
  it('lee los canales y la duración de una nota de verdad (por sus paquetes)', () => {
    const info = inspectOggOpus(MONO_2S_OGG);
    expect(info.channels).toBe(1);
    expect(info.seconds).toBeCloseTo(2, 1);
    expect(info.slices.at(-1)).toBe(MONO_2S_OGG.length);
    expect(inspectOggOpus(STEREO_2S_OGG).channels).toBe(2);
  });

  it('más de 2 canales se rechaza sin crear el decodificador', async () => {
    const ogg = patched(MONO_2S_OGG, (copy) => {
      copy[firstBody(copy) + 9] = 255;
    });
    let created = false;
    await expect(
      decodeOggOpus(ogg, {
        createDecoder: () => {
          created = true;
          return new FakeDecoder(() => undefined);
        },
      }),
    ).rejects.toThrow(/255 canales/);
    expect(created).toBe(false);
  });

  it('la duración sale de los paquetes: un granule que miente no cambia nada', async () => {
    const ogg = patched(MONO_2S_OGG, (copy) => {
      const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
      view.setBigInt64(lastPage(copy) + 6, BigInt(48_000 * 3600), true);
    });
    expect(inspectOggOpus(ogg).seconds).toBeCloseTo(2, 1);
  });

  it('más de 301 s **de paquetes** se rechaza sin crear el decodificador', async () => {
    // 21 páginas de 255 paquetes de 60 ms (TOC config 3, código 0): ~321 s.
    const pages = Array.from({ length: 21 }, (_, i) =>
      oggPage(
        serialOf(MONO_2S_OGG),
        2 + i,
        Array.from({ length: 255 }, () => new Uint8Array([3 << 3])),
      ),
    );
    const ogg = concat([headerPages(MONO_2S_OGG), ...pages]);
    expect(inspectOggOpus(ogg).seconds).toBeGreaterThan(301);
    let created = false;
    await expect(
      decodeOggOpus(ogg, {
        createDecoder: () => {
          created = true;
          return new FakeDecoder(() => undefined);
        },
      }),
    ).rejects.toBeInstanceOf(VoiceTooLongError);
    expect(created).toBe(false);
  });

  it('OpusTags repartida en dos páginas se rechaza (el decodificador no la entendería)', () => {
    const serial = serialOf(MONO_2S_OGG);
    const first = MONO_2S_OGG.subarray(0, 27 + MONO_2S_OGG[26]! + MONO_2S_OGG[27]!);
    const tags = new Uint8Array(300);
    tags.set(new TextEncoder().encode('OpusTags'), 0);
    // 255 en la página 1 (sin cerrar) y 45 en la 2.
    const p1 = concat([oggPage(serial, 1, [], 0, [255]).subarray(0, 28), tags.subarray(0, 255)]);
    const p2 = concat([oggPage(serial, 2, [], 0x01, [45]).subarray(0, 28), tags.subarray(255)]);
    expect(() => inspectOggOpus(concat([first, p1, p2]))).toThrow(/segunda página/);
  });

  it('un paquete de audio de 0 bytes es malformado (RFC 7845 §3)', () => {
    const page = oggPage(serialOf(MONO_2S_OGG), 2, [new Uint8Array(0)]);
    expect(() => inspectOggOpus(concat([headerPages(MONO_2S_OGG), page]))).toThrow(/vacío/);
  });

  it('un paquete Opus de más de 120 ms se rechaza (TOC)', () => {
    // Código 3 con 48 tramas de 20 ms = 960 ms.
    const page = oggPage(serialOf(MONO_2S_OGG), 2, [new Uint8Array([(1 << 3) | 3, 48])]);
    expect(() => inspectOggOpus(concat([headerPages(MONO_2S_OGG), page]))).toThrow(/120 ms/);
  });

  it('estructura del flujo: BOS solo al principio, nada tras EOS, páginas seguidas', () => {
    const serial = serialOf(MONO_2S_OGG);
    const audio = [new Uint8Array([3 << 3])];
    const head = headerPages(MONO_2S_OGG);
    // Otra página con BOS (un segundo flujo encadenado).
    expect(() => inspectOggOpus(concat([head, oggPage(serial, 2, audio, 0x02)]))).toThrow(
      /más de un flujo/,
    );
    // Algo después de una página con EOS.
    expect(() =>
      inspectOggOpus(concat([head, oggPage(serial, 2, audio, 0x04), oggPage(serial, 3, audio)])),
    ).toThrow(/EOS/);
    // Un salto en el número de página.
    expect(() => inspectOggOpus(concat([head, oggPage(serial, 5, audio)]))).toThrow(/páginas/);
    // Marca de continuación sin paquete abierto.
    expect(() => inspectOggOpus(concat([head, oggPage(serial, 2, audio, 0x01)]))).toThrow(
      /continuación/,
    );
    // Un paquete abierto al final del fichero.
    const open = oggPage(serial, 2, [], 0, [255]);
    expect(() => inspectOggOpus(concat([head, open]))).toThrow(/a medias|cortada/);
  });

  it('basura delante, detrás o una página cortada: VoiceDecodeError', () => {
    expect(() => inspectOggOpus(new Uint8Array([1, 2, 3, ...MONO_2S_OGG]))).toThrow(
      VoiceDecodeError,
    );
    expect(() => inspectOggOpus(new Uint8Array([...MONO_2S_OGG, 1, 2, 3]))).toThrow(
      VoiceDecodeError,
    );
    expect(() => inspectOggOpus(MONO_2S_OGG.subarray(0, MONO_2S_OGG.length - 5))).toThrow(
      VoiceDecodeError,
    );
  });

  it('un segundo flujo (otro serial) se rechaza', () => {
    const ogg = patched(MONO_2S_OGG, (copy) => {
      const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
      view.setUint32(lastPage(copy) + 14, 0xdeadbeef, true);
    });
    expect(() => inspectOggOpus(ogg)).toThrow(/más de un flujo/);
  });

  it('un paquete enorme (continuado por muchas páginas) se rechaza', () => {
    const serial = serialOf(MONO_2S_OGG);
    // Páginas de 255 segmentos de 255 bytes que nunca cierran el paquete.
    const lacing = Array.from({ length: 255 }, () => 255);
    const first = oggPage(serial, 2, [], 0, lacing);
    const second = oggPage(serial, 3, [], 0x01, lacing);
    expect(() => inspectOggOpus(concat([headerPages(MONO_2S_OGG), first, second]))).toThrow(
      /paquete/,
    );
  });

  it('canales de distinta longitud del decodificador: VoiceDecodeError (no se pierde audio callado)', async () => {
    const decoder = new FakeDecoder(() => ({
      channelData: [new Float32Array(10), new Float32Array(7)],
      samplesDecoded: 10,
      sampleRate: 48_000,
      errors: [],
    }));
    await expect(
      decodeOggOpus(new Uint8Array(16), { createDecoder: () => decoder, inspect: false }),
    ).rejects.toThrow(/distinta longitud/);
  });
});

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function serialOf(ogg: Uint8Array): number {
  return new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength).getUint32(14, true);
}

/** Las dos primeras páginas (OpusHead y OpusTags) de una nota de verdad. */
function headerPages(ogg: Uint8Array): Uint8Array {
  let offset = 0;
  for (let page = 0; page < 2; page++) {
    const segments = ogg[offset + 26]!;
    let size = 27 + segments;
    for (let i = 0; i < segments; i++) size += ogg[offset + 27 + i]!;
    offset += size;
  }
  return ogg.subarray(0, offset);
}

/**
 * Una página OGG (sin CRC: el inspector no la mira y estos OGG no se
 * decodifican). Con `lacing`, la tabla de segmentos va tal cual y el cuerpo, a ceros.
 */
function oggPage(
  serial: number,
  sequence: number,
  packets: Uint8Array[],
  flags = 0,
  lacing?: number[],
): Uint8Array {
  const table: number[] = lacing ? [...lacing] : [];
  const bodyParts: Uint8Array[] = [];
  if (!lacing) {
    for (const p of packets) {
      let left = p.length;
      while (left >= 255) {
        table.push(255);
        left -= 255;
      }
      table.push(left);
      bodyParts.push(p);
    }
  } else {
    bodyParts.push(new Uint8Array(lacing.reduce((n, l) => n + l, 0)));
  }
  const head = new Uint8Array(27 + table.length);
  head.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0);
  const view = new DataView(head.buffer);
  view.setBigInt64(6, -1n, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  head[26] = table.length;
  head.set(table, 27);
  return concat([head, ...bodyParts]);
}

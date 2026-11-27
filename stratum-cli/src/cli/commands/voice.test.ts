/**
 * Tests de la parte sin proceso del comando `stratum voice`: lectura del WAV de
 * diagnóstico y formato de la salida.
 */
import { describe, expect, it } from 'vitest';
import { formatDownloadProgress, formatVoiceStatus, readMonoWav16k } from './voice.js';
import { VoiceConfigSchema } from '../../config/schema.js';
import { VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE, VoiceTooLongError } from '../../voice/transcribe.js';

/** Un WAV mínimo, con la cabecera que se le pida. */
function wav(opts: {
  sampleRate?: number;
  channels?: number;
  bits?: number;
  audioFormat?: number;
  data: Buffer;
  dropFmt?: boolean;
  dropData?: boolean;
}): Buffer {
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 16_000;
  const bits = opts.bits ?? 16;
  const audioFormat = opts.audioFormat ?? 1;
  const blockAlign = (channels * bits) / 8;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(audioFormat, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(8 + opts.data.length);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(opts.data.length, 4);
  opts.data.copy(data, 8);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    opts.dropFmt ? Buffer.alloc(0) : fmt,
    opts.dropData ? Buffer.alloc(0) : data,
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Un bloque RIFF: id, tamaño y cuerpo. */
function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Un WAV con `fmt ` y `data`, con el tamaño RIFF cuadrando con el fichero. */
function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Resto del GUID de subtipo de `WAVE_FORMAT_EXTENSIBLE` (PCM/IEEE float). */
const GUID_TAIL = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

/** Un WAV `WAVE_FORMAT_EXTENSIBLE` mono a 16 kHz. */
function extensibleWav(opts: {
  data: Buffer;
  bits?: number;
  subformat?: number;
  guidTail?: Buffer;
}): Buffer {
  const bits = opts.bits ?? 16;
  const blockAlign = bits / 8;
  const guid = Buffer.alloc(16);
  guid.writeUInt16LE(opts.subformat ?? 1, 0);
  (opts.guidTail ?? GUID_TAIL).copy(guid, 2);
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0); // WAVE_FORMAT_EXTENSIBLE
  fmt.writeUInt16LE(1, 2); // canales
  fmt.writeUInt32LE(16_000, 4);
  fmt.writeUInt32LE(16_000 * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bits, 14);
  fmt.writeUInt16LE(22, 16); // cbSize
  fmt.writeUInt16LE(bits, 18); // validBitsPerSample
  fmt.writeUInt32LE(0, 20); // channelMask
  guid.copy(fmt, 24);
  return riff(chunk('fmt ', fmt), chunk('data', opts.data));
}

describe('readMonoWav16k: la cabecera se comprueba entera', () => {
  it('un bloque data truncado es un error, nunca una transcripción a medias', () => {
    const wav = riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(8)));
    // El bloque dice 1000 bytes y al fichero le quedan 8: se rechaza.
    wav.writeUInt32LE(1000, 12 + 24 + 4);
    expect(() => readMonoWav16k(wav)).toThrow(/data" del WAV se sale del RIFF/);
  });

  it('lo que va detrás del final declarado del RIFF no es audio', () => {
    // El RIFF solo cubre "fmt ": el bloque "data" pegado detrás no cuenta.
    const fmtOnly = riff(chunk('fmt ', pcmFmt()));
    const trailing = Buffer.concat([fmtOnly, chunk('data', Buffer.alloc(8))]);
    expect(() => readMonoWav16k(trailing)).toThrow(/falta el bloque "data"/);
  });

  it('se valida el contenedor entero, también lo que va detrás de "data"', () => {
    const good = riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(8)));
    // Un bloque detrás de "data" que se sale del RIFF.
    const bad = riff(
      chunk('fmt ', pcmFmt()),
      chunk('data', Buffer.alloc(8)),
      chunk('LIST', Buffer.alloc(4)),
    );
    bad.writeUInt32LE(100, bad.length - 4 - 4);
    expect(() => readMonoWav16k(bad)).toThrow(/"LIST" del WAV se sale del RIFF/);
    // Una cabecera de bloque a medias al final.
    const partial = riff(
      chunk('fmt ', pcmFmt()),
      chunk('data', Buffer.alloc(8)),
      Buffer.from('LI'),
    );
    expect(() => readMonoWav16k(partial)).toThrow(/cabecera de bloque a medias/);
    // Un bloque impar sin su byte de relleno, que no es el último: el resto queda descuadrado.
    const noPad = riff(
      chunk('fmt ', pcmFmt()),
      chunk('data', Buffer.alloc(8)),
      chunk('odd ', Buffer.alloc(3)),
      chunk('LIST', Buffer.alloc(2)),
    );
    expect(() => readMonoWav16k(noPad)).toThrow(/relleno|se sale del RIFF|a medias/);
    expect(readMonoWav16k(good).length).toBe(4);
  });

  it('dos bloques "fmt " se rechazan: el segundo cambiaría cómo se lee el audio', () => {
    const twice = riff(
      chunk('fmt ', pcmFmt()),
      chunk('data', Buffer.alloc(8)),
      chunk('fmt ', pcmFmt()),
    );
    expect(() => readMonoWav16k(twice)).toThrow(/dos bloques "fmt "/);
  });

  it('un bloque data que no es múltiplo de blockAlign está mal cortado', () => {
    const odd = riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(3)));
    expect(() => readMonoWav16k(odd)).toThrow(/no es múltiplo de blockAlign 2/);
  });

  it('un tamaño RIFF mayor que el fichero es un WAV truncado', () => {
    const wav = riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(8)));
    expect(() => readMonoWav16k(wav.subarray(0, wav.length - 4))).toThrow(/truncado/);
    // Tolerancia si el fichero es más largo (una cola de otro contenedor).
    expect(readMonoWav16k(Buffer.concat([wav, Buffer.from('cola')])).length).toBe(4);
  });

  it('un bloque fmt de menos de 16 bytes es un error', () => {
    const wav = riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(8)));
    wav.writeUInt32LE(14, 12 + 4); // tamaño del bloque "fmt "
    expect(() => readMonoWav16k(wav)).toThrow(/"fmt " del WAV mide 14/);
  });

  it('un blockAlign que no cuadra con canales y bits es un error', () => {
    const fmt = pcmFmt();
    fmt.writeUInt16LE(7, 12); // blockAlign inventado
    expect(() => readMonoWav16k(riff(chunk('fmt ', fmt), chunk('data', Buffer.alloc(8))))).toThrow(
      /blockAlign/,
    );
  });

  it('admite WAVE_FORMAT_EXTENSIBLE con subtipo PCM', () => {
    const data = Buffer.alloc(6);
    data.writeInt16LE(0, 0);
    data.writeInt16LE(16_384, 2);
    data.writeInt16LE(-16_384, 4);
    expect(Array.from(readMonoWav16k(extensibleWav({ data })))).toEqual([0, 0.5, -0.5]);
  });

  it('admite WAVE_FORMAT_EXTENSIBLE con subtipo IEEE float', () => {
    const data = Buffer.alloc(8);
    data.writeFloatLE(0.25, 0);
    data.writeFloatLE(-0.5, 4);
    const wav = extensibleWav({ data, bits: 32, subformat: 3 });
    expect(Array.from(readMonoWav16k(wav))).toEqual([0.25, -0.5]);
  });

  it('rechaza WAVE_FORMAT_EXTENSIBLE con otro GUID o sin cbSize', () => {
    const otro = Buffer.from(GUID_TAIL);
    otro[0] = 0x01; // ya no es el GUID de PCM/float
    expect(() => readMonoWav16k(extensibleWav({ data: Buffer.alloc(4), guidTail: otro }))).toThrow(
      /GUID/,
    );
    // Un subtipo que no es PCM ni float tampoco.
    expect(() =>
      readMonoWav16k(extensibleWav({ data: Buffer.alloc(4), subformat: 0x0055 })),
    ).toThrow(/subtipo/);
    // cbSize por debajo de 22: la extensión no cabe.
    const wav = extensibleWav({ data: Buffer.alloc(4) });
    wav.writeUInt16LE(10, 12 + 8 + 16);
    expect(() => readMonoWav16k(wav)).toThrow(/cbSize/);
  });

  it('un float con NaN o infinito es un error', () => {
    const data = Buffer.alloc(8);
    data.writeFloatLE(0.5, 0);
    data.writeFloatLE(Number.NaN, 4);
    expect(() => readMonoWav16k(wav({ audioFormat: 3, bits: 32, data }))).toThrow(/número finito/);
    const inf = Buffer.alloc(4);
    inf.writeFloatLE(Number.POSITIVE_INFINITY, 0);
    expect(() => readMonoWav16k(wav({ audioFormat: 3, bits: 32, data: inf }))).toThrow(
      /número finito/,
    );
  });

  it('más de 300 s se rechaza antes de reservar el PCM', () => {
    // 300 s de PCM de 16 bits a 16 kHz son 9 600 000 bytes.
    const exactBytes = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2;
    expect(() =>
      readMonoWav16k(riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(exactBytes + 2)))),
    ).toThrow(VoiceTooLongError);
    // Los 300 s justos entran.
    expect(
      readMonoWav16k(riff(chunk('fmt ', pcmFmt()), chunk('data', Buffer.alloc(exactBytes)))).length,
    ).toBe(VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE);
  });
});

/** El cuerpo de un bloque `fmt ` PCM de 16 bits mono a 16 kHz. */
function pcmFmt(): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16_000, 4);
  fmt.writeUInt32LE(32_000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  return fmt;
}

describe('readMonoWav16k', () => {
  it('lee PCM de 16 bits mono a 16 kHz', () => {
    const data = Buffer.alloc(6);
    data.writeInt16LE(0, 0);
    data.writeInt16LE(16_384, 2);
    data.writeInt16LE(-16_384, 4);
    const pcm = readMonoWav16k(wav({ data }));
    expect(Array.from(pcm)).toEqual([0, 0.5, -0.5]);
  });

  it('lee float32 mono a 16 kHz', () => {
    const data = Buffer.alloc(8);
    data.writeFloatLE(0.25, 0);
    data.writeFloatLE(-0.75, 4);
    const pcm = readMonoWav16k(wav({ audioFormat: 3, bits: 32, data }));
    expect(pcm.length).toBe(2);
    expect(pcm[0]).toBeCloseTo(0.25, 6);
    expect(pcm[1]).toBeCloseTo(-0.75, 6);
  });

  it('rechaza lo que no es un WAV', () => {
    expect(() => readMonoWav16k(Buffer.from('esto no es un wav'))).toThrow(/RIFF/);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.write('AVI ', 8, 'ascii');
    expect(() => readMonoWav16k(header)).toThrow(/WAVE/);
  });

  it('rechaza estéreo, otra frecuencia y otros formatos de muestra', () => {
    expect(() => readMonoWav16k(wav({ channels: 2, data: Buffer.alloc(4) }))).toThrow(/mono/);
    expect(() => readMonoWav16k(wav({ sampleRate: 48_000, data: Buffer.alloc(2) }))).toThrow(
      /16 kHz/,
    );
    expect(() => readMonoWav16k(wav({ bits: 8, data: Buffer.alloc(1) }))).toThrow(
      /formato de muestras/,
    );
  });

  it('rechaza un WAV sin bloque fmt o sin datos', () => {
    expect(() => readMonoWav16k(wav({ data: Buffer.alloc(2), dropFmt: true }))).toThrow(/fmt/);
    expect(() => readMonoWav16k(wav({ data: Buffer.alloc(2), dropData: true }))).toThrow(/data/);
  });
});

describe('formatVoiceStatus', () => {
  const config = VoiceConfigSchema.parse({});

  it('enseña el estado, los ficheros que faltan y la config', () => {
    const text = formatVoiceStatus(
      {
        state: 'incomplete',
        files: [{ path: 'vocab.txt', expectedSize: 208_022 }],
      },
      config,
    );
    expect(text).toContain('incompleto (incomplete)');
    expect(text).toContain('vocab.txt');
    expect(text).toContain('falta');
    expect(text).toContain('language=es');
    expect(text).toContain('device=auto');
    expect(text).toContain('idleUnloadMinutes=10');
  });

  it('con --verify, dice si el sha coincide', () => {
    const text = formatVoiceStatus(
      {
        state: 'corrupt',
        files: [
          { path: 'a.onnx', expectedSize: 10, size: 10, sha256Ok: true },
          { path: 'b.onnx', expectedSize: 20, size: 20, sha256Ok: false },
        ],
      },
      VoiceConfigSchema.parse({ enabled: true, device: 'cpu' }),
    );
    expect(text).toContain('sha256 ok');
    expect(text).toContain('sha256 NO coincide');
    expect(text).toContain('enabled=sí');
    expect(text).toContain('device=cpu');
    // Sin comprobar la suma, no se dice nada de ella.
    const unchecked = formatVoiceStatus(
      { state: 'ready', files: [{ path: 'a.onnx', expectedSize: 10, size: 10 }] },
      config,
    );
    expect(unchecked).not.toContain('sha256');
  });
});

describe('formatDownloadProgress', () => {
  it('da MB y porcentaje en una línea', () => {
    expect(formatDownloadProgress(0, 3_966_054_682)).toBe('0 B / 3.7 GB (0.0 %)');
    expect(formatDownloadProgress(1_983_027_341, 3_966_054_682)).toBe('1.8 GB / 3.7 GB (50.0 %)');
  });

  it('con el total a cero no divide entre cero', () => {
    expect(formatDownloadProgress(0, 0)).toBe('0 B / 0 B (0.0 %)');
  });
});

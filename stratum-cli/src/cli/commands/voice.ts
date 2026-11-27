/**
 * M25 (voz) — `stratum voice status|download|remove|transcribe`: el modelo de voz
 * en local, sin daemon ni Telegram (eso es la fase 3).
 *
 * `transcribe` es **diagnóstico**: sirve para comprobar que el modelo, el
 * dispositivo y el troceo funcionan, con un WAV mono de 16 kHz. El audio de las
 * notas de verdad (OGG/Opus) llega en la fase 3 con su decodificador.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { Command } from 'commander';
import { GLOBAL_CONFIG_PATH, readConfigFile, validateConfigLayer } from '../../config/loader.js';
import { VoiceConfigSchema, type VoiceConfig } from '../../config/schema.js';
import {
  downloadVoiceModel,
  formatBytes,
  removeVoiceModel,
  resealVoiceModel,
  voiceModelDir,
  voiceModelStatus,
  VoiceModelBusyError,
  VoiceModelCleanupError,
  VoiceModelDownloadError,
  VoiceModelInUseError,
  VoiceModelIntegrityError,
  VoiceModelManifestError,
  VoiceModelNotReadyError,
  VoiceModelPathError,
  VoiceModelRollbackError,
  VoiceModelSpaceError,
  VOICE_MODEL_MARKER,
  type VoiceModelStatus,
} from '../../voice/model-store.js';
import { VOICE_MODEL_ID, VOICE_MODEL_TOTAL_BYTES } from '../../voice/manifest.js';
import {
  VoiceQueueFullError,
  VoiceRuntimeUnavailableError,
  VoiceTimeoutError,
  VoiceWorkerClient,
  voiceWorkerPath,
  VoiceWorkerCrashedError,
  VoiceWorkerError,
} from '../../voice/client.js';
import { VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE, VoiceTooLongError } from '../../voice/transcribe.js';
import { askLine } from '../readline-prompt.js';

/** La sección `voice` de la config global: es la única que cuenta. */
export function globalVoiceConfig(): VoiceConfig {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return VoiceConfigSchema.parse({});
  return validateConfigLayer(GLOBAL_CONFIG_PATH, readConfigFile(GLOBAL_CONFIG_PATH)).voice;
}

/** Estados del modelo, en castellano para la salida. */
const STATE_LABEL: Record<VoiceModelStatus['state'], string> = {
  missing: 'sin descargar',
  incomplete: 'incompleto',
  outdated: 'de otra versión del manifiesto',
  corrupt: 'dañado',
  ready: 'listo',
};

/** `status`: estado, ficheros y la config efectiva. */
export function formatVoiceStatus(status: VoiceModelStatus, config: VoiceConfig): string {
  const lines = [
    `Modelo de voz ${VOICE_MODEL_ID}: ${STATE_LABEL[status.state]} (${status.state})`,
    `  directorio: ${voiceModelDir()}`,
  ];
  for (const file of status.files) {
    const size = file.size === undefined ? 'falta' : formatBytes(file.size);
    const expected = formatBytes(file.expectedSize);
    const sha =
      file.sha256Ok === undefined ? '' : file.sha256Ok ? '  sha256 ok' : '  sha256 NO coincide';
    lines.push(`  ${file.path.padEnd(24)} ${size} / ${expected}${sha}`);
  }
  lines.push(
    `  config:     enabled=${config.enabled ? 'sí' : 'no'}, language=${config.language}, ` +
      `device=${config.device}, idleUnloadMinutes=${config.idleUnloadMinutes}`,
  );
  return lines.join('\n');
}

/** Una línea de progreso, con MB y porcentaje. */
export function formatDownloadProgress(bytes: number, total: number): string {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return `${formatBytes(bytes)} / ${formatBytes(total)} (${pct.toFixed(1)} %)`;
}

/**
 * Lee un WAV **mono a 16 kHz** en float32. Cualquier otra cosa se rechaza con un
 * motivo claro: no se reescala ni se convierte nada aquí.
 *
 * Se comprueba la cabecera entera antes de reservar un solo byte de PCM: un
 * bloque `data` truncado no puede acabar en una transcripción a medias, y la
 * duración máxima se mira aquí, antes de tocar memoria o de arrancar el worker.
 *
 * @throws {VoiceTooLongError} si el audio pasa de `VOICE_MAX_SECONDS`.
 */
export function readMonoWav16k(buffer: Buffer): Float32Array {
  if (buffer.length < 12) {
    throw new Error(`no es un WAV (la cabecera RIFF son 12 bytes y hay ${buffer.length})`);
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('no es un WAV (falta la cabecera RIFF)');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('no es un WAV (falta "WAVE")');
  }
  // El tamaño RIFF tiene que caber en el fichero. Si el fichero es más largo, se
  // tolera (contenedores que añaden cola); si es más corto, está truncado.
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize + 8 > buffer.length) {
    throw new Error(
      `el WAV está truncado: la cabecera RIFF dice ${riffSize + 8} bytes y el fichero tiene ${buffer.length}`,
    );
  }

  // Los bloques se recorren hasta el final **declarado** del RIFF: lo que el
  // fichero traiga detrás no es audio.
  const riffEnd = riffSize + 8;
  let format: WavFormat | undefined;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > riffEnd - body) {
      throw new Error(
        `el bloque "${id}" del WAV se sale del RIFF ` +
          `(dice ${size} bytes y quedan ${riffEnd - body})`,
      );
    }
    if (id === 'fmt ') {
      if (size < 16) {
        throw new Error(`el bloque "fmt " del WAV mide ${size} bytes: hacen falta al menos 16`);
      }
      // Un segundo "fmt " cambiaría cómo se leen los bytes del "data": no vale.
      if (format) throw new Error('el WAV trae dos bloques "fmt "');
      format = parseWavFormat(buffer, body, size);
    } else if (id === 'data' && dataStart < 0) {
      // Se queda con el primero, pero se sigue recorriendo: el contenedor
      // entero tiene que estar bien formado, no solo hasta el audio.
      dataStart = body;
      dataLength = size;
    }
    // Un bloque impar lleva un byte de relleno. Se tolera que falte solo en el
    // último, que acaba justo en el final del RIFF (hay programas que lo omiten).
    const end = body + size;
    const next = size % 2 === 1 && end === riffEnd ? end : end + (size % 2);
    if (next > riffEnd) {
      throw new Error(`al bloque "${id}" del WAV le falta el byte de relleno dentro del RIFF`);
    }
    offset = next;
  }
  if (offset !== riffEnd) {
    throw new Error(
      `el WAV acaba con una cabecera de bloque a medias (${riffEnd - offset} bytes sueltos)`,
    );
  }
  if (!format) throw new Error('al WAV le falta el bloque "fmt "');
  if (dataStart < 0) throw new Error('al WAV le falta el bloque "data"');

  const isPcm16 = format.audioFormat === WAV_FORMAT_PCM && format.bits === 16;
  const isFloat32 = format.audioFormat === WAV_FORMAT_IEEE_FLOAT && format.bits === 32;
  if (!isPcm16 && !isFloat32) {
    throw new Error(
      `formato de muestras no soportado (audioFormat ${format.audioFormat}, ` +
        `${format.bits} bits): solo PCM de 16 bits o float32`,
    );
  }
  if (format.channels !== 1) {
    throw new Error(`el WAV tiene ${format.channels} canales: solo vale mono`);
  }
  if (format.sampleRate !== VOICE_SAMPLE_RATE) {
    throw new Error(
      `el WAV está a ${format.sampleRate} Hz: solo vale 16 kHz ` + '(conviértelo con ffmpeg antes)',
    );
  }
  const bytesPerSample = format.bits / 8;
  if (format.blockAlign !== format.channels * bytesPerSample) {
    throw new Error(
      `el WAV dice blockAlign ${format.blockAlign} y con ${format.channels} canal(es) ` +
        `de ${format.bits} bits son ${format.channels * bytesPerSample}`,
    );
  }

  // Una trama incompleta al final es un WAV mal cortado: no se tira en silencio.
  if (dataLength % format.blockAlign !== 0) {
    throw new Error(
      `el bloque "data" del WAV mide ${dataLength} bytes, que no es múltiplo de ` +
        `blockAlign ${format.blockAlign}: está mal cortado`,
    );
  }

  // El tope de duración, **antes** de reservar el PCM.
  const seconds = dataLength / format.blockAlign / format.sampleRate;
  if (seconds > VOICE_MAX_SECONDS) {
    throw new VoiceTooLongError(
      `el WAV dura ${seconds.toFixed(1)} s y el máximo son ${VOICE_MAX_SECONDS} s`,
      seconds,
    );
  }

  const samples = dataLength / format.blockAlign;
  const out = new Float32Array(samples);
  if (isPcm16) {
    for (let i = 0; i < samples; i++) {
      out[i] = buffer.readInt16LE(dataStart + i * 2) / 32768;
    }
  } else {
    for (let i = 0; i < samples; i++) {
      const value = buffer.readFloatLE(dataStart + i * 4);
      // Un NaN o un infinito en el PCM envenenaría toda la transcripción.
      if (!Number.isFinite(value)) {
        throw new Error(`la muestra ${i} del WAV no es un número finito (${value})`);
      }
      out[i] = value;
    }
  }
  return out;
}

/**
 * Lo más que puede ocupar un WAV aceptable: 300 s mono a 16 kHz en float32 más
 * 1 MiB de cabeceras y bloques que no son audio. Se mira antes de leerlo.
 */
const MAX_WAV_FILE_BYTES = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 4 + 1024 * 1024;

/** Formatos de muestras de un WAV (`wFormatTag`). */
const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_IEEE_FLOAT = 3;
const WAV_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Resto del GUID de subtipo de `WAVE_FORMAT_EXTENSIBLE`
 * (`xxxxxxxx-0000-0010-8000-00aa00389b71`); los dos primeros bytes son el
 * `wFormatTag` de verdad.
 */
const SUBFORMAT_GUID_TAIL = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bits: number;
}

/**
 * El bloque `fmt `. `WAVE_FORMAT_EXTENSIBLE` no es un formato: lleva el de
 * verdad en un GUID de subtipo, y solo se acepta si ese subtipo es PCM o IEEE
 * float.
 */
function parseWavFormat(buffer: Buffer, body: number, size: number): WavFormat {
  const audioFormat = buffer.readUInt16LE(body);
  const channels = buffer.readUInt16LE(body + 2);
  const sampleRate = buffer.readUInt32LE(body + 4);
  const blockAlign = buffer.readUInt16LE(body + 12);
  const bits = buffer.readUInt16LE(body + 14);
  if (audioFormat !== WAV_FORMAT_EXTENSIBLE) {
    return { audioFormat, channels, sampleRate, blockAlign, bits };
  }
  if (size < 18) {
    throw new Error(`WAVE_FORMAT_EXTENSIBLE sin "cbSize" (el bloque "fmt " mide ${size} bytes)`);
  }
  const cbSize = buffer.readUInt16LE(body + 16);
  if (cbSize < 22 || size < 18 + cbSize) {
    throw new Error(
      `WAVE_FORMAT_EXTENSIBLE con cbSize ${cbSize}: la extensión son 22 bytes como poco ` +
        `(el bloque "fmt " mide ${size})`,
    );
  }
  const subformat = buffer.readUInt16LE(body + 24);
  if (!buffer.subarray(body + 26, body + 40).equals(SUBFORMAT_GUID_TAIL)) {
    throw new Error('WAVE_FORMAT_EXTENSIBLE con un GUID de subtipo que no es PCM ni IEEE float');
  }
  if (subformat !== WAV_FORMAT_PCM && subformat !== WAV_FORMAT_IEEE_FLOAT) {
    throw new Error(
      `WAVE_FORMAT_EXTENSIBLE con subtipo ${subformat}: solo se acepta PCM o IEEE float`,
    );
  }
  return { audioFormat: subformat, channels, sampleRate, blockAlign, bits };
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** Mensaje claro para cada error con nombre del modelo. */
function modelErrorMessage(err: unknown): string | undefined {
  if (err instanceof VoiceModelBusyError) return `Modelo ocupado: ${err.message}`;
  if (err instanceof VoiceModelInUseError) return `Modelo en uso: ${err.message}`;
  if (err instanceof VoiceModelSpaceError) return `Sin espacio: ${err.message}`;
  if (err instanceof VoiceModelIntegrityError) return `Modelo dañado: ${err.message}`;
  if (err instanceof VoiceModelDownloadError) return `La descarga falló: ${err.message}`;
  if (err instanceof VoiceModelNotReadyError) return `Modelo no listo: ${err.message}`;
  if (err instanceof VoiceModelRollbackError) return `No se pudo publicar: ${err.message}`;
  if (err instanceof VoiceModelPathError) return `Ruta no válida: ${err.message}`;
  if (err instanceof VoiceModelManifestError)
    return `Manifiesto del modelo no válido: ${err.message}`;
  if (err instanceof VoiceModelCleanupError) return `No se pudo limpiar: ${err.message}`;
  return undefined;
}

/** Dónde quedó un temporal que no se pudo borrar, si quedó alguno. */
function leftoverOf(err: unknown): string | undefined {
  if (err instanceof VoiceModelCleanupError) return err.path;
  const leftover = (err as { leftover?: unknown } | null)?.leftover;
  return typeof leftover === 'string' ? leftover : undefined;
}

function transcriptionErrorMessage(err: unknown): string | undefined {
  if (err instanceof VoiceTooLongError) return `Audio demasiado largo: ${err.message}`;
  if (err instanceof VoiceQueueFullError) return `Cola llena: ${err.message}`;
  if (err instanceof VoiceTimeoutError) return `Se agotó el plazo: ${err.message}`;
  if (err instanceof VoiceWorkerCrashedError) return `El worker de voz falló: ${err.message}`;
  if (err instanceof VoiceRuntimeUnavailableError) {
    return `Falta onnxruntime-node: ${err.message}`;
  }
  if (err instanceof VoiceWorkerError) {
    if (err.code === 'model_not_ready') return `Modelo no listo: ${err.message}`;
    return `No se pudo transcribir (${err.code}): ${err.message}`;
  }
  return undefined;
}

const voiceStatus = new Command('status')
  .description('Show the local voice model: state, files and the effective voice config')
  .option('--verify', 'compute the SHA-256 of every file (slow: ~4 GB)')
  .option('--json', 'output as JSON')
  .action(async (opts: { verify?: boolean; json?: boolean }) => {
    const config = globalVoiceConfig();
    const status = await voiceModelStatus({ dir: voiceModelDir(), verify: opts.verify });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ dir: voiceModelDir(), ...status, config }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`${formatVoiceStatus(status, config)}\n`);
  });

const voiceDownload = new Command('download')
  .description('Download the voice model (~4 GB, once) into ~/.stratum/models')
  .action(async () => {
    const dir = voiceModelDir();
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.once('SIGINT', onSigint);
    let lastLine = 0;
    let lastText = '';
    try {
      process.stderr.write(
        `Descargando ${VOICE_MODEL_ID} (${formatBytes(VOICE_MODEL_TOTAL_BYTES)})\n`,
      );
      await downloadVoiceModel({
        dir,
        signal: controller.signal,
        onProgress: (p) => {
          const now = Date.now();
          // Un refresco por décima: suficiente para ver el avance sin inundar.
          if (now - lastLine < 100 && p.bytes !== p.total) return;
          const text = formatDownloadProgress(p.bytes, p.total);
          if (text === lastText) return;
          lastLine = now;
          lastText = text;
          process.stderr.write(`\r${text}   `);
        },
      });
      process.stderr.write('\n');
      const status = await voiceModelStatus({ dir });
      process.stdout.write(`${formatVoiceStatus(status, globalVoiceConfig())}\n`);
    } catch (err) {
      process.stderr.write('\n');
      if (controller.signal.aborted) {
        const leftover = leftoverOf(err);
        fail(
          leftover === undefined
            ? 'Descarga cancelada; el modelo a medias se ha borrado.'
            : `Descarga cancelada; el modelo a medias no se pudo borrar: quedó en ${leftover}`,
        );
        return;
      }
      const message = modelErrorMessage(err);
      if (message === undefined) throw err;
      fail(message);
    } finally {
      process.off('SIGINT', onSigint);
    }
  });

async function confirmRemove(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await askLine(
      rl,
      `Esto borra el modelo de voz de ${voiceModelDir()} (${formatBytes(VOICE_MODEL_TOTAL_BYTES)}). ` +
        'Escribe "si" para confirmar: ',
    );
    return answer?.trim().toLowerCase() === 'si';
  } finally {
    rl.close();
  }
}

const voiceRemove = new Command('remove')
  .description('Delete the downloaded voice model')
  .option('--yes', 'do not ask for confirmation')
  .action(async (opts: { yes?: boolean }) => {
    if (!opts.yes && !(await confirmRemove())) {
      process.stderr.write(
        process.stdin.isTTY ? 'Cancelado.\n' : 'Sin terminal no se borra nada; pasa --yes.\n',
      );
      process.exitCode = 1;
      return;
    }
    try {
      const removed = await removeVoiceModel({ dir: voiceModelDir() });
      process.stdout.write(
        removed ? 'Modelo de voz borrado.\n' : 'No había ningún modelo de voz descargado.\n',
      );
    } catch (err) {
      const message = modelErrorMessage(err);
      if (message === undefined) throw err;
      fail(message);
    }
  });

const voiceTranscribe = new Command('transcribe')
  .description('Diagnostic: transcribe a mono 16 kHz WAV file and print the text')
  .argument('<file>', 'WAV file, mono, 16 kHz, PCM 16-bit or float32')
  .action(async (file: string) => {
    const config = globalVoiceConfig();
    let pcm: Float32Array;
    try {
      // Antes de leerlo entero: un WAV de 5 min a 16 kHz en float32 son ~19 MB.
      const size = statSync(file).size;
      if (size > MAX_WAV_FILE_BYTES) {
        throw new VoiceTooLongError(
          `el WAV ocupa ${formatBytes(size)}: más de lo que caben ${VOICE_MAX_SECONDS} s ` +
            'de audio mono a 16 kHz',
        );
      }
      pcm = readMonoWav16k(readFileSync(file));
    } catch (err) {
      // La duración se mira al leer la cabecera, no aquí: el motivo es el mismo
      // que si lo dijera el worker.
      const tooLong =
        err instanceof VoiceTooLongError ? `Audio demasiado largo: ${err.message}` : undefined;
      fail(
        tooLong ?? `No se pudo leer ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!existsSync(voiceWorkerPath())) {
      fail(
        `Falta el worker de voz (${voiceWorkerPath()}). Compila la CLI ("npm run build") ` +
          'o usa el paquete instalado.',
      );
      return;
    }
    if (!config.enabled) {
      process.stderr.write(
        'Aviso: "voice.enabled" está apagado en la config global; esto solo es una prueba.\n',
      );
    }
    const client = new VoiceWorkerClient({
      dir: voiceModelDir(),
      device: config.device,
      language: config.language,
      idleUnloadMinutes: config.idleUnloadMinutes,
    });
    try {
      const transcript = await client.transcribe(pcm);
      process.stdout.write(`${transcript.text}\n`);
      const parts = [
        `dispositivo: ${transcript.device}`,
        `duración: ${transcript.durationSec.toFixed(1)} s`,
        `proceso: ${Math.round(transcript.ms)} ms`,
        `trozos: ${transcript.chunks.length}` +
          ` (${transcript.chunks.filter((c) => c.skipped).length} mudos, ` +
          `${transcript.chunks.filter((c) => c.reason === 'forced').length} forzados)`,
        `recortado: ${transcript.capped ? 'sí' : 'no'}`,
      ];
      if (client.warning) parts.push(`aviso: ${client.warning}`);
      if (transcript.device === 'cpu' && config.device === 'gpu') {
        parts.push('la GPU no se confirmó; se ha transcrito en la CPU');
      }
      process.stderr.write(`${parts.join(' · ')}\n`);
    } catch (err) {
      const message = transcriptionErrorMessage(err);
      if (message === undefined) throw err;
      fail(message);
    } finally {
      client.close();
    }
  });

/**
 * `reseal`: rehace la marca de un modelo ya descargado. **Oculto a propósito**:
 * solo sirve para arreglar la marca de un modelo que se descargó con un formato
 * anterior, sin volver a bajar 4 GB. Verifica las sumas antes de escribir.
 */
const voiceReseal = new Command('reseal')
  .description('Rewrite the marker of an already downloaded model (verifies every SHA-256)')
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const dir = voiceModelDir();
    try {
      const marker = await resealVoiceModel({ dir });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ dir, ...marker }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `Marca de ${VOICE_MODEL_ID} reescrita en ${join(dir, VOICE_MODEL_MARKER)} ` +
          `(${marker.files.length} ficheros con la suma comprobada).\n`,
      );
      process.stdout.write(
        `${formatVoiceStatus(await voiceModelStatus({ dir }), globalVoiceConfig())}\n`,
      );
    } catch (err) {
      const message = modelErrorMessage(err);
      if (message === undefined) throw err;
      fail(message);
    }
  });

export const voiceCommand = new Command('voice')
  .description('Local voice model: download it, check it and transcribe a WAV (M25)')
  .addCommand(voiceStatus)
  .addCommand(voiceDownload)
  .addCommand(voiceRemove)
  .addCommand(voiceTranscribe)
  .addCommand(voiceReseal, { hidden: true });

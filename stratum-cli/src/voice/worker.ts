/**
 * M25 (voz) — la entrada del proceso hijo (`dist/voice-worker.js`).
 *
 * Vive en un proceso aparte por tres motivos (fase 1: 4 GB de pesos, 5 GB de
 * RSS en CPU):
 * - un fallo nativo de ONNX Runtime no puede tumbar el daemon ni sus sesiones;
 * - matar el proceso es la única forma segura de devolver la memoria de la GPU;
 * - se arranca solo al llegar audio y se cierra tras `voice.idleUnloadMinutes`.
 *
 * Lo que **no** hace: no usa la red, no abre nada fuera del directorio del
 * modelo y nunca escribe el audio en disco ni en un log.
 */

import { importOptional } from '../runtime/optional-import.js';
import { loadCanaryEngine, type CanaryEngine, type OrtModule } from './canary.js';
import { assertVoiceModelLoadable, VoiceModelNotReadyError } from './model-store.js';
import { transcribePcm, VoiceTooLongError } from './transcribe.js';
import type {
  WorkerErrorCode,
  WorkerInbound,
  WorkerInitRequest,
  WorkerOutbound,
  WorkerReadyMessage,
  WorkerTranscribeRequest,
} from './worker-protocol.js';

let engine: CanaryEngine | undefined;
let language = 'es';
/** Una petición detrás de otra: el modelo no se puede usar en paralelo. */
let tail: Promise<void> = Promise.resolve();

function send(message: WorkerOutbound): void {
  // Sin canal (el padre se fue) no hay a quién contestar; el propio `disconnect`
  // cierra el proceso.
  process.send?.(message);
}

function sendError(code: WorkerErrorCode, message: string, id?: number): void {
  send(id === undefined ? { t: 'error', code, message } : { t: 'error', id, code, message });
}

/** Carga el motor una sola vez. Falla cerrado: si el modelo no cuadra, no se carga. */
async function initialize(request: WorkerInitRequest): Promise<void> {
  language = request.language;
  try {
    await assertVoiceModelLoadable(request.dir);
  } catch (err) {
    sendError('model_not_ready', errorMessage(err));
    return;
  }
  let ort: OrtModule;
  try {
    const loaded = await importOptional<OrtModule & { default?: OrtModule }>('onnxruntime-node');
    // `onnxruntime-node` es CommonJS: el namespace sirve, pero el `module.exports`
    // (el `default`) es lo que funciona siempre, sin depender de que Node detecte
    // los nombres exportados re-exportados.
    ort = loaded.default ?? loaded;
  } catch (err) {
    sendError(
      'runtime_unavailable',
      `no se pudo cargar onnxruntime-node (${errorMessage(err)}); ` +
        'instala la dependencia opcional para transcribir en local',
    );
    return;
  }
  try {
    engine = await loadCanaryEngine({ dir: request.dir, device: request.device, ort });
  } catch (err) {
    sendError('load_failed', errorMessage(err));
    return;
  }
  const ready: WorkerReadyMessage = {
    t: 'ready',
    // Lo que dijo la sonda al cargar: `gpu` solo confirmado.
    device:
      engine.device === 'gpu' ? 'gpu' : engine.device === 'unconfirmed' ? 'gpu-unconfirmed' : 'cpu',
    loadMs: engine.loadMs,
  };
  if (engine.warning !== undefined) ready.warning = engine.warning;
  send(ready);
}

async function transcribe(request: WorkerTranscribeRequest): Promise<void> {
  if (!engine) {
    sendError('load_failed', 'el motor de voz no está cargado', request.id);
    return;
  }
  try {
    const transcript = await transcribePcm(engine, request.pcm, { language });
    send({ t: 'result', id: request.id, transcript });
  } catch (err) {
    if (err instanceof VoiceTooLongError) {
      sendError('too_long', errorMessage(err), request.id);
      return;
    }
    if (engine.broken) {
      // Un motor a medias no se reutiliza: el error va marcado como fatal (el
      // cliente tira este proceso antes de mandar otra nota) y se sale en cuanto
      // el mensaje ha salido.
      const fatal: WorkerOutbound = {
        t: 'error',
        id: request.id,
        code: 'failed',
        message: errorMessage(err),
        fatal: true,
      };
      if (process.send) process.send(fatal, () => process.exit(1));
      else process.exit(1);
      return;
    }
    sendError('failed', errorMessage(err), request.id);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof VoiceModelNotReadyError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

process.on('message', (raw: unknown) => {
  const message = raw as WorkerInbound;
  if (!message || typeof message !== 'object') return;
  if (message.t === 'init') {
    void initialize(message);
    return;
  }
  if (message.t === 'transcribe') {
    // En orden y de una en una: el decoder tiene una sola caché.
    tail = tail.then(() => transcribe(message));
  }
});

// Si el padre desaparece, este proceso no pinta nada: se cierra.
process.on('disconnect', () => {
  process.exit(0);
});

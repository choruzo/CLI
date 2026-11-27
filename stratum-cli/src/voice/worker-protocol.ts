/**
 * M25 (voz) — protocolo entre el proceso padre y el worker de voz.
 *
 * **Sin imports**: solo tipos y constantes. Lo comparten el worker (hijo) y su
 * cliente (padre), y describe exactamente lo que viaja por el canal IPC.
 *
 * El audio **nunca** va a disco ni a un log: viaja como `Float32Array` en el
 * mensaje `transcribe` y se suelta al responder.
 */

export type VoiceDeviceChoice = 'auto' | 'gpu' | 'cpu';

/**
 * El dispositivo **confirmado**: solo se dice `gpu` cuando el primer encoder
 * real lo ha sido (RTF por debajo de `GPU_CONFIRM_MAX_ENCODER_RTF`).
 */
export type VoiceDeviceInUse = 'gpu' | 'cpu';

/**
 * Lo que dice el `ready`, recién cargado el modelo. Con WebGPU todavía **no**
 * está confirmado: que ONNX Runtime cree la sesión no prueba que la GPU corra
 * (puede caer a la CPU sin avisar). Se confirma con el primer encoder real.
 */
export type VoiceReadyDevice = 'gpu-unconfirmed' | 'cpu';

/**
 * El dispositivo de un `result`. `unconfirmed` es que no se ejecutó ningún
 * encoder porque todos los trozos eran casi mudos: no hay nada que confirmar.
 */
export type VoiceTranscriptDevice = 'gpu' | 'cpu' | 'unconfirmed';

/** Por qué se cortó un trozo (mismo valor que `ChunkReason` en `chunk.ts`). */
export type VoiceChunkReason = 'silence' | 'forced' | 'end';

/** Un trozo del audio, tal como lo cuenta la transcripción. */
export interface VoiceTranscriptChunk {
  /** Índices en muestras del PCM de 16 kHz, `end` exclusivo. */
  start: number;
  end: number;
  reason: VoiceChunkReason;
  /** Casi mudo: no se mandó al decoder. */
  skipped: boolean;
  /** Se llegó al tope de tokens en este trozo. */
  capped?: boolean;
  /** Milisegundos que tardó el motor en este trozo. */
  ms?: number;
}

/** Lo que devuelve una transcripción completa. */
export interface VoiceTranscript {
  text: string;
  durationSec: number;
  /** Algún trozo llegó al tope de tokens. */
  capped: boolean;
  /** Milisegundos de reloj de pared del padre. */
  ms: number;
  /** El dispositivo **confirmado** por esta transcripción. */
  device: VoiceTranscriptDevice;
  /** Por qué no se está usando el dispositivo pedido, si hubo que cambiar. */
  warning?: string;
  chunks: VoiceTranscriptChunk[];
}

// ---------------------------------------------------------------------------
// Padre → hijo
// ---------------------------------------------------------------------------

/** Carga el modelo. Se manda una sola vez por worker. */
export interface WorkerInitRequest {
  t: 'init';
  /** Directorio del modelo (lo único que el worker abre del disco). */
  dir: string;
  device: VoiceDeviceChoice;
  /** Idioma de Canary (`voice.language`); nunca se detecta solo. */
  language: string;
}

/** Transcribe un PCM de 16 kHz, mono, en memoria. */
export interface WorkerTranscribeRequest {
  t: 'transcribe';
  id: number;
  pcm: Float32Array;
}

export type WorkerInbound = WorkerInitRequest | WorkerTranscribeRequest;

// ---------------------------------------------------------------------------
// Hijo → padre
// ---------------------------------------------------------------------------

/** El modelo está cargado y se puede pedir. */
export interface WorkerReadyMessage {
  t: 'ready';
  device: VoiceReadyDevice;
  /** Por qué no es el dispositivo que se pidió, si hubo que cambiar. */
  warning?: string;
  loadMs: number;
}

export interface WorkerResultMessage {
  t: 'result';
  id: number;
  transcript: VoiceTranscript;
}

export type WorkerErrorCode =
  /** El modelo no está descargado o no cuadra con el manifiesto. */
  | 'model_not_ready'
  /** No está `onnxruntime-node` instalado. */
  | 'runtime_unavailable'
  /** El modelo no se pudo cargar (fichero ilegible, sesión que falla). */
  | 'load_failed'
  /** El audio pasa del máximo (`transcribe.ts`). */
  | 'too_long'
  /** Cualquier otro fallo de una transcripción. */
  | 'failed';

export interface WorkerErrorMessage {
  t: 'error';
  /** Ausente en un fallo de `init` (no había petición que casar). */
  id?: number;
  code: WorkerErrorCode;
  message: string;
  /**
   * El worker ya no sirve (su motor quedó a medias) y va a salir: el cliente lo
   * da por muerto **antes** de atender la siguiente petición.
   */
  fatal?: true;
}

export type WorkerOutbound = WorkerReadyMessage | WorkerResultMessage | WorkerErrorMessage;

/** Máximo de notas en espera antes de rechazar (las de más se rechazan con aviso). */
export const VOICE_MAX_QUEUE = 3;

/** Plazo de una transcripción de punta a punta, arranque del worker incluido. */
export const VOICE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

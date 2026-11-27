/**
 * M18 — un canal externo y la conversación del `companion` (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * **Entrada.** Un texto de un chat emparejado va a la sesión principal del
 * `companion` (la misma que Dot; si no la hay, se abre). Sin turno en curso,
 * abre uno, que pasa antes por `waitAtSafePoint`. Con turno, es steering; si el
 * turno ya no acepta mensajes (`not-accepting`), se abre otro al terminar, con
 * lo que se haya juntado. `too-large` se contesta en el chat y no se recorta.
 *
 * **Salida (espejo).** Lo que entra en esa conversación llega a los chats
 * emparejados: lo escrito en Dot («In Dot: …»), cada bloque de texto del
 * asistente cuando se cierra (con su markdown en el formato de Telegram,
 * `markdown.ts`) y cómo acabó un turno que falló o se canceló. Las
 * tools no se reflejan: mientras trabaja, el chat ve «escribiendo…». Lo que
 * vino de Telegram (`run.via`) no se devuelve. Todo pasa otra vez por la
 * redacción. Además, el aviso de rutina terminada.
 *
 * Nada de esto decide permisos: lo que el asistente haga desde aquí pide las
 * mismas aprobaciones que desde Dot.
 */
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import type {
  ProtocolEvent,
  ProtocolReminder,
  ProtocolRun,
  ProtocolSharedImage,
  ProtocolWatchNotice,
  ProtocolHealthNotice,
  SteerStatus,
} from '../protocol/index.js';
import { USER_IMAGE_LIMITS, type UserImage } from '../agent/user-images.js';
import { userImageFromBytes } from '../images/store.js';
import {
  TelegramApiError,
  type TelegramFile,
  type TelegramImageRef,
  type TelegramMessage,
  type TelegramVoiceRef,
} from '../channels/telegram/api.js';
import {
  TEXT,
  fromDot,
  imageRejected,
  reminderNotice,
  routineFinished,
  turnFailed,
  unavailable,
  voiceEcho,
  voiceMark,
  warningLine,
  watchNotice,
} from '../channels/telegram/render.js';
import { VOICE_MAX_SECONDS } from '../voice/transcribe.js';
import type { VoiceModelHookInfo, VoiceModelPhase, VoiceNotesPort } from './voice-notes.js';

const log = getLogger('channels');

/** «Escribiendo…» dura unos 5 s en Telegram: se renueva antes. */
const TYPING_INTERVAL_MS = 4_000;

/** M25 fase 3 — lo que puede pesar una nota de voz (PRD: 5 min y 10 MB). */
export const VOICE_NOTE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * M25 fase 3 — los metadatos de una nota de voz que van a la traza. **Nunca** el
 * texto ni el audio: solo cuánto duró, con qué se transcribió y cuánto tardó.
 */
export interface VoiceTraceMeta {
  durationSec: number;
  device: 'gpu' | 'cpu' | 'unconfirmed';
  ms: number;
  decodeMs: number;
  chunks: number;
  skipped: number;
  capped: boolean;
}

/** La sesión principal del `companion`, tal como la ve el canal. */
export interface CompanionTurns {
  readonly sessionId: string;
  readonly running: boolean;
  /** Abre un turno con esta entrada, marcada `via: 'telegram'`. `BUSY` si ya hay uno. */
  startRun(input: string, images?: readonly UserImage[]): ProtocolRun;
  steer(text: string, images?: readonly UserImage[]): SteerStatus;
  waitAtSafePoint(): Promise<void>;
  /** Resuelve al terminar el turno en curso (o ya, sin turno). Nunca rechaza. */
  idle(): Promise<void>;
  /** M25 fase 3 — deja los metadatos de una nota de voz en la traza de la sesión. */
  traceVoice?(meta: VoiceTraceMeta): void;
}

export interface CompanionPort {
  /** La sesión principal del `companion`, abriéndola (o montándola) si hace falta. */
  open(): Promise<CompanionTurns>;
  /** Su id, sin abrir nada; `null` si aún no hay. */
  currentId(): string | null;
}

/** Adónde va el espejo: el canal en marcha, o `null`. */
export interface MirrorTarget {
  /** Con `valid`, se descarta en la cola si deja de valer antes de salir. */
  send(chatId: number, text: string, valid?: () => boolean): void;
  /** Markdown del asistente, convertido al formato del canal. */
  sendMarkdown(chatId: number, markdown: string): void;
  /** Parte 6E — una imagen que envió el asistente, con su pie ya redactado. */
  sendImage(chatId: number, file: TelegramFile, caption: string): void;
  typing(chatId: number): void;
}

export interface CompanionLinkOptions {
  companion: CompanionPort;
  target: () => MirrorTarget | null;
  /**
   * Parte 6E — descarga la imagen de un mensaje, como mucho `maxBytes`. Sin
   * ella, una foto se contesta como cualquier otro adjunto.
   */
  download?: (image: TelegramImageRef, maxBytes: number) => Promise<Uint8Array>;
  /**
   * M25 fase 3 — las notas de voz, transcritas en local. Sin ellas (o sin
   * `downloadVoice`), una nota de voz se contesta como cualquier otro adjunto.
   */
  voiceNotes?: VoiceNotesPort;
  /** M25 fase 3 — descarga los bytes de una nota de voz, como mucho `maxBytes`. */
  downloadVoice?: (voice: TelegramVoiceRef, maxBytes: number) => Promise<Uint8Array>;
  /**
   * Parte 6E — los bytes de una imagen que envió el asistente (`image.shared`),
   * del almacén del daemon; `null` si ya no está. Sin ella, no se reflejan.
   */
  readImage?: (imageId: string) => { data: Uint8Array; mime: string } | null;
  /** Los chats emparejados ahora. */
  chats: () => readonly number[];
  /**
   * M25 fase 3 — la identidad del emparejamiento de un chat (cambia si se
   * desempareja y se vuelve a emparejar); `undefined` sin emparejar. Sin ella,
   * basta con que el chat esté en `chats()`.
   */
  pairedKey?: (chatId: number) => string | undefined;
  redact: (text: string) => string;
  typingIntervalMs?: number;
}

function reasonOf(err: unknown): string {
  if (err instanceof ProtocolError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * M25 fase 3 — por qué no se transcribió una nota de voz, en una línea y sin
 * nada del audio. El tipo basta para saber qué se ha roto; el texto y los bytes
 * no salen de aquí.
 */
function voiceFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'VoiceDecodeError':
      return 'the audio could not be decoded';
    case 'VoiceModelUnavailableError':
      return 'the speech model is not available';
    case 'VoiceTooLongError':
      return 'it is too long once decoded';
    case 'VoiceTimeoutError':
    case 'VoiceWorkerCrashedError':
    case 'VoiceRuntimeUnavailableError':
      return 'the transcriber is not available';
    default:
      return 'transcription failed';
  }
}

/** La nota ya no puede hablar por su chat (desemparejado o canal recargado). */
class VoiceNoteRevokedError extends Error {
  constructor() {
    super('the chat is no longer paired');
    this.name = 'VoiceNoteRevokedError';
  }
}

export class CompanionLink {
  /** Textos que esperan al final del turno en curso (llegaron con `not-accepting`). */
  private deferred: {
    text: string;
    chatId: number;
    images: readonly UserImage[];
    live: () => boolean;
  }[] = [];
  private waitingIdle = false;
  private typingTimer: NodeJS.Timeout | null = null;
  /** El run en curso de la sesión principal y si está trabajando (no en pausa ni esperando). */
  private active: { runId: string; working: boolean } | null = null;
  private stopped = false;
  /**
   * M25 fase 3 — generación de las notas de voz. Una nota en vuelo solo sigue
   * (descarga, avisos, eco, entrega) mientras su chat siga emparejado y el
   * canal no se haya recargado: `resetVoice` (en `reload`) la invalida.
   */
  private voiceEpoch = 0;
  /** Los «escribiendo…» de las notas en vuelo: `stop` y `resetVoice` los paran ya. */
  private readonly voiceTyping = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: CompanionLinkOptions) {}

  stop(): void {
    this.stopped = true;
    this.deferred = [];
    this.stopTyping();
    this.clearVoiceTyping();
  }

  /**
   * El canal se recarga (otro token, otros emparejados): las notas en vuelo ya
   * no hablan por este chat. Se abandonan sin contestar.
   */
  resetVoice(): void {
    this.voiceEpoch++;
    this.clearVoiceTyping();
  }

  private clearVoiceTyping(): void {
    for (const timer of this.voiceTyping) clearInterval(timer);
    this.voiceTyping.clear();
  }

  /** La identidad del emparejamiento de `chatId` ahora mismo. */
  private pairingOf(chatId: number): string | undefined {
    if (this.opts.pairedKey) return this.opts.pairedKey(chatId);
    return this.opts.chats().includes(chatId) ? String(chatId) : undefined;
  }

  /**
   * ¿Puede esta nota seguir hablando por `chatId`? Sin parar, misma generación
   * del canal y **el mismo emparejamiento** con el que llegó (desemparejar y
   * volver a emparejar no la resucita).
   */
  private voiceLive(chatId: number, epoch: number, pairing: string | undefined): boolean {
    return (
      !this.stopped &&
      epoch === this.voiceEpoch &&
      pairing !== undefined &&
      this.pairingOf(chatId) === pairing
    );
  }

  /** Un mensaje de un chat emparejado. */
  async input(chatId: number, message: TelegramMessage): Promise<void> {
    // M25 fase 3 — una nota de voz va por su propio camino y **en su propia
    // tarea**: decodificar y transcribir en local tarda, y esperar aquí dejaría
    // parado el bucle de mensajes del canal (textos, botones de aprobación y
    // otras notas). `input` vuelve ya.
    if (message.voice && this.opts.voiceNotes && this.opts.downloadVoice) {
      void this.voiceNote(chatId, message).catch((err: unknown) => {
        log.warn('telegram voice note failed', { err });
      });
      return;
    }
    const text = (message.text ?? message.caption)?.trim() ?? '';
    let images: UserImage[] = [];
    if (message.image && this.opts.download) {
      try {
        const bytes = await this.opts.download(message.image, USER_IMAGE_LIMITS.maxBytes);
        images = [userImageFromBytes(bytes, `telegram-${message.messageId}`)];
      } catch (err) {
        log.info('telegram image not passed on', {
          kind: err instanceof TelegramApiError ? err.kind : 'image',
        });
        this.reply(chatId, imageRejected(err));
        return;
      }
    } else if (!text) {
      if (message.hasMedia) this.reply(chatId, TEXT.textOnly);
      return;
    }
    // Sin texto, una foto lleva una marca: un mensaje vacío no entra en la conversación.
    await this.deliver(text || TEXT.photoInput, chatId, images);
  }

  /**
   * M25 fase 3 — una nota de voz: descargar (nunca más de 10 MB, y solo cuando
   * a la nota le toca en la cola), transcribir en local, contestar el eco de lo
   * entendido y entregar el texto al agente con su marca.
   *
   * Corre en segundo plano (`input` no la espera): un texto mandado **después**
   * de una nota puede llegar al agente antes que ella. Es el precio de que una
   * transcripción de medio minuto no frene el resto del chat.
   *
   * No poder transcribir es un fallo **auxiliar**: se dice en el chat y no se
   * abre ningún turno. La sesión sigue igual. El audio no sale de aquí.
   */
  private async voiceNote(chatId: number, message: TelegramMessage): Promise<void> {
    const epoch = this.voiceEpoch;
    const pairing = this.pairingOf(chatId);
    const live = (): boolean => this.voiceLive(chatId, epoch, pairing);
    if (!live()) return;
    const voice = message.voice!;
    const notes = this.opts.voiceNotes!;
    const download = this.opts.downloadVoice!;
    // Lo que Telegram declara ya se sabe antes de bajar nada.
    if (voice.duration > VOICE_MAX_SECONDS || (voice.size ?? 0) > VOICE_NOTE_MAX_BYTES) {
      this.reply(chatId, TEXT.voiceTooLong, live);
      return;
    }
    // Mientras el modelo trabaja, el chat ve «escribiendo…», como con un turno.
    const stopTyping = this.startVoiceTyping(chatId, live);
    // La descarga de Telegram se pide cuando la nota sale de la cola, no al
    // llegar: si no cabe, no se baja ni un byte.
    let downloadError: unknown;
    const getBytes = async (): Promise<Uint8Array> => {
      // Desemparejado o recargado mientras esperaba su turno: no se baja nada.
      if (!live()) throw new VoiceNoteRevokedError();
      try {
        return await download(voice, VOICE_NOTE_MAX_BYTES);
      } catch (err) {
        downloadError = err;
        throw err;
      }
    };
    try {
      const result = await notes.transcribe(getBytes, {
        onModelDownload: (phase, info) => {
          if (live()) this.voiceModelNotice(chatId, phase, info, live);
        },
      });
      if (!live()) return;
      const text = result.text.trim();
      if (!text) {
        // Todo mudo o nada entendido: no se abre turno con una entrada vacía.
        this.reply(chatId, TEXT.voiceEmpty, live);
        return;
      }
      // El eco, antes de que el agente responda: así se ve qué se entendió.
      this.reply(chatId, voiceEcho(text, result.capped), live);
      // A la traza solo los metadatos, y antes de abrir el turno.
      await this.traceVoice({
        durationSec: result.durationSec,
        device: result.device,
        ms: result.ms,
        decodeMs: result.decodeMs,
        chunks: result.chunks,
        skipped: result.skipped,
        capped: result.capped,
      });
      if (!live()) return;
      const entry = `${voiceMark(result.durationSec, result.capped)} ${text}`;
      const caption = (message.caption ?? '').trim();
      // Mismo camino que un texto: `deliver` con su steering y lo diferido.
      await this.deliver(caption ? `${entry}\n\n${caption}` : entry, chatId, [], live);
    } catch (err) {
      // El daemon se apaga: ni un mensaje más al chat.
      // El daemon se apaga, o el chat ya no está emparejado: ni un mensaje más.
      if (!live() || (err instanceof Error && err.name === 'VoiceNotesClosedError')) return;
      if (downloadError !== undefined) {
        log.info('telegram voice not downloaded', {
          kind: downloadError instanceof TelegramApiError ? downloadError.kind : 'voice',
        });
        this.reply(chatId, TEXT.voiceFailed('it could not be downloaded from Telegram'), live);
        return;
      }
      // Solo el tipo: ni el texto ni el audio van al log.
      log.info('telegram voice not transcribed', {
        kind: err instanceof Error ? err.name : 'voice',
      });
      this.reply(chatId, this.voiceFailureText(err), live);
    } finally {
      stopTyping();
    }
  }

  /** Qué se contesta cuando no se pudo transcribir (cola llena y apagada aparte). */
  private voiceFailureText(err: unknown): string {
    const name = err instanceof Error ? err.name : '';
    if (name === 'VoiceQueueFullError') return TEXT.voiceQueueFull;
    if (name === 'VoiceNotesDisabledError') return TEXT.voiceOff;
    return TEXT.voiceFailed(voiceFailure(err));
  }

  /** La descarga del modelo, contada a ese chat (una sola vez en la vida del modelo). */
  private voiceModelNotice(
    chatId: number,
    phase: VoiceModelPhase,
    info: VoiceModelHookInfo,
    live: () => boolean,
  ): void {
    if (this.stopped) return;
    switch (phase) {
      case 'start':
        this.reply(chatId, TEXT.voiceModelDownloading, live);
        return;
      case 'progress':
        if (info.percent !== undefined)
          this.reply(chatId, TEXT.voiceModelProgress(info.percent), live);
        return;
      case 'done':
        this.reply(chatId, TEXT.voiceModelReady, live);
        return;
      case 'failed':
        this.reply(chatId, TEXT.voiceModelFailed, live);
        return;
    }
  }

  /** «Escribiendo…» solo en ese chat, mientras dura la transcripción. */
  private startVoiceTyping(chatId: number, live: () => boolean): () => void {
    const tick = (): void => {
      if (live()) this.opts.target()?.typing(chatId);
    };
    tick();
    const timer = setInterval(tick, this.opts.typingIntervalMs ?? TYPING_INTERVAL_MS);
    timer.unref?.();
    this.voiceTyping.add(timer);
    return () => {
      clearInterval(timer);
      this.voiceTyping.delete(timer);
    };
  }

  /** Los metadatos de la nota a la traza de la sesión. Un fallo no la tumba. */
  private async traceVoice(meta: VoiceTraceMeta): Promise<void> {
    try {
      const session = await this.opts.companion.open();
      session.traceVoice?.(meta);
    } catch {
      // La traza y la sesión son auxiliares: la nota sigue su camino.
    }
  }

  /**
   * Entrega un mensaje del chat al `companion`. `live` dice si sigue valiendo
   * (para una nota de voz: su chat sigue emparejado igual y el canal no se
   * recargó); se vuelve a mirar **después de cada espera**, y lo diferido lo
   * conserva para mirarlo otra vez al juntarlo.
   */
  private async deliver(
    text: string,
    chatId: number,
    images: readonly UserImage[] = [],
    live: () => boolean = () => !this.stopped,
  ): Promise<'done' | 'revoked'> {
    const alive = (): boolean => !this.stopped && live();
    if (!alive()) return 'revoked';
    let session: CompanionTurns;
    try {
      session = await this.opts.companion.open();
    } catch (err) {
      if (!alive()) return 'revoked';
      log.warn('telegram message not delivered: companion unavailable');
      this.reply(chatId, unavailable(reasonOf(err)), alive);
      return 'done';
    }
    // Tras cada espera se vuelve a mirar: `stop()` o la revocación pudieron llegar.
    if (!alive()) return 'revoked';
    if (session.running) {
      this.steerOrDefer(session, text, chatId, images, alive);
      return 'done';
    }
    // Como cualquier trabajo nuevo del agente: antes, su punto seguro (la pausa).
    await session.waitAtSafePoint();
    if (!alive()) return 'revoked';
    try {
      session.startRun(text, images);
    } catch (err) {
      // Otro (Dot, una aprobación que reanudó) abrió turno entretanto: steering.
      if (err instanceof ProtocolError && err.code === 'BUSY') {
        this.steerOrDefer(session, text, chatId, images, alive);
        return 'done';
      }
      this.reply(chatId, unavailable(reasonOf(err)), alive);
    }
    return 'done';
  }

  /**
   * Lo diferido, junto en un solo mensaje. Cada entrada conserva su vigencia
   * hasta el punto de entrega: si una se revoca mientras se espera (una nota de
   * un chat que se desempareja), se quita y se entrega el resto.
   */
  private async deliverBatch(
    batch: { text: string; chatId: number; images: readonly UserImage[]; live: () => boolean }[],
  ): Promise<void> {
    let entries = batch;
    for (;;) {
      entries = entries.filter((entry) => entry.live());
      if (entries.length === 0 || this.stopped) return;
      const joined = entries.map((entry) => entry.text).join('\n\n');
      // Las imágenes de lo juntado, hasta el tope de un mensaje (las últimas).
      const images = entries.flatMap((entry) => entry.images).slice(-USER_IMAGE_LIMITS.perMessage);
      const current = entries;
      const status = await this.deliver(joined, current.at(-1)!.chatId, images, () =>
        current.every((entry) => entry.live()),
      );
      if (status === 'done') return;
    }
  }

  private steerOrDefer(
    session: CompanionTurns,
    text: string,
    chatId: number,
    images: readonly UserImage[],
    live: () => boolean,
  ): void {
    const status = session.steer(text, images);
    if (status === 'accepted' || status === 'empty') return;
    if (status === 'too-large') {
      this.reply(chatId, TEXT.tooLarge, live);
      return;
    }
    // `not-accepting`: el turno ya está cerrándose. Se abre otro al terminar.
    this.deferred.push({ text, chatId, images, live });
    if (this.waitingIdle) return;
    this.waitingIdle = true;
    void session.idle().then(() => {
      this.waitingIdle = false;
      // Lo que se revocó mientras esperaba (una nota de un chat desemparejado) no se junta.
      void this.deliverBatch(this.deferred.splice(0));
    });
  }

  /** Un evento de una sesión del daemon. Solo cuenta la principal del `companion`. */
  observe(event: ProtocolEvent): void {
    if (this.stopped) return;
    const sessionId = this.opts.companion.currentId();
    if (!sessionId || event.sessionId !== sessionId) return;
    switch (event.type) {
      case 'run.started': {
        const run = event.data.run;
        this.active = { runId: run.id, working: true };
        this.startTyping();
        // Lo que vino de Telegram no se devuelve.
        if (run.kind === 'run' && !run.via) this.broadcast(fromDot(run.input));
        return;
      }
      case 'run.updated':
        if (this.active?.runId === event.data.run.id) {
          this.active.working = event.data.run.status === 'running';
        }
        return;
      case 'message.completed':
        if (event.subagentId || !event.data.text.trim()) return;
        this.broadcastMarkdown(event.data.text);
        return;
      case 'run.completed':
        return this.endRun();
      case 'run.failed':
        this.endRun();
        this.broadcast(turnFailed(event.data.run.error));
        return;
      case 'run.cancelled':
        this.endRun();
        this.broadcast(TEXT.cancelled);
        return;
      case 'session.closed':
        return this.endRun();
      case 'image.shared':
        if (!event.subagentId) this.broadcastImage(event.data.image);
        return;
      case 'warning':
        // Lo que la sesión avisa (un modelo sin visión para una foto, otro provider
        // al restaurarla) también llega al chat.
        if (!event.subagentId) this.broadcast(warningLine(event.data.message));
        return;
      default:
        return;
    }
  }

  /** M16 — una rutina terminó: su nombre, cómo y su último mensaje (ya recortado). */
  routineFinished(name: string, status: string, summary: string | null): void {
    if (this.stopped) return;
    this.broadcast(routineFinished(name, status, summary));
  }

  /** M21 — un recordatorio que vence. Si llega tarde, la hora para la que era. */
  reminderDue(reminder: ProtocolReminder): void {
    if (this.stopped) return;
    const due = new Date(reminder.dueAt);
    const late = reminder.late ? { hour: due.getHours(), minute: due.getMinutes() } : null;
    this.broadcast(reminderNotice(reminder.text, late));
  }

  /** M22 — un aviso de un vigilante. El texto ya viene compuesto. */
  watchNotice(notice: ProtocolWatchNotice): void {
    if (this.stopped) return;
    this.broadcast(watchNotice(notice.text));
  }

  /** M23 — un aviso de degradación. El texto ya viene compuesto, como el de un vigilante. */
  healthNotice(notice: ProtocolHealthNotice): void {
    if (this.stopped) return;
    this.broadcast(watchNotice(notice.text));
  }

  private endRun(): void {
    this.active = null;
    this.stopTyping();
  }

  private broadcast(text: string): void {
    const target = this.opts.target();
    if (!target) return;
    const safe = this.opts.redact(text);
    for (const chatId of this.opts.chats()) target.send(chatId, safe);
  }

  /** Como `broadcast`, para la respuesta del asistente: con su markdown convertido. */
  private broadcastMarkdown(markdown: string): void {
    const target = this.opts.target();
    if (!target) return;
    const safe = this.opts.redact(markdown);
    for (const chatId of this.opts.chats()) target.sendMarkdown(chatId, safe);
  }

  /** Parte 6E — la imagen se lee una vez del almacén y va a cada chat. Su pie, redactado otra vez. */
  private broadcastImage(image: ProtocolSharedImage): void {
    const target = this.opts.target();
    if (!target || !this.opts.readImage) return;
    let read: { data: Uint8Array; mime: string } | null;
    try {
      read = this.opts.readImage(image.id);
    } catch (err) {
      log.warn('shared image not mirrored', { err });
      return;
    }
    if (!read) {
      log.warn('shared image not mirrored: not in the store');
      return;
    }
    const ext = read.mime.split('/')[1] === 'jpeg' ? 'jpg' : read.mime.split('/')[1];
    const file = { data: read.data, mime: read.mime, name: `image.${ext}` };
    const caption = this.opts.redact(image.caption ?? '');
    for (const chatId of this.opts.chats()) target.sendImage(chatId, file, caption);
  }

  /** Con `valid`, el mensaje se descarta en la cola si deja de valer antes de salir. */
  private reply(chatId: number, text: string, valid?: () => boolean): void {
    if (valid && !valid()) return;
    this.opts.target()?.send(chatId, this.opts.redact(text), valid);
  }

  private startTyping(): void {
    this.stopTyping();
    const tick = (): void => {
      const target = this.opts.target();
      if (!target || !this.active?.working) return;
      for (const chatId of this.opts.chats()) target.typing(chatId);
    };
    tick();
    this.typingTimer = setInterval(tick, this.opts.typingIntervalMs ?? TYPING_INTERVAL_MS);
    this.typingTimer.unref?.();
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }
}

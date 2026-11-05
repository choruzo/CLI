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
import type { ProtocolEvent, ProtocolRun, SteerStatus } from '../protocol/index.js';
import { USER_IMAGE_LIMITS, type UserImage } from '../agent/user-images.js';
import { userImageFromBytes } from '../images/store.js';
import {
  TelegramApiError,
  type TelegramImageRef,
  type TelegramMessage,
} from '../channels/telegram/api.js';
import {
  TEXT,
  fromDot,
  imageRejected,
  routineFinished,
  turnFailed,
  unavailable,
  warningLine,
} from '../channels/telegram/render.js';

const log = getLogger('channels');

/** «Escribiendo…» dura unos 5 s en Telegram: se renueva antes. */
const TYPING_INTERVAL_MS = 4_000;

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
}

export interface CompanionPort {
  /** La sesión principal del `companion`, abriéndola (o montándola) si hace falta. */
  open(): Promise<CompanionTurns>;
  /** Su id, sin abrir nada; `null` si aún no hay. */
  currentId(): string | null;
}

/** Adónde va el espejo: el canal en marcha, o `null`. */
export interface MirrorTarget {
  send(chatId: number, text: string): void;
  /** Markdown del asistente, convertido al formato del canal. */
  sendMarkdown(chatId: number, markdown: string): void;
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
  /** Los chats emparejados ahora. */
  chats: () => readonly number[];
  redact: (text: string) => string;
  typingIntervalMs?: number;
}

function reasonOf(err: unknown): string {
  if (err instanceof ProtocolError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export class CompanionLink {
  /** Textos que esperan al final del turno en curso (llegaron con `not-accepting`). */
  private deferred: { text: string; chatId: number; images: readonly UserImage[] }[] = [];
  private waitingIdle = false;
  private typingTimer: NodeJS.Timeout | null = null;
  /** El run en curso de la sesión principal y si está trabajando (no en pausa ni esperando). */
  private active: { runId: string; working: boolean } | null = null;
  private stopped = false;

  constructor(private readonly opts: CompanionLinkOptions) {}

  stop(): void {
    this.stopped = true;
    this.deferred = [];
    this.stopTyping();
  }

  /** Un mensaje de un chat emparejado. */
  async input(chatId: number, message: TelegramMessage): Promise<void> {
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

  private async deliver(
    text: string,
    chatId: number,
    images: readonly UserImage[] = [],
  ): Promise<void> {
    if (this.stopped) return;
    let session: CompanionTurns;
    try {
      session = await this.opts.companion.open();
    } catch (err) {
      log.warn('telegram message not delivered: companion unavailable');
      this.reply(chatId, unavailable(reasonOf(err)));
      return;
    }
    if (session.running) return this.steerOrDefer(session, text, chatId, images);
    // Como cualquier trabajo nuevo del agente: antes, su punto seguro (la pausa).
    await session.waitAtSafePoint();
    try {
      session.startRun(text, images);
    } catch (err) {
      // Otro (Dot, una aprobación que reanudó) abrió turno entretanto: steering.
      if (err instanceof ProtocolError && err.code === 'BUSY') {
        return this.steerOrDefer(session, text, chatId, images);
      }
      this.reply(chatId, unavailable(reasonOf(err)));
    }
  }

  private steerOrDefer(
    session: CompanionTurns,
    text: string,
    chatId: number,
    images: readonly UserImage[],
  ): void {
    const status = session.steer(text, images);
    if (status === 'accepted' || status === 'empty') return;
    if (status === 'too-large') {
      this.reply(chatId, TEXT.tooLarge);
      return;
    }
    // `not-accepting`: el turno ya está cerrándose. Se abre otro al terminar.
    this.deferred.push({ text, chatId, images });
    if (this.waitingIdle) return;
    this.waitingIdle = true;
    void session.idle().then(() => {
      this.waitingIdle = false;
      const pending = this.deferred.splice(0);
      if (pending.length === 0) return;
      const joined = pending.map((p) => p.text).join('\n\n');
      // Las imágenes de lo juntado, hasta el tope de un mensaje (las últimas).
      const images = pending.flatMap((p) => p.images).slice(-USER_IMAGE_LIMITS.perMessage);
      void this.deliver(joined, pending.at(-1)!.chatId, images);
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

  private reply(chatId: number, text: string): void {
    this.opts.target()?.send(chatId, this.opts.redact(text));
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

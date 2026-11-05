/**
 * M18 — `TelegramChannel`: el sondeo del bot y a quién se le hace caso
 * (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Sin webhook ni puerto: *long polling* con `getUpdates`. Un fallo de red, un
 * 429 o un 409 es un reintento con espera que queda en `lastError`; solo un
 * token que Telegram rechaza para el sondeo (`unauthorized`), porque reintentar
 * no lo arregla.
 *
 * Quién habla: solo chats **privados** de un usuario emparejado. A cualquier
 * otro no se le contesta nada (que el bot no sirva para saber si hay un
 * emparejamiento), salvo a quien manda un código de emparejamiento válido. Del
 * resto, en el log solo queda un recuento: nunca el texto ni el id.
 *
 * El canal no sabe del daemon: lo que hace con un mensaje lo deciden las
 * dependencias que recibe (`ChannelHost`).
 */
import { getLogger } from '../../logging/index.js';
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramErrorKind,
  TelegramMessage,
  TelegramUpdate,
} from './api.js';
import { TelegramApiError } from './api.js';
import { TelegramOutbox, type OutgoingMessage } from './outbox.js';
import type { OfferResult, PairingCandidate } from './pairing.js';
import { renderTelegramMarkdown } from './markdown.js';
import { TEXT, chunkText, displayName, parseCommand } from './render.js';
import type { TelegramPaired } from './store.js';

const log = getLogger('channels');

/** Lo que espera `getUpdates` a que llegue algo. */
const POLL_TIMEOUT_SEC = 30;
const RETRY = { initialMs: 1_000, maxMs: 60_000 };

export interface TelegramChannelDeps {
  api: TelegramApi;
  now: () => number;
  /** El emparejado con ese `userId`, o `null`. */
  pairedUser(userId: number): TelegramPaired | null;
  /** Un `/start <código>` de un chat privado de alguien que aún no está emparejado. */
  offerCode(code: string, who: PairingCandidate): OfferResult;
  /** `/unpair` desde el propio chat. */
  unpair(userId: number): Promise<boolean>;
  /** Un texto de un chat emparejado, escrito con el canal ya en marcha. */
  onText?(from: TelegramPaired, message: TelegramMessage): void | Promise<void>;
  /** Un botón pulsado en un chat emparejado. */
  onCallback?(from: TelegramPaired, query: TelegramCallbackQuery): void | Promise<void>;
  pollTimeoutSec?: number;
  retry?: { initialMs: number; maxMs: number };
  /** Espacio mínimo entre mensajes a un chat (1 s). Tests: menos. */
  sendIntervalMs?: number;
}

export interface TelegramChannelError {
  kind: TelegramErrorKind;
  message: string;
  at: number;
}

export type TelegramChannelState =
  | 'running'
  /** Telegram rechaza el token: el sondeo se para hasta que se rehaga `setup`. */
  | 'unauthorized'
  | 'stopped';

/** Espera `ms` o hasta que se aborte, lo primero. Nunca rechaza ni retiene el proceso. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

export class TelegramChannel {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private offset: number | undefined;
  private _state: TelegramChannelState = 'stopped';
  private _lastError: TelegramChannelError | null = null;
  private _lastPollAt: number | null = null;
  /** Mensajes de chats que no son de un emparejado. Solo el número va al log. */
  private ignored = 0;
  /** Cuándo empezó a escuchar: lo fechado antes llegó con el daemon apagado. */
  readonly startedAt: number;
  private readonly outbox: TelegramOutbox;

  constructor(private readonly deps: TelegramChannelDeps) {
    this.startedAt = deps.now();
    this.outbox = new TelegramOutbox({
      api: deps.api,
      ...(deps.sendIntervalMs !== undefined ? { minIntervalMs: deps.sendIntervalMs } : {}),
    });
  }

  get state(): TelegramChannelState {
    return this._state;
  }

  get lastError(): TelegramChannelError | null {
    return this._lastError;
  }

  get lastPollAt(): number | null {
    return this._lastPollAt;
  }

  start(): void {
    if (this.loop) return;
    this._state = 'running';
    this.loop = this.run();
  }

  /** Para el sondeo (aborta el `getUpdates` en curso) y espera a que termine. Lo no enviado se descarta. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.outbox.stop();
    if (this._state === 'running') this._state = 'stopped';
    await this.loop;
  }

  /**
   * Un texto al chat, en trozos que caben, por su cola. Un fallo se registra y
   * no se propaga: el canal es auxiliar.
   */
  send(chatId: number, text: string): void {
    for (const piece of chunkText(text)) this.outbox.send(chatId, { text: piece });
  }

  /**
   * Markdown del modelo, como HTML de Telegram (`markdown.ts`), en trozos que caben.
   * Cada trozo lleva su respaldo en plano por si Telegram rechaza el formato.
   */
  sendMarkdown(chatId: number, markdown: string): void {
    for (const chunk of renderTelegramMarkdown(markdown)) {
      this.outbox.send(chatId, { text: chunk.html, parseMode: 'HTML', plain: chunk.plain });
    }
  }

  /** Un mensaje con botones (o que se editará luego), por la misma cola. */
  sendMessage(chatId: number, message: OutgoingMessage): void {
    this.outbox.send(chatId, message);
  }

  /** Cambia el texto de un mensaje ya enviado y le quita los botones. Un fallo se registra. */
  edit(chatId: number, messageId: number, text: string): void {
    this.deps.api.editMessageText(chatId, messageId, text).catch((err: unknown) => {
      log.warn('telegram edit failed', { kind: kindOf(err) });
    });
  }

  /** Contesta a un botón pulsado (quita el reloj del botón y enseña `text`). */
  answerCallback(id: string, text?: string): void {
    this.deps.api.answerCallbackQuery(id, text).catch(() => undefined);
  }

  /** «Escribiendo…» en el chat (dura ~5 s). Sin cola: si falla, da igual. */
  typing(chatId: number): void {
    this.deps.api.sendChatAction(chatId, 'typing').catch(() => undefined);
  }

  /** Espera a que la cola de salida se vacíe (tests). */
  flush(): Promise<void> {
    return this.outbox.flush();
  }

  private async run(): Promise<void> {
    const retry = this.deps.retry ?? RETRY;
    let delay = retry.initialMs;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.deps.api.getUpdates(
          {
            ...(this.offset !== undefined ? { offset: this.offset } : {}),
            timeoutSec: this.deps.pollTimeoutSec ?? POLL_TIMEOUT_SEC,
          },
          signal,
        );
      } catch (err) {
        if (signal.aborted) break;
        const kind = kindOf(err);
        this._lastError = {
          kind,
          message: err instanceof Error ? err.message : String(err),
          at: this.deps.now(),
        };
        log.warn('telegram poll failed', { kind });
        if (kind === 'unauthorized') {
          this._state = 'unauthorized';
          break;
        }
        const wait =
          err instanceof TelegramApiError && err.kind === 'rate-limited'
            ? Math.max(1, err.retryAfterSec ?? 1) * 1000
            : delay;
        delay = Math.min(delay * 2, retry.maxMs);
        await pause(wait, signal);
        continue;
      }
      delay = retry.initialMs;
      this._lastPollAt = this.deps.now();
      this._lastError = null;
      for (const update of updates) {
        // Confirmado aunque falle su tratamiento: un update que rompe no se repite sin fin.
        this.offset = update.updateId + 1;
        if (signal.aborted) break;
        try {
          await this.handle(update);
        } catch (err) {
          log.warn('telegram update failed', { kind: kindOf(err) });
        }
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.message) return this.handleMessage(update.message);
    if (update.callbackQuery) return this.handleCallback(update.callbackQuery);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    if (message.chat.type !== 'private' || !from || from.isBot || message.chat.id !== from.id) {
      return this.ignore();
    }
    const paired = this.deps.pairedUser(from.id);
    const command = message.text !== undefined ? parseCommand(message.text) : null;
    if (!paired) {
      if (command?.command === 'start' && command.arg) {
        const who: PairingCandidate = {
          userId: from.id,
          chatId: message.chat.id,
          name: displayName(from),
          ...(from.username ? { username: from.username } : {}),
        };
        if (this.deps.offerCode(command.arg, who) === 'candidate') {
          log.info('telegram pairing candidate');
          return this.send(message.chat.id, TEXT.candidate);
        }
      }
      return this.ignore();
    }
    // Desemparejar solo resta: vale aunque llegue tarde.
    if (command?.command === 'unpair') {
      await this.deps.unpair(from.id);
      return this.send(message.chat.id, TEXT.unpaired);
    }
    // Telegram reentrega lo no confirmado: lo de antes de arrancar no se ejecuta.
    if (message.date * 1000 < this.startedAt - 1000) {
      return this.send(message.chat.id, TEXT.stale);
    }
    if (command?.command === 'start') return this.send(message.chat.id, TEXT.alreadyPaired);
    await this.deps.onText?.(paired, message);
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const paired = this.deps.pairedUser(query.from.id);
    if (!paired || query.message?.chatId !== paired.chatId) return this.ignore();
    await this.deps.onCallback?.(paired, query);
  }

  private ignore(): void {
    this.ignored++;
    log.debug('telegram update from an unpaired chat ignored', { ignored: this.ignored });
  }
}

function kindOf(err: unknown): TelegramErrorKind {
  return err instanceof TelegramApiError ? err.kind : 'network';
}

/**
 * Una Bot API de Telegram en memoria, para tests: `getUpdates` entrega lo que
 * el test empuja (y espera, como el *long polling*, si no hay nada), y lo que el
 * bot envía queda en `sent`.
 */
import {
  TelegramApiError,
  type InlineKeyboard,
  type SendOptions,
  type TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './api.js';

export interface SentMessage {
  chatId: number;
  text: string;
  messageId: number;
  keyboard?: InlineKeyboard;
  /** Solo si el envío pidió formato. */
  parseMode?: 'HTML';
}

export class FakeTelegramApi implements TelegramApi {
  readonly sent: SentMessage[] = [];
  readonly polls: { offset?: number }[] = [];
  private queue: (TelegramUpdate[] | TelegramApiError)[] = [];
  private rejectFormatted = 0;
  private waiter: (() => void) | null = null;
  private nextUpdateId = 1;
  private nextMessageId = 1;

  constructor(
    readonly me: TelegramUser = { id: 777, isBot: true, firstName: 'Bot', username: 'test_bot' },
  ) {}

  /** Entrega estos updates en el siguiente `getUpdates`. */
  push(...updates: TelegramUpdate[]): void {
    this.queue.push(updates);
    this.wake();
  }

  /** El siguiente `getUpdates` falla con esto. */
  fail(err: TelegramApiError): void {
    this.queue.push(err);
    this.wake();
  }

  /** Los `n` siguientes `sendMessage` con `parseMode` los rechaza Telegram (400, no se registran). */
  rejectFormatting(n = 1): void {
    this.rejectFormatted = n;
  }

  /** Un texto de un chat privado, fechado ahora (o en `dateSec`). */
  text(
    user: { id: number; firstName?: string; username?: string },
    text: string,
    dateSec = Math.floor(Date.now() / 1000),
  ): TelegramUpdate {
    const message: TelegramMessage = {
      messageId: this.nextMessageId++,
      date: dateSec,
      chat: { id: user.id, type: 'private' },
      from: {
        id: user.id,
        isBot: false,
        firstName: user.firstName ?? 'Ana',
        ...(user.username ? { username: user.username } : {}),
      },
      text,
      hasMedia: false,
    };
    return { updateId: this.nextUpdateId++, message };
  }

  /** Un botón pulsado por `userId` en el mensaje `messageId` de su chat. */
  press(userId: number, messageId: number, data: string): TelegramUpdate {
    return {
      updateId: this.nextUpdateId++,
      callbackQuery: {
        id: `cb${this.nextUpdateId}`,
        from: { id: userId, isBot: false, firstName: 'Ana' },
        data,
        message: { messageId, chatId: userId },
      },
    };
  }

  update(partial: Omit<TelegramUpdate, 'updateId'>): TelegramUpdate {
    return { updateId: this.nextUpdateId++, ...partial };
  }

  /** Espera a que el bot haya enviado `n` mensajes. */
  async waitSent(n: number, timeoutMs = 2_000): Promise<SentMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.sent.length < n) {
      if (Date.now() > deadline) throw new Error(`only ${this.sent.length} of ${n} messages sent`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.sent;
  }

  /** Espera a que el canal haya consumido todo lo empujado y esté sondeando otra vez. */
  async drained(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.waiter === null) {
      if (Date.now() > deadline) throw new Error('the channel did not poll again');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async getMe(): Promise<TelegramUser> {
    return this.me;
  }

  async getUpdates(
    params: { offset?: number; timeoutSec: number },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    this.polls.push(params.offset !== undefined ? { offset: params.offset } : {});
    while (this.queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        this.waiter = resolve;
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const next = this.queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<{ messageId: number }> {
    if (opts.parseMode && this.rejectFormatted > 0) {
      this.rejectFormatted--;
      throw new TelegramApiError(
        'api',
        "Bad Request: can't parse entities: unsupported start tag",
        400,
      );
    }
    const messageId = this.nextMessageId++;
    this.sent.push({
      chatId,
      text,
      messageId,
      ...(opts.parseMode ? { parseMode: opts.parseMode } : {}),
      ...(opts.keyboard ? { keyboard: opts.keyboard } : {}),
    });
    return { messageId };
  }

  readonly edits: { chatId: number; messageId: number; text: string; keyboard?: InlineKeyboard }[] =
    [];
  readonly callbackAnswers: { id: string; text?: string }[] = [];

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<void> {
    this.edits.push({
      chatId,
      messageId,
      text,
      ...(opts.keyboard ? { keyboard: opts.keyboard } : {}),
    });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.callbackAnswers.push({ id, ...(text !== undefined ? { text } : {}) });
  }

  async sendChatAction(): Promise<void> {}

  /** Ficheros que se pueden descargar, por `fileId` (parte 6E). */
  readonly files = new Map<string, Uint8Array>();

  /** Una foto (con `caption` opcional) de un chat privado; sus bytes, en `files`. */
  photo(user: { id: number }, bytes: Uint8Array, caption?: string): TelegramUpdate {
    const fileId = `f${this.nextMessageId}`;
    this.files.set(fileId, bytes);
    const update = this.text(user, '');
    const { text: _t, ...message } = update.message!;
    return {
      ...update,
      message: {
        ...message,
        ...(caption !== undefined ? { caption } : {}),
        image: { fileId, size: bytes.length },
        hasMedia: true,
      },
    };
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.files.get(fileId);
    if (!bytes) throw new TelegramApiError('api', 'Bad Request: file not found', 400);
    if (bytes.length > maxBytes) throw new TelegramApiError('too-large', 'too large');
    return bytes;
  }
}

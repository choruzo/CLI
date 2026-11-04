/**
 * M18 — lo que el bot envía, en una cola por chat (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Telegram limita a ~1 mensaje por segundo en un chat: la cola los espacia
 * (`minIntervalMs`) y un 429 espera lo que dice `retry_after` y reintenta ese
 * mismo mensaje. Cualquier otro fallo lo descarta y lo registra (sin el texto):
 * el canal es auxiliar y nunca bloquea al asistente. Cada chat tiene un tope de
 * mensajes en espera; si se llena, se descartan los más antiguos.
 */
import { getLogger } from '../../logging/index.js';
import { TelegramApiError, type InlineKeyboard, type TelegramApi } from './api.js';

const log = getLogger('channels');

const MIN_INTERVAL_MS = 1_000;
const MAX_QUEUE = 100;
const MAX_ATTEMPTS = 3;

export interface OutgoingMessage {
  text: string;
  keyboard?: InlineKeyboard;
  /** Con el id del mensaje ya enviado (para editarlo después). */
  onSent?: (messageId: number) => void;
}

interface ChatQueue {
  items: OutgoingMessage[];
  worker: Promise<void> | null;
  lastSentAt: number;
}

export interface OutboxOptions {
  api: TelegramApi;
  minIntervalMs?: number;
  maxQueue?: number;
  /** Espera; los tests la acortan. Nunca retiene el proceso. */
  sleep?: (ms: number) => Promise<void>;
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class TelegramOutbox {
  private readonly chats = new Map<number, ChatQueue>();
  private stopped = false;
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OutboxOptions) {
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE;
    this.sleep = opts.sleep ?? unrefSleep;
  }

  send(chatId: number, message: OutgoingMessage): void {
    if (this.stopped) return;
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { items: [], worker: null, lastSentAt: 0 };
      this.chats.set(chatId, chat);
    }
    chat.items.push(message);
    if (chat.items.length > this.maxQueue) {
      const dropped = chat.items.length - this.maxQueue;
      chat.items.splice(0, dropped);
      log.warn('telegram outbox full, oldest messages dropped', { dropped });
    }
    this.kick(chatId, chat);
  }

  private kick(chatId: number, chat: ChatQueue): void {
    if (chat.worker) return;
    chat.worker = this.drain(chatId, chat).finally(() => {
      chat.worker = null;
      // Lo encolado entre el final del bucle y aquí no se queda esperando.
      if (!this.stopped && chat.items.length > 0) this.kick(chatId, chat);
    });
  }

  /** Espera a que todo lo encolado haya salido (o se haya descartado). */
  async flush(): Promise<void> {
    for (;;) {
      const workers = [...this.chats.values()].flatMap((c) => (c.worker ? [c.worker] : []));
      if (workers.length === 0) return;
      await Promise.all(workers);
    }
  }

  /** Lo que quede en cola se descarta. */
  stop(): void {
    this.stopped = true;
    for (const chat of this.chats.values()) chat.items.length = 0;
  }

  private async drain(chatId: number, chat: ChatQueue): Promise<void> {
    while (!this.stopped && chat.items.length > 0) {
      const message = chat.items.shift()!;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !this.stopped; attempt++) {
        const wait = chat.lastSentAt + this.minIntervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        try {
          const { messageId } = await this.opts.api.sendMessage(chatId, message.text, {
            ...(message.keyboard ? { keyboard: message.keyboard } : {}),
          });
          chat.lastSentAt = Date.now();
          message.onSent?.(messageId);
          break;
        } catch (err) {
          chat.lastSentAt = Date.now();
          if (err instanceof TelegramApiError && err.kind === 'rate-limited') {
            await this.sleep(Math.max(1, err.retryAfterSec ?? 1) * 1000);
            continue;
          }
          log.warn('telegram send failed', {
            kind: err instanceof TelegramApiError ? err.kind : 'network',
          });
          break;
        }
      }
    }
  }
}

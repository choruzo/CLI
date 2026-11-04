/**
 * M18 — el cliente de la Bot API de Telegram (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Es el **único** sitio del repo que habla con `api.telegram.org`, y solo por
 * `fetch` global (sin dependencia nueva). El daemon no abre ningún puerto: los
 * mensajes llegan por *long polling* (`getUpdates`), nunca por webhook.
 *
 * El token va en la URL (así lo pide la API), así que ningún error que salga de
 * aquí lo lleva: se quita de cada mensaje antes de construir el error, y el
 * catálogo de secretos (`security/secrets.ts`) lo redacta además en los logs.
 *
 * Solo se modelan los campos que Stratum usa; el resto de lo que devuelve la
 * API se ignora. La respuesta se valida con Zod: algo que no casa es un error
 * `bad-response`, nunca un objeto a medias.
 */
import { z } from 'zod';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
/** Lo que Telegram acepta en un mensaje (en caracteres UTF-16). */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
/** Plazo de una petición corta; `getUpdates` suma su propio `timeout`. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Forma de un token de BotFather. No prueba que sea válido: eso lo dice `getMe`. */
export const TELEGRAM_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{35}$/;

export function isTelegramToken(token: string): boolean {
  return TELEGRAM_TOKEN_RE.test(token);
}

export type TelegramErrorKind =
  /** El token no vale (401) o el bot ya no existe. */
  | 'unauthorized'
  /** 429: esperar `retryAfterSec` antes de volver a intentarlo. */
  | 'rate-limited'
  /** Otra instancia está haciendo `getUpdates` con el mismo token (409). */
  | 'conflict'
  /** Sin red, DNS, plazo vencido. */
  | 'network'
  /** La API contestó, pero no con lo esperado. */
  | 'bad-response'
  /** Cualquier otro `ok: false` (400, 403…). */
  | 'api';

export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';

  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface TelegramUser {
  id: number;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramMessage {
  messageId: number;
  /** Segundos desde epoch, como lo da Telegram. */
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** Lleva algo que no es texto (foto, fichero, voz…). */
  hasMedia: boolean;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { messageId: number; chatId: number };
}

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramMessage;
  callbackQuery?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Filas de botones bajo un mensaje. */
export type InlineKeyboard = readonly (readonly InlineButton[])[];

export interface SendOptions {
  keyboard?: InlineKeyboard;
}

/** Lo que el canal necesita de la API. Los tests la sustituyen sin HTTP. */
export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(
    params: { offset?: number; timeoutSec: number },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: SendOptions,
  ): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: 'typing'): Promise<void>;
}

// ---------------------------------------------------------------------------
// Respuestas de la API (solo lo que se usa)
// ---------------------------------------------------------------------------

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const chatSchema = z.object({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
});

const MEDIA_KEYS = [
  'photo',
  'document',
  'voice',
  'audio',
  'video',
  'video_note',
  'sticker',
  'animation',
  'location',
  'contact',
] as const;

const messageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),
    chat: chatSchema,
    from: userSchema.optional(),
    text: z.string().optional(),
  })
  .passthrough();

const callbackSchema = z.object({
  id: z.string(),
  from: userSchema,
  data: z.string().optional(),
  message: z
    .object({ message_id: z.number().int(), chat: z.object({ id: z.number().int() }) })
    .passthrough()
    .optional(),
});

const updateSchema = z
  .object({
    update_id: z.number().int(),
    message: messageSchema.optional(),
    callback_query: callbackSchema.optional(),
  })
  .passthrough();

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).passthrough().optional(),
});

function toUser(u: z.infer<typeof userSchema>): TelegramUser {
  return {
    id: u.id,
    isBot: u.is_bot,
    firstName: u.first_name,
    ...(u.last_name !== undefined ? { lastName: u.last_name } : {}),
    ...(u.username !== undefined ? { username: u.username } : {}),
  };
}

function toMessage(m: z.infer<typeof messageSchema>): TelegramMessage {
  const raw = m as Record<string, unknown>;
  return {
    messageId: m.message_id,
    date: m.date,
    chat: { id: m.chat.id, type: m.chat.type },
    ...(m.from ? { from: toUser(m.from) } : {}),
    ...(m.text !== undefined ? { text: m.text } : {}),
    hasMedia: MEDIA_KEYS.some((k) => raw[k] !== undefined),
  };
}

/** Convierte un `update` crudo. Exportada para los tests. */
export function parseUpdate(raw: unknown): TelegramUpdate | null {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data;
  const cb = u.callback_query;
  return {
    updateId: u.update_id,
    ...(u.message ? { message: toMessage(u.message) } : {}),
    ...(cb
      ? {
          callbackQuery: {
            id: cb.id,
            from: toUser(cb.from),
            ...(cb.data !== undefined ? { data: cb.data } : {}),
            ...(cb.message
              ? { message: { messageId: cb.message.message_id, chatId: cb.message.chat.id } }
              : {}),
          },
        }
      : {}),
  };
}

function replyMarkup(keyboard: InlineKeyboard | undefined): Record<string, unknown> {
  // Sin teclado se manda uno vacío: al editar, así se quitan los botones.
  return {
    reply_markup: {
      inline_keyboard: (keyboard ?? []).map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

export interface HttpTelegramApiOptions {
  token: string;
  /** Para tests. En producción, siempre `api.telegram.org`. */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class HttpTelegramApi implements TelegramApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpTelegramApiOptions) {
    if (!isTelegramToken(opts.token)) {
      throw new TelegramApiError('unauthorized', 'That does not look like a bot token.');
    }
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** El token nunca sale en un mensaje de error. */
  private scrub(text: string): string {
    return text.split(this.token).join('<token>');
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal; extraTimeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs + (opts.extraTimeoutMs ?? 0));
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${TELEGRAM_API_ORIGIN}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const why = err instanceof Error ? err.message : String(err);
      throw new TelegramApiError('network', this.scrub(`Telegram ${method}: ${why}`));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new TelegramApiError(
        'bad-response',
        `Telegram ${method}: HTTP ${res.status} without JSON`,
        res.status,
      );
    }
    const env = envelopeSchema.safeParse(json);
    if (!env.success) {
      throw new TelegramApiError(
        'bad-response',
        `Telegram ${method}: unexpected answer`,
        res.status,
      );
    }
    if (env.data.ok) return env.data.result;
    const code = env.data.error_code ?? res.status;
    const description = this.scrub(env.data.description ?? `HTTP ${code}`);
    const message = `Telegram ${method}: ${description}`;
    if (code === 401 || code === 404) throw new TelegramApiError('unauthorized', message, code);
    if (code === 409) throw new TelegramApiError('conflict', message, code);
    if (code === 429) {
      const after = env.data.parameters?.retry_after;
      throw new TelegramApiError('rate-limited', message, code, after ?? 1);
    }
    throw new TelegramApiError('api', message, code);
  }

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    const parsed = userSchema.safeParse(await this.call('getMe', {}, { signal }));
    if (!parsed.success) throw new TelegramApiError('bad-response', 'Telegram getMe: no user');
    return toUser(parsed.data);
  }

  async getUpdates(
    params: { offset?: number; timeoutSec: number },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const result = await this.call(
      'getUpdates',
      {
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
        timeout: params.timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      },
      { signal, extraTimeoutMs: params.timeoutSec * 1000 },
    );
    if (!Array.isArray(result)) {
      throw new TelegramApiError('bad-response', 'Telegram getUpdates: not a list');
    }
    // Un update con forma rara se salta; `updateId` sigue haciendo falta para el offset.
    return result.flatMap((raw) => {
      const u = parseUpdate(raw);
      if (u) return [u];
      const id = (raw as { update_id?: unknown } | null)?.update_id;
      return typeof id === 'number' ? [{ updateId: id }] : [];
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<{ messageId: number }> {
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text,
      // Texto plano: lo que escribe el modelo no se interpreta como formato.
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard ? replyMarkup(opts.keyboard) : {}),
    });
    const id = (result as { message_id?: unknown } | null)?.message_id;
    if (typeof id !== 'number') {
      throw new TelegramApiError('bad-response', 'Telegram sendMessage: no message_id');
    }
    return { messageId: id };
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...replyMarkup(opts.keyboard),
    });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: id,
      ...(text !== undefined ? { text } : {}),
    });
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }
}

/**
 * M18 — aprobaciones y preguntas por un canal externo (`docs/PRD_STRATUM_DOT.md`
 * §23.11 y §23.13 A9).
 *
 * Cada solicitud pendiente del `ApprovalCenter`, **de cualquier sesión** (también
 * las pares), llega a los chats emparejados como una tarjeta con lo que enseña
 * Dot y, como mucho, dos botones: **Aprobar una vez** y **Denegar**. Lo que solo
 * se aprueba en Dot (forzado, con frase, una host key) va sin el de aprobar; las
 * preguntas de una sola pregunta con opciones, con un botón por opción; las de
 * texto libre y los planes, como aviso («en Dot»).
 *
 * Un botón lleva un token aleatorio que se busca **en memoria**: ni el id de la
 * solicitud ni la decisión viajan en claro, y el botón de un mensaje de otro
 * arranque (o de antes de un `reload`) no resuelve nada. Pulsarlo llama a
 * `ApprovalCenter.resolve` con el enlace del canal, y es el centro el que
 * aplica los límites (`checkChannelResolution`), sin fiarse de qué botones se
 * enseñaron. La carrera la decide `settle`, como siempre. Resuelta en cualquier
 * sitio, la tarjeta se edita (cómo y dónde) y pierde los botones.
 */
import { randomBytes } from 'crypto';
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import { channelAnswerable, channelApprovable } from '../protocol/index.js';
import type { InlineKeyboard, TelegramCallbackQuery } from '../channels/telegram/api.js';
import type { OutgoingMessage } from '../channels/telegram/outbox.js';
import {
  BUTTON,
  approvalCard,
  optionLabel,
  planCard,
  questionCard,
  resolvedLine,
  type SessionLabel,
} from '../channels/telegram/render.js';
import type { ApproverLink, PendingChange, Resolution } from './approval-center.js';

const log = getLogger('channels');

/** El enlace con el que un chat emparejado resuelve: `approve`, solo con botones. */
export const TELEGRAM_LINK: ApproverLink = {
  id: -1,
  client: null,
  capabilities: ['approve'],
  channel: 'telegram',
};

/** Tarjetas a la vez como mucho; las más antiguas dejan de tener botones vivos. */
const MAX_CARDS = 200;

export interface PendingSource {
  subscribe(listener: (change: PendingChange) => void): () => void;
  resolve(link: ApproverLink, resolution: Resolution): Promise<void>;
}

export interface CardTarget {
  sendMessage(chatId: number, message: OutgoingMessage): void;
  edit(chatId: number, messageId: number, text: string): void;
  answerCallback(id: string, text?: string): void;
}

export interface ChannelApprovalsOptions {
  approvals: PendingSource;
  target: () => CardTarget | null;
  chats: () => readonly number[];
  redact: (text: string) => string;
  sessionLabel: (sessionId: string) => SessionLabel | null;
  /** Tokens de los botones. Tests: deterministas. */
  makeToken?: () => string;
}

type Press =
  | { kind: 'approval'; requestId: string; sessionId: string; decision: 'approve' | 'deny' }
  | { kind: 'question'; requestId: string; sessionId: string; question: string; optionId: string };

interface Card {
  text: string;
  tokens: string[];
  sent: { chatId: number; messageId: number }[];
  /** Ya resuelta: el texto final, para lo que se envíe tarde. */
  final: string | null;
}

function newToken(): string {
  return randomBytes(9).toString('base64url');
}

export class ChannelApprovals {
  private readonly presses = new Map<string, Press>();
  private readonly cards = new Map<string, Card>();
  private unsubscribe: (() => void) | null = null;
  private readonly makeToken: () => string;

  constructor(private readonly opts: ChannelApprovalsOptions) {
    this.makeToken = opts.makeToken ?? newToken;
  }

  start(): void {
    this.unsubscribe ??= this.opts.approvals.subscribe((change) => this.onChange(change));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.reset();
  }

  /** Olvida tarjetas y botones (tras un `reload`): los de antes ya no resuelven nada. */
  reset(): void {
    this.presses.clear();
    this.cards.clear();
  }

  private onChange(change: PendingChange): void {
    if (change.type === 'closed') return this.close(change);
    const target = this.opts.target();
    const chats = this.opts.chats();
    if (!target || chats.length === 0) return;
    const session = this.opts.sessionLabel(change.dto.sessionId);
    let text: string;
    let keyboard: InlineKeyboard = [];
    const tokens: string[] = [];
    const button = (label: string, press: Press): { text: string; callbackData: string } => {
      const token = this.makeToken();
      this.presses.set(token, press);
      tokens.push(token);
      return { text: label, callbackData: `b:${token}` };
    };
    const { id: requestId, sessionId } = change.dto;
    if (change.kind === 'approval') {
      text = approvalCard(change.dto, session);
      const deny = button(BUTTON.deny, {
        kind: 'approval',
        requestId,
        sessionId,
        decision: 'deny',
      });
      keyboard = channelApprovable(change.dto)
        ? [
            [
              button(BUTTON.approve, {
                kind: 'approval',
                requestId,
                sessionId,
                decision: 'approve',
              }),
              deny,
            ],
          ]
        : [[deny]];
    } else if (change.kind === 'question') {
      const { questions } = change.dto;
      const answerable = channelAnswerable(questions);
      text = questionCard(questions, session, answerable);
      if (answerable) {
        const q = questions[0]!;
        keyboard = (q.options ?? []).map((o) => [
          button(optionLabel(o.label), {
            kind: 'question',
            requestId,
            sessionId,
            question: q.question,
            optionId: o.id,
          }),
        ]);
      }
    } else {
      text = planCard(session);
    }
    text = this.opts.redact(text);
    const card: Card = { text, tokens, sent: [], final: null };
    this.cards.set(requestId, card);
    this.trim();
    for (const chatId of chats) {
      target.sendMessage(chatId, {
        text,
        ...(keyboard.length > 0 ? { keyboard } : {}),
        onSent: (messageId) => {
          card.sent.push({ chatId, messageId });
          // Se resolvió mientras esperaba en la cola: sale ya sin botones.
          if (card.final !== null) this.opts.target()?.edit(chatId, messageId, card.final);
        },
      });
    }
  }

  private close(change: Extract<PendingChange, { type: 'closed' }>): void {
    const card = this.cards.get(change.id);
    if (!card) return;
    this.cards.delete(change.id);
    for (const token of card.tokens) this.presses.delete(token);
    card.final = `${card.text}\n\n${resolvedLine(change.resolution, change.by)}`;
    const target = this.opts.target();
    for (const { chatId, messageId } of card.sent) target?.edit(chatId, messageId, card.final);
  }

  /** Con muchas pendientes a la vez, las más antiguas pierden sus botones (siguen en Dot). */
  private trim(): void {
    while (this.cards.size > MAX_CARDS) {
      const [oldest, card] = this.cards.entries().next().value as [string, Card];
      this.cards.delete(oldest);
      for (const token of card.tokens) this.presses.delete(token);
    }
  }

  /** Un botón pulsado en un chat emparejado. */
  async onCallback(query: TelegramCallbackQuery): Promise<void> {
    const target = this.opts.target();
    const token = query.data?.startsWith('b:') ? query.data.slice(2) : null;
    const press = token ? this.presses.get(token) : undefined;
    if (!press) {
      target?.answerCallback(query.id, 'This button is no longer valid. Check Dot.');
      return;
    }
    const resolution: Resolution =
      press.kind === 'approval'
        ? {
            kind: 'approval',
            id: press.requestId,
            sessionId: press.sessionId,
            decision: press.decision,
          }
        : {
            kind: 'question',
            id: press.requestId,
            sessionId: press.sessionId,
            answers: [{ question: press.question, answer: '', optionId: press.optionId }],
          };
    try {
      await this.opts.approvals.resolve(TELEGRAM_LINK, resolution);
      target?.answerCallback(
        query.id,
        press.kind === 'question'
          ? 'Answered.'
          : press.decision === 'approve'
            ? 'Approved.'
            : 'Denied.',
      );
    } catch (err) {
      const code = err instanceof ProtocolError ? err.code : 'INTERNAL_ERROR';
      log.info('telegram resolution not applied', { code });
      target?.answerCallback(
        query.id,
        code === 'ALREADY_RESOLVED' || code === 'NOT_FOUND'
          ? 'Already resolved.'
          : code === 'INVALID_PARAMS'
            ? 'This one has to be resolved in Dot.'
            : code === 'UNAVAILABLE'
              ? 'Its session cannot take an answer right now. Try in Dot.'
              : 'Could not resolve it.',
      );
    }
  }
}

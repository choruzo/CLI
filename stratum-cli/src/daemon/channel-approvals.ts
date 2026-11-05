/**
 * M18 — aprobaciones, preguntas y planes por un canal externo
 * (`docs/PRD_STRATUM_DOT.md` §23.11 y §23.13 A9).
 *
 * Cada solicitud pendiente del `ApprovalCenter`, **de cualquier sesión** (también
 * las pares), llega a los chats emparejados como una tarjeta con lo que enseña
 * Dot:
 *
 * - Una aprobación, con dos botones como mucho: **Aprobar una vez** y
 *   **Denegar**. Lo que solo se aprueba en Dot (forzado, con frase, una host
 *   key) va sin el de aprobar.
 * - Una tanda de preguntas (parte 6C), **de una en una**: cada pregunta con un
 *   botón por opción y *Skip questions* (omitir la tanda). Si admite texto
 *   libre, el **siguiente mensaje** de ese chat es la respuesta y no llega al
 *   asistente. Con varias tandas abiertas en un chat, el texto contesta a la más
 *   antigua. Al contestar la última se resuelve la tanda entera.
 * - Un plan (parte 6C): **Aprobar plan** y **Rechazar**, sin editarlo. Aprobarlo
 *   no aprueba ninguna acción: cada una sigue pidiendo la suya.
 *
 * Un botón lleva un token aleatorio que se busca **en memoria**: ni el id de la
 * solicitud ni la decisión viajan en claro, y el botón de un mensaje de otro
 * arranque (o de antes de un `reload`) no resuelve nada. Resolver llama a
 * `ApprovalCenter.resolve` con el enlace del canal, y es el centro el que
 * aplica los límites (`checkChannelResolution`), sin fiarse de qué botones se
 * enseñaron. La carrera la decide `settle`, como siempre. Resuelta en cualquier
 * sitio, cada mensaje de la tarjeta se edita (cómo y dónde) y pierde los botones.
 */
import { randomBytes } from 'crypto';
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import {
  channelApprovable,
  type ProtocolQuestion,
  type ProtocolQuestionAnswer,
} from '../protocol/index.js';
import type { InlineKeyboard, TelegramCallbackQuery } from '../channels/telegram/api.js';
import type { OutgoingMessage } from '../channels/telegram/outbox.js';
import {
  BUTTON,
  QUESTION_TEXT,
  acceptsText,
  approvalCard,
  optionLabel,
  planCard,
  questionCard,
  questionStep,
  resolvedLine,
  type SessionLabel,
} from '../channels/telegram/render.js';
import type { ApproverLink, PendingChange, Resolution } from './approval-center.js';

const log = getLogger('channels');

/** El enlace con el que un chat emparejado resuelve: `approve`, con los límites del canal. */
export const TELEGRAM_LINK: ApproverLink = {
  id: -1,
  client: null,
  capabilities: ['approve'],
  channel: 'telegram',
};

/** Tarjetas a la vez como mucho; las más antiguas dejan de tener botones vivos. */
const MAX_CARDS = 200;
/** Una respuesta escrita, como mucho (lo que cabe en un mensaje de Telegram). */
const MAX_ANSWER_CHARS = 4096;

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
  | { kind: 'option'; requestId: string; chatId: number; step: number; optionId: string }
  | { kind: 'skip'; requestId: string; sessionId: string }
  | { kind: 'plan'; requestId: string; sessionId: string; decision: 'approve' | 'reject' };

interface Sent {
  chatId: number;
  messageId: number;
  text: string;
}

interface Card {
  kind: 'approval' | 'question' | 'plan';
  tokens: string[];
  sent: Sent[];
  /** Ya resuelta: la línea final, para lo que se envíe tarde. */
  final: string | null;
}

/** Una tanda de preguntas que se va contestando en un chat. */
interface Dialog {
  requestId: string;
  sessionId: string;
  questions: readonly ProtocolQuestion[];
  step: number;
  answers: ProtocolQuestionAnswer[];
}

function newToken(): string {
  return randomBytes(9).toString('base64url');
}

export class ChannelApprovals {
  private readonly presses = new Map<string, Press>();
  private readonly cards = new Map<string, Card>();
  /** Por chat, las tandas abiertas, de la más antigua a la más nueva. */
  private readonly dialogs = new Map<number, Dialog[]>();
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

  /** Olvida tarjetas, botones y tandas (tras un `reload`): lo de antes ya no resuelve nada. */
  reset(): void {
    this.presses.clear();
    this.cards.clear();
    this.dialogs.clear();
  }

  private button(card: Card, label: string, press: Press): { text: string; callbackData: string } {
    const token = this.makeToken();
    this.presses.set(token, press);
    card.tokens.push(token);
    return { text: label, callbackData: `b:${token}` };
  }

  /** Envía un mensaje de la tarjeta y lo apunta para editarlo al cerrarse. */
  private post(card: Card, chatId: number, text: string, keyboard: InlineKeyboard): void {
    const target = this.opts.target();
    if (!target) return;
    target.sendMessage(chatId, {
      text,
      ...(keyboard.length > 0 ? { keyboard } : {}),
      onSent: (messageId) => {
        card.sent.push({ chatId, messageId, text });
        // Se resolvió mientras esperaba en la cola: sale ya sin botones.
        if (card.final !== null)
          this.opts.target()?.edit(chatId, messageId, `${text}\n\n${card.final}`);
      },
    });
  }

  private onChange(change: PendingChange): void {
    if (change.type === 'closed') return this.close(change);
    const target = this.opts.target();
    const chats = this.opts.chats();
    if (!target || chats.length === 0) return;
    const session = this.opts.sessionLabel(change.dto.sessionId);
    const { id: requestId, sessionId } = change.dto;
    const card: Card = { kind: change.kind, tokens: [], sent: [], final: null };
    this.cards.set(requestId, card);
    this.trim();
    if (change.kind === 'question') {
      const { questions } = change.dto;
      const text = this.opts.redact(questionCard(questions, session));
      for (const chatId of chats) {
        const dialog: Dialog = { requestId, sessionId, questions, step: 0, answers: [] };
        const list = this.dialogs.get(chatId) ?? [];
        list.push(dialog);
        this.dialogs.set(chatId, list);
        this.post(card, chatId, text, this.stepKeyboard(card, chatId, dialog));
      }
      return;
    }
    let text: string;
    let keyboard: InlineKeyboard;
    if (change.kind === 'approval') {
      text = approvalCard(change.dto, session);
      const deny = this.button(card, BUTTON.deny, {
        kind: 'approval',
        requestId,
        sessionId,
        decision: 'deny',
      });
      keyboard = channelApprovable(change.dto)
        ? [
            [
              this.button(card, BUTTON.approve, {
                kind: 'approval',
                requestId,
                sessionId,
                decision: 'approve',
              }),
              deny,
            ],
          ]
        : [[deny]];
    } else {
      text = planCard(change.dto.plan, session);
      keyboard = [
        [
          this.button(card, BUTTON.approvePlan, {
            kind: 'plan',
            requestId,
            sessionId,
            decision: 'approve',
          }),
          this.button(card, BUTTON.rejectPlan, {
            kind: 'plan',
            requestId,
            sessionId,
            decision: 'reject',
          }),
        ],
      ];
    }
    text = this.opts.redact(text);
    for (const chatId of chats) this.post(card, chatId, text, keyboard);
  }

  /** Los botones de la pregunta en curso de una tanda: sus opciones y omitir. */
  private stepKeyboard(card: Card, chatId: number, dialog: Dialog): InlineKeyboard {
    const q = dialog.questions[dialog.step]!;
    const { requestId, sessionId, step } = dialog;
    return [
      ...(q.options ?? []).map((o) => [
        this.button(card, optionLabel(o.label), {
          kind: 'option',
          requestId,
          chatId,
          step,
          optionId: o.id,
        }),
      ]),
      [this.button(card, BUTTON.skip, { kind: 'skip', requestId, sessionId })],
    ];
  }

  /** La pregunta en curso de una tanda, como mensaje nuevo con sus botones. */
  private postStep(chatId: number, dialog: Dialog): void {
    const card = this.cards.get(dialog.requestId);
    if (!card) return;
    const q = dialog.questions[dialog.step]!;
    const text = this.opts.redact(questionStep(q, dialog.step, dialog.questions.length));
    this.post(card, chatId, text, this.stepKeyboard(card, chatId, dialog));
  }

  private close(change: Extract<PendingChange, { type: 'closed' }>): void {
    const card = this.cards.get(change.id);
    if (!card) return;
    this.forgetCard(change.id, card);
    card.final = resolvedLine(change.resolution, change.by, card.kind);
    const target = this.opts.target();
    for (const s of card.sent) target?.edit(s.chatId, s.messageId, `${s.text}\n\n${card.final}`);
  }

  private forgetCard(requestId: string, card: Card): void {
    this.cards.delete(requestId);
    for (const token of card.tokens) this.presses.delete(token);
    for (const [chatId, list] of this.dialogs) {
      const rest = list.filter((d) => d.requestId !== requestId);
      if (rest.length === 0) this.dialogs.delete(chatId);
      else this.dialogs.set(chatId, rest);
    }
  }

  /** Con muchas pendientes a la vez, las más antiguas pierden sus botones (siguen en Dot). */
  private trim(): void {
    while (this.cards.size > MAX_CARDS) {
      const [oldest, card] = this.cards.entries().next().value as [string, Card];
      this.forgetCard(oldest, card);
    }
  }

  /**
   * Un texto de un chat emparejado. Si ese chat tiene una tanda de preguntas
   * abierta, es la respuesta a su pregunta en curso y se queda aquí (`true`);
   * si no, es para el asistente (`false`).
   */
  async takeText(chatId: number, text: string): Promise<boolean> {
    const dialog = this.dialogs.get(chatId)?.[0];
    if (!dialog) return false;
    const q = dialog.questions[dialog.step]!;
    if (!acceptsText(q)) {
      this.opts.target()?.sendMessage(chatId, { text: QUESTION_TEXT.chooseOption });
      return true;
    }
    await this.answer(chatId, dialog, {
      question: q.question,
      answer: text.trim().slice(0, MAX_ANSWER_CHARS),
    });
    return true;
  }

  /** Apunta la respuesta de la pregunta en curso; con la última, resuelve la tanda. */
  private async answer(
    chatId: number,
    dialog: Dialog,
    answer: ProtocolQuestionAnswer,
  ): Promise<void> {
    dialog.answers.push(answer);
    dialog.step++;
    if (dialog.step < dialog.questions.length) return this.postStep(chatId, dialog);
    this.dropDialog(chatId, dialog);
    const ok = await this.submit({
      kind: 'question',
      id: dialog.requestId,
      sessionId: dialog.sessionId,
      answers: dialog.answers,
    });
    const text =
      ok === true
        ? QUESTION_TEXT.sent
        : ok === 'ALREADY_RESOLVED' || ok === 'NOT_FOUND'
          ? QUESTION_TEXT.already
          : QUESTION_TEXT.failed;
    this.opts.target()?.sendMessage(chatId, { text });
    this.nextDialog(chatId);
  }

  private dropDialog(chatId: number, dialog: Dialog): void {
    const rest = (this.dialogs.get(chatId) ?? []).filter((d) => d !== dialog);
    if (rest.length === 0) this.dialogs.delete(chatId);
    else this.dialogs.set(chatId, rest);
  }

  /** Terminada una tanda, la siguiente del chat vuelve a enseñar su pregunta en curso. */
  private nextDialog(chatId: number): void {
    const next = this.dialogs.get(chatId)?.[0];
    if (next) this.postStep(chatId, next);
  }

  /** Resuelve por el centro: `true`, o el código del error que lo impidió. */
  private async submit(resolution: Resolution): Promise<true | string> {
    try {
      await this.opts.approvals.resolve(TELEGRAM_LINK, resolution);
      return true;
    } catch (err) {
      const code = err instanceof ProtocolError ? err.code : 'INTERNAL_ERROR';
      log.info('telegram resolution not applied', { code });
      return code;
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
    if (press.kind === 'option') {
      const dialog = this.dialogs.get(press.chatId)?.find((d) => d.requestId === press.requestId);
      if (!dialog || dialog.step !== press.step) {
        target?.answerCallback(query.id, 'Already answered.');
        return;
      }
      target?.answerCallback(query.id);
      return this.answer(press.chatId, dialog, {
        question: dialog.questions[dialog.step]!.question,
        answer: '',
        optionId: press.optionId,
      });
    }
    const resolution: Resolution =
      press.kind === 'approval'
        ? {
            kind: 'approval',
            id: press.requestId,
            sessionId: press.sessionId,
            decision: press.decision,
          }
        : press.kind === 'plan'
          ? {
              kind: 'plan',
              id: press.requestId,
              sessionId: press.sessionId,
              decision: press.decision,
            }
          : { kind: 'question', id: press.requestId, sessionId: press.sessionId, answers: null };
    const outcome = await this.submit(resolution);
    if (outcome === true) {
      target?.answerCallback(query.id, doneText(press));
      return;
    }
    target?.answerCallback(
      query.id,
      outcome === 'ALREADY_RESOLVED' || outcome === 'NOT_FOUND'
        ? 'Already resolved.'
        : outcome === 'INVALID_PARAMS'
          ? 'This one has to be resolved in Dot.'
          : outcome === 'UNAVAILABLE'
            ? 'Its session cannot take an answer right now. Try in Dot.'
            : 'Could not resolve it.',
    );
  }
}

function doneText(press: Exclude<Press, { kind: 'option' }>): string {
  switch (press.kind) {
    case 'approval':
      return press.decision === 'approve' ? 'Approved.' : 'Denied.';
    case 'plan':
      return press.decision === 'approve' ? 'Plan approved.' : 'Plan rejected.';
    case 'skip':
      return QUESTION_TEXT.skipped;
  }
}

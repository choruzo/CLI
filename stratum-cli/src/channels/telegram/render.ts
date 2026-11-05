/**
 * M18 — lo que el bot escribe en Telegram: textos y botones, sin E/S.
 *
 * Todo esto es texto plano (sin `parse_mode`), así que aquí no se escapa nada:
 * lo que se escribe es lo que se ve. Solo la respuesta del asistente va con
 * formato, y la convierte `markdown.ts`.
 */
import {
  channelApprovable,
  clipText,
  type ProtocolApproval,
  type ProtocolPlan,
  type ProtocolQuestion,
  type ProtocolResolver,
} from '../../protocol/index.js';

/** El enlace que abre el chat con el bot y le manda `/start <código>`. */
export function pairingLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

export const TEXT = {
  candidate:
    'Code accepted. To finish, confirm the pairing in Dot (Assistant → Telegram) ' +
    'or in the terminal where you ran "stratum channels telegram pair". ' +
    'Until then this chat cannot talk to the assistant.',
  paired:
    'Paired. You can talk to the Dot assistant here, and approve its requests. ' +
    'Send /unpair to stop.',
  alreadyPaired: 'This chat is already paired with the Dot assistant. Send /unpair to stop.',
  unpaired: 'Unpaired. This chat no longer talks to the Dot assistant.',
  stale:
    'This message arrived while Stratum was not running, so it was not passed on. ' +
    'Send it again if it still matters.',
  textOnly:
    'Only text and images for now: files, voice messages and the like are not passed to the assistant.',
  /** La entrada de una foto que llega sin texto. */
  photoInput: '(photo)',
  tooLarge:
    'That message is too long to pass while the assistant is working. ' +
    'Send it shorter, or again when it finishes.',
  cancelled: 'The assistant stopped (cancelled).',
} as const;

/** Lo que alguien escribió en Dot, reflejado en el chat. */
export function fromDot(text: string): string {
  return `In Dot: ${text}`;
}

/** Un aviso de la sesión del asistente. */
export function warningLine(message: string): string {
  return `Warning: ${message}`;
}

/** Por qué una foto del chat no se pasó al asistente (parte 6E). */
export function imageRejected(err: unknown): string {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (kind === 'too-large') return 'That image is larger than 5 MB: it was not passed on.';
  if (err instanceof Error && err.name === 'UserImageError') {
    return 'That file is not a PNG, JPEG, WebP or GIF image of up to 5 MB: it was not passed on.';
  }
  return 'That image could not be downloaded from Telegram: it was not passed on. Try again.';
}

export function turnFailed(error: string | undefined): string {
  return error ? `The assistant's turn failed: ${error}` : "The assistant's turn failed.";
}

export function unavailable(reason: string): string {
  return `The assistant is not available right now (${reason}). Nothing was passed on.`;
}

export function routineFinished(name: string, status: string, summary: string | null): string {
  const head = `Routine "${name}" ${status === 'completed' ? 'finished' : `ended: ${status}`}.`;
  return summary ? `${head}\n\n${summary}` : head;
}

/** Telegram corta en 4096; se deja margen. */
export const CHUNK_CHARS = 4000;

/**
 * Parte un texto en trozos que caben en un mensaje, por párrafos o líneas si
 * puede y sin partir un par de surrogates. Nunca devuelve un trozo vacío.
 */
export function chunkText(text: string, max: number = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Un comando del bot (`/start abc`, `/unpair@MiBot`) o `null` si el texto no lo es. */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/is.exec(text.trim());
  if (!m) return null;
  return { command: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() };
}

/** Nombre visible de un usuario de Telegram, acotado. */
export function displayName(user: { firstName: string; lastName?: string }): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return (name || 'Telegram user').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Aprobaciones y preguntas (parte 4)
// ---------------------------------------------------------------------------

/** Lo que se enseña de la sesión que pide algo (como la tarjeta de Dot). */
export interface SessionLabel {
  title?: string;
  agent?: string;
  origin?: string;
  cwd?: string;
  routine?: string;
}

/** Un mensaje con botones no se trocea: se recorta para que quepa entero. */
const CARD_CHARS = 3500;

export const BUTTON = {
  approve: 'Approve once',
  deny: 'Deny',
  skip: 'Skip questions',
  approvePlan: 'Approve plan',
  rejectPlan: 'Reject',
} as const;

export function sessionLine(s: SessionLabel | null): string {
  if (!s) return 'Session: unknown';
  const who = [s.agent, s.origin ? `from ${s.origin}` : undefined].filter(Boolean).join(', ');
  const name = s.routine ? `routine "${s.routine}"` : (s.title ?? 'untitled');
  return `Session: ${name}${who ? ` (${who})` : ''}${s.cwd ? `\nFolder: ${s.cwd}` : ''}`;
}

/** Por qué una aprobación no se puede aprobar desde el chat, o `null`. */
export function onlyInDotReason(
  a: Pick<ProtocolApproval, 'kind' | 'forced' | 'confirmPhrase'>,
): string | null {
  if (channelApprovable(a)) return null;
  if (a.kind === 'host-key') return 'it trusts a new SSH host key';
  if (a.confirmPhrase !== undefined) return 'it needs its confirmation phrase';
  return 'a policy requires confirming it in Dot';
}

export function approvalCard(a: ProtocolApproval, session: SessionLabel | null): string {
  const lines = [
    'Approval needed',
    sessionLine(session),
    '',
    `${a.tool}${a.target ? ` on ${a.target}` : ''}${a.environment ? ` [${a.environment.name}, ${a.environment.tier}]` : ''}`,
    a.description,
  ];
  if (a.reason) lines.push(`Why: ${a.reason}`);
  const only = onlyInDotReason(a);
  if (only) lines.push('', `Approve it in Dot: ${only}. You can still deny it here.`);
  return clipText(lines.join('\n'), CARD_CHARS);
}

/** ¿Se contesta escribiendo? Sin opciones, o con opciones que admiten otra respuesta. */
export function acceptsText(q: ProtocolQuestion): boolean {
  return (q.options?.length ?? 0) === 0 || q.allowCustom === true;
}

/**
 * Una pregunta de la tanda (6C), de una en una: la `step`-ésima de `total`. Con
 * texto libre, el siguiente mensaje del chat es la respuesta.
 */
export function questionStep(q: ProtocolQuestion, step: number, total: number): string {
  const head = total > 1 ? `Question ${step + 1} of ${total}: ` : '';
  const how = acceptsText(q)
    ? (q.options?.length ?? 0) > 0
      ? 'Choose an option, or reply in this chat with your own answer.'
      : 'Reply in this chat with your answer.'
    : 'Choose an option.';
  return clipText(`${head}${q.question}\n\n${how}`, CARD_CHARS);
}

export function questionCard(
  questions: readonly ProtocolQuestion[],
  session: SessionLabel | null,
): string {
  const lines = ['The assistant asks', sessionLine(session), ''];
  if (questions.length > 1) lines.push(`${questions.length} questions, one at a time.`, '');
  lines.push(questionStep(questions[0]!, 0, questions.length));
  return clipText(lines.join('\n'), CARD_CHARS);
}

/** Lo que queda en el chat cuando la respuesta va escrita. */
export const QUESTION_TEXT = {
  chooseOption: 'That question needs one of its options: use the buttons, or Skip questions.',
  sent: 'Answers sent.',
  skipped: 'Questions skipped: the assistant continues with its own assumptions.',
  already: 'Those questions were already resolved elsewhere.',
  failed: 'Those answers were not passed on. Answer it in Dot.',
} as const;

export function planCard(plan: ProtocolPlan, session: SessionLabel | null): string {
  const lines = ['A plan is waiting for your decision', sessionLine(session), '', plan.summary];
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
  lines.push(
    '',
    'Approving the plan does not approve its actions: each one still asks. To edit it, use Dot.',
  );
  return clipText(lines.join('\n'), CARD_CHARS);
}

/** Etiqueta de un botón de opción, acotada. */
export function optionLabel(label: string): string {
  return clipText(label, 60);
}

function where(by: ProtocolResolver | undefined): string {
  if (!by) return '';
  switch (by.kind) {
    case 'channel':
      return ' from Telegram';
    case 'remote':
      return by.client === 'dot' ? ' in Dot' : by.client ? ` in ${by.client}` : ' elsewhere';
    case 'local':
      return ' in its terminal';
    default:
      return '';
  }
}

/** La línea que se añade a la tarjeta cuando se resuelve, en cualquier sitio. */
export function resolvedLine(
  resolution: string,
  by: ProtocolResolver | undefined,
  kind: 'approval' | 'question' | 'plan' = 'approval',
): string {
  if (by?.kind === 'timeout' || resolution === 'expired')
    return '— Expired: nobody answered in time.';
  if (resolution === 'cancelled') return '— Cancelled (the run ended or the session closed).';
  if (by?.kind === 'policy') return '— Resolved by policy.';
  if (resolution === 'approved') return `— Approved${where(by)}.`;
  if (resolution === 'denied') return `— Denied${where(by)}.`;
  return `— ${kind === 'plan' ? 'Decided' : 'Answered'}${where(by)}.`;
}

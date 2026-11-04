/**
 * M18 — lo que el bot escribe en Telegram: textos y botones, sin E/S.
 *
 * Todo es texto plano (`sendMessage` nunca usa `parse_mode`), así que aquí no
 * se escapa nada: lo que se escribe es lo que se ve.
 */

/** El enlace que abre el chat con el bot y le manda `/start <código>`. */
export function pairingLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

export const TEXT = {
  candidate:
    'Code accepted. To finish, confirm the pairing in Dot (Settings → Telegram). ' +
    'Until then this chat cannot talk to the assistant.',
  paired:
    'Paired. You can talk to the Dot assistant here, and approve its requests. ' +
    'Send /unpair to stop.',
  alreadyPaired: 'This chat is already paired with the Dot assistant. Send /unpair to stop.',
  unpaired: 'Unpaired. This chat no longer talks to the Dot assistant.',
  stale:
    'This message arrived while Stratum was not running, so it was not passed on. ' +
    'Send it again if it still matters.',
  textOnly: 'Only text for now: photos, files and voice messages are not passed to the assistant.',
  tooLarge:
    'That message is too long to pass while the assistant is working. ' +
    'Send it shorter, or again when it finishes.',
  cancelled: 'The assistant stopped (cancelled).',
} as const;

/** Lo que alguien escribió en Dot, reflejado en el chat. */
export function fromDot(text: string): string {
  return `In Dot: ${text}`;
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

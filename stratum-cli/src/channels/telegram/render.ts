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
} as const;

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

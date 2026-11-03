/**
 * Slash-commands de Desktop. Desde M12 cada uno es una capacidad de Stratum
 * (protocolo) o de la interfaz: ya no hay `/clear` ni `/compact` (eran del
 * runtime propio de Desktop; la compactación la decide la sesión, M11).
 * Puro, para los tests.
 */

export type CommandName = 'new' | 'model' | 'context' | 'settings' | 'imagen';

export interface SlashCommand {
  name: CommandName;
  description: string;
  /** Texto de ayuda del argumento; sin él, el comando se ejecuta al elegirlo. */
  args?: string;
  /** Sin argumento no hace nada útil: se avisa en vez de ejecutarlo. */
  argRequired?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'new', description: 'Empezar una conversación nueva' },
  { name: 'model', args: '[modelo]', description: 'Ver o cambiar el modelo de esta sesión' },
  { name: 'context', description: 'Ver el contexto y la memoria de esta sesión' },
  { name: 'settings', description: 'Ajustes de Stratum Desktop' },
  {
    name: 'imagen',
    args: '<descripción>',
    argRequired: true,
    description: 'Generar una imagen con el modelo de imágenes',
  },
];

/**
 * Mensaje que manda `/imagen`: el asistente escribe la petición al modelo de
 * imágenes (prompt detallado, tamaño) a partir de la descripción, con la skill
 * `stratum-images`. Es un mensaje normal: queda en la conversación tal cual.
 */
export function imageRequest(description: string): string {
  // Corto: es también el título de una conversación nueva. El prompt del
  // asistente (`# Images`) ya le dice que use `generate_image`.
  return `Genera una imagen: ${description.trim()}`;
}

/**
 * Comandos que encajan con lo escrito, o `null` si no hay que mostrar el menú:
 * solo mientras se escribe el nombre (empieza por `/` y aún no hay espacio).
 */
export function matchCommands(input: string): SlashCommand[] | null {
  if (!input.startsWith('/') || /\s/.test(input)) return null;
  const q = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

export type ParsedCommand =
  | { ok: true; name: CommandName; arg: string }
  | { ok: false; error: string };

/** `null` si no es un comando (no empieza por `/`): se envía como mensaje. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const name = match?.[1]?.toLowerCase() ?? '';
  // `/etc/hosts no arranca…` es un mensaje, no un comando.
  if (!/^[a-z][a-z_-]*$/.test(name)) return null;
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return { ok: false, error: `Comando desconocido: /${name}. Escribe / para ver los disponibles.` };
  const arg = (match?.[2] ?? '').trim();
  if (arg && !cmd.args) return { ok: false, error: `/${cmd.name} no admite argumentos.` };
  if (!arg && cmd.argRequired) {
    return { ok: false, error: `Escribe qué quieres después de /${cmd.name}: /${cmd.name} ${cmd.args ?? ''}`.trim() };
  }
  return { ok: true, name: cmd.name, arg };
}

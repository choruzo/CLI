/**
 * Slash-commands del modo Chat (D4). Catálogo reducido: los de código
 * (`/init`, `/changes`, `/plan`, `/agent`) llegan con el modo Code (D8).
 * Puro, para los tests.
 */

export type CommandName = 'new' | 'clear' | 'compact' | 'model' | 'memory' | 'settings';

export interface SlashCommand {
  name: CommandName;
  description: string;
  /** Texto de ayuda del argumento; sin él, el comando se ejecuta al elegirlo. */
  args?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'new', description: 'Empezar una conversación nueva' },
  { name: 'clear', description: 'Vaciar esta conversación (sus ficheros se conservan)' },
  { name: 'compact', description: 'Comprimir el contexto ahora' },
  { name: 'model', args: '[modelo]', description: 'Ver o cambiar el modelo de esta conversación' },
  { name: 'memory', description: 'Ver y editar la memoria global' },
  { name: 'settings', description: 'Ajustes de Stratum' },
];

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
  return { ok: true, name: cmd.name, arg };
}

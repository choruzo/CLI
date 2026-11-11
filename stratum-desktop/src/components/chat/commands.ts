/**
 * Slash-commands de Desktop. Desde M12 cada uno es una capacidad de Stratum
 * (protocolo) o de la interfaz: ya no hay `/clear` ni `/compact` (eran del
 * runtime propio de Desktop; la compactación la decide la sesión, M11).
 * Puro, para los tests.
 */

import type { AppMode } from '../../view/mode';

export type CommandName =
  | 'new'
  | 'model'
  | 'context'
  | 'settings'
  | 'imagen'
  | 'agent'
  | 'readonly'
  | 'changes'
  | 'jobs'
  | 'undo'
  | 'plan'
  | 'profile'
  | 'tools'
  | 'env'
  | 'plugins'
  | 'browser';

export interface SlashCommand {
  name: CommandName;
  description: string;
  /** Texto de ayuda del argumento; sin él, el comando se ejecuta al elegirlo. */
  args?: string;
  /** Sin argumento no hace nada útil: se avisa en vez de ejecutarlo. */
  argRequired?: boolean;
  /** Solo en este modo; sin él, en los dos. */
  mode?: AppMode;
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
    mode: 'chat',
  },
  {
    name: 'plan',
    args: '<tarea>',
    argRequired: true,
    description: 'Planificar antes de tocar nada: el agente propone un plan y espera tu aprobación',
    mode: 'code',
  },
  { name: 'agent', args: '[perfil]', description: 'Ver o cambiar el perfil de agente de esta sesión', mode: 'code' },
  { name: 'readonly', description: 'Poner o quitar el modo de solo lectura de esta sesión', mode: 'code' },
  {
    name: 'profile',
    args: '[perfil]',
    description: 'Ver o cambiar el perfil de sesión (code, infra, full, auto): qué tools ve el modelo',
    mode: 'code',
  },
  { name: 'tools', description: 'Ver las tools de esta sesión (integradas y MCP)', mode: 'code' },
  { name: 'env', description: 'Ver los entornos definidos, sus reglas y el contexto activo', mode: 'code' },
  { name: 'plugins', description: 'Ver los plugins de esta sesión y los omitidos', mode: 'code' },
  { name: 'changes', description: 'Ver los cambios del árbol de trabajo (git)', mode: 'code' },
  { name: 'jobs', description: 'Ver los procesos en segundo plano de esta sesión', mode: 'code' },
  { name: 'undo', description: 'Deshacer los ficheros del último turno', mode: 'code' },
  { name: 'browser', args: '[dirección]', description: 'Abrir el navegador de la sesión' },
];

/** Los comandos de un modo, en el orden del menú. */
export function commandsFor(mode: AppMode): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => !c.mode || c.mode === mode);
}

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
export function matchCommands(input: string, mode: AppMode = 'chat'): SlashCommand[] | null {
  if (!input.startsWith('/') || /\s/.test(input)) return null;
  const q = input.slice(1).toLowerCase();
  return commandsFor(mode).filter((c) => c.name.startsWith(q));
}

export type ParsedCommand =
  | { ok: true; name: CommandName; arg: string }
  | { ok: false; error: string };

/** `null` si no es un comando (no empieza por `/`): se envía como mensaje. */
export function parseCommand(text: string, mode: AppMode = 'chat'): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const name = match?.[1]?.toLowerCase() ?? '';
  // `/etc/hosts no arranca…` es un mensaje, no un comando.
  if (!/^[a-z][a-z_-]*$/.test(name)) return null;
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return { ok: false, error: `Comando desconocido: /${name}. Escribe / para ver los disponibles.` };
  if (cmd.mode && cmd.mode !== mode) {
    return { ok: false, error: `/${cmd.name} es del modo ${cmd.mode === 'code' ? 'Código' : 'Chat'}.` };
  }
  const arg = (match?.[2] ?? '').trim();
  if (arg && !cmd.args) return { ok: false, error: `/${cmd.name} no admite argumentos.` };
  if (!arg && cmd.argRequired) {
    return { ok: false, error: `Escribe qué quieres después de /${cmd.name}: /${cmd.name} ${cmd.args ?? ''}`.trim() };
  }
  return { ok: true, name: cmd.name, arg };
}

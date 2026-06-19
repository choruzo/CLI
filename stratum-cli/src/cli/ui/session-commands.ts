/**
 * Registro central de /comandos de sesión (UI §5.2).
 * Solo se listan comandos implementados; los hitos siguientes añaden aquí
 * los suyos (/tools en H4, /memory list|search|forget en H5, /provider en H6).
 */

export interface SessionCommand {
  name: string;
  description: string;
  /**
   * true → al confirmar con Enter el comando se completa en el input con un
   * espacio final (espera argumentos) en lugar de ejecutarse directamente.
   */
  hasArgs: boolean;
}

export const SESSION_COMMANDS: SessionCommand[] = [
  { name: '/help', description: 'Lista todos los comandos disponibles', hasArgs: false },
  {
    name: '/init',
    description: 'Escanea el proyecto y genera o actualiza STRATUM.md',
    hasArgs: false,
  },
  {
    name: '/memory show',
    description: 'Muestra el contenido del STRATUM.md activo',
    hasArgs: false,
  },
  {
    name: '/memory list',
    description: 'Lista las decisiones almacenadas en memoria a largo plazo',
    hasArgs: false,
  },
  {
    name: '/memory search',
    description: 'Búsqueda semántica de decisiones (requiere consulta)',
    hasArgs: true,
  },
  {
    name: '/memory forget',
    description: 'Elimina una decisión por id (requiere id)',
    hasArgs: true,
  },
  {
    name: '/model',
    description: 'Selector de modelos del provider activo (solo esta sesión)',
    hasArgs: false,
  },
  {
    name: '/provider',
    description: 'Cambia el provider activo en esta sesión (sin args: lista los configurados)',
    hasArgs: true,
  },
  {
    name: '/config_provider',
    description: 'Edita el provider activo y guarda en .stratumrc.json',
    hasArgs: false,
  },
  {
    name: '/tools',
    description: 'Lista todas las tools disponibles (built-in + MCP)',
    hasArgs: false,
  },
  { name: '/quit', description: 'Termina la sesión y guarda el historial', hasArgs: false },
  { name: '/exit', description: 'Termina la sesión y guarda el historial', hasArgs: false },
];

/**
 * Filtrado del panel (§5.2): substring match sobre el nombre, no solo prefijo.
 * `/mem` → `/memory show` · `/show` → `/memory show` · sin match → lista vacía.
 */
export function filterCommands(
  input: string,
  commands: SessionCommand[] = SESSION_COMMANDS,
): SessionCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const needle = trimmed.slice(1).toLowerCase();
  if (!needle) return commands;
  return commands.filter((c) => c.name.slice(1).toLowerCase().includes(needle));
}

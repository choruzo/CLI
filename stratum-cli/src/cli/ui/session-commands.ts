/**
 * Registro central de /comandos de sesión (UI §5.2).
 * Solo se listan comandos implementados. La tabla de §5.2 quedó cubierta por
 * completo en el Hito 10 (/clear, /compact, /context, /debug, /mcp reload,
 * /sessions *, /config get|set).
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
    name: '/plan',
    description: 'Planifica una tarea (read-only), pide aprobación y la ejecuta paso a paso',
    hasArgs: true,
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
  {
    name: '/subagents',
    description: 'Inspecciona el transcript de un subagente de la sesión (read-only)',
    hasArgs: false,
  },
  {
    name: '/agents',
    description: 'Lista los perfiles de agente (global y proyecto) y los inválidos',
    hasArgs: false,
  },
  {
    name: '/agent',
    description: 'Usa un perfil como agente principal (sin args: lista · off: desactiva)',
    hasArgs: true,
  },
  {
    name: '/clear',
    description: 'Purga la conversación y el contexto del LLM (la sesión sigue activa)',
    hasArgs: false,
  },
  {
    name: '/compact',
    description: 'Fuerza la compresión del contexto ahora, sin esperar al umbral',
    hasArgs: false,
  },
  {
    name: '/context',
    description: 'Estadísticas de uso del contexto actual',
    hasArgs: false,
  },
  {
    name: '/todo',
    description: 'Colapsa o despliega el panel de tareas del agente (Ctrl+T)',
    hasArgs: false,
  },
  {
    name: '/changes',
    description: 'Muestra los cambios del working tree (+N/-M por fichero)',
    hasArgs: false,
  },
  {
    name: '/debug',
    description: 'Activa o desactiva la visualización de los bloques ⊙ thinking',
    hasArgs: false,
  },
  {
    name: '/mcp reload',
    description: 'Reinicia todos los MCP servers sin salir del proceso',
    hasArgs: false,
  },
  {
    name: '/sessions list',
    description: 'Lista las sesiones guardadas',
    hasArgs: false,
  },
  {
    name: '/sessions resume',
    description: 'Carga una sesión anterior y la continúa aquí (requiere id)',
    hasArgs: true,
  },
  {
    name: '/sessions delete',
    description: 'Elimina una sesión guardada por id (requiere id)',
    hasArgs: true,
  },
  {
    name: '/config get',
    description: 'Muestra el valor de una clave de configuración (dot-path)',
    hasArgs: true,
  },
  {
    name: '/config set',
    description: 'Cambia una clave de configuración y la persiste en .stratumrc.json',
    hasArgs: true,
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

/**
 * Paleta de perfiles para `@perfil` (Hito 15). `filterCommands` exige `/`, así
 * que los perfiles tienen su propio filtro: solo el primer token tras `@` y
 * solo mientras no se haya escrito la tarea (con un espacio ya no hay nada que
 * completar).
 */
export function filterProfiles(
  input: string,
  profiles: Array<{ name: string; description: string }>,
): SessionCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('@') || /\s/.test(trimmed)) return [];
  const needle = trimmed.slice(1).toLowerCase();
  return profiles
    .filter((p) => p.name.includes(needle))
    .map((p) => ({ name: `@${p.name}`, description: p.description, hasArgs: true }));
}

/**
 * ¿Pide confirmación este comando por destructivo? Punto único de la decisión
 * (§12.5), sobre el **comando efectivo** que da `effectiveInvocations`: lo que
 * se ejecuta, no lo que aparece escrito.
 *
 * Tres ideas, en este orden:
 *
 *  1. **Quién se ejecuta.** Un patrón destructivo (`rm`, `dd`, `Remove-Item`…)
 *     cuenta cuando es el ejecutable — también detrás de `sudo -u`, de un
 *     `sh -c`, de un `find -exec` o de una variable asignada en el mismo comando.
 *  2. **Lo que no se puede leer falla hacia el lado seguro.** Un ejecutable que
 *     sale de una variable o de una sustitución, o un intérprete que recibe su
 *     código por una tubería (`… | sh`), no se da por inocuo: pide confirmación.
 *  3. **Un argumento no es un comando.** El texto `rm -rf` dentro de un `grep`,
 *     de un `echo` o del mensaje de un commit no ejecuta nada. Solo se sigue
 *     buscando el patrón en los argumentos cuando el comando puede ejecutarlos
 *     (`psql -c "DROP …"`, un script propio, `ssh host "rm …"`).
 *
 * No es un intérprete de shell: ver «Qué cubre la guarda» en `docs/eval.md`.
 */
import {
  commandIsDestructive,
  effectiveInvocations,
  findDeletion,
  isWindowsDeleteCommand,
  splitCommandParts,
  tokenize,
  parseInvocation,
  windowsDestructiveCommand,
  type EffectiveInvocation,
} from './guards.js';
import { readOnlyCommandVerdict } from './readonly-commands.js';

/** Intérpretes que, sin fichero ni `-c`, ejecutan lo que les llega por stdin. */
const STDIN_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'pwsh',
  'powershell',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
  'php',
]);

/** `… | sh`, `… | sudo bash -s`, `… | python3 -`: el código viene por la tubería. */
function runsPipedCode(inv: EffectiveInvocation): boolean {
  if (!inv.piped || !STDIN_INTERPRETERS.has(inv.name.toLowerCase())) return false;
  if (inv.rest.some((t) => /^-[A-Za-z]*[ce]$/.test(t) || /^-(command|file)$/i.test(t))) {
    return false; // trae su propio código: lo que entra por la tubería son datos
  }
  if (inv.rest.includes('-s') || inv.rest.includes('-')) return true;
  return inv.rest.every((t) => t.startsWith('-'));
}

/**
 * Subcomandos de git cuyos argumentos son texto (un mensaje, un patrón de
 * búsqueda): nunca los ejecutan. `git rm`, `git clean` o `git rebase --exec` no
 * están aquí a propósito.
 */
const GIT_LITERAL_SUBCOMMANDS = new Set([
  'commit',
  'log',
  'grep',
  'tag',
  'show',
  'notes',
  'diff',
  'blame',
  'stash',
]);

/** ¿Son los argumentos de este segmento texto literal, que nadie va a ejecutar? */
function argumentsAreLiteral(segment: string): boolean {
  // Una sustitución ejecuta algo aunque esté dentro del argumento.
  if (/\$\(|`|<\(/.test(segment)) return false;
  if (readOnlyCommandVerdict(segment).readOnly) return true;
  const invocation = parseInvocation(tokenize(segment));
  if (invocation?.name !== 'git') return false;
  const sub = invocation.rest.find((t) => !t.startsWith('-'));
  return sub !== undefined && GIT_LITERAL_SUBCOMMANDS.has(sub);
}

/**
 * Motivo por el que el comando pide confirmación, o `null`. `patterns` es
 * `tools.destructivePatterns`; lo intrínseco (ejecución opaca, `find -delete`,
 * borrados de PowerShell) no depende de la config, igual que la capa 1.
 */
export function destructiveCommandReason(command: string, patterns: string[]): string | null {
  for (const inv of effectiveInvocations(command)) {
    if (inv.dynamic) return inv.dynamic;
    if (patterns.includes(inv.name)) return inv.name;
    if (isWindowsDeleteCommand(inv.name)) return inv.name;
    if (inv.name === 'find' && findDeletion(inv.rest)) return 'find deleting what it matches';
    if (runsPipedCode(inv)) return `code piped into ${inv.name}`;
  }
  // Lo que queda es texto: el patrón solo cuenta en los segmentos cuyos
  // argumentos alguien puede ejecutar.
  for (const part of splitCommandParts(command)) {
    if (argumentsAreLiteral(part.text)) continue;
    if (commandIsDestructive(part.text, patterns)) return 'destructive pattern';
    const windows = windowsDestructiveCommand(part.text);
    if (windows) return windows;
  }
  return null;
}

/**
 * Hito 11 — Guardas de runtime por capas.
 *
 * Tres capas ordenadas, y el orden NO es negociable:
 *
 *  1. **Hard-deny** — patrones catastróficos e irreversibles. No dependen de la
 *     config: `tools.destructivePatterns` se puede vaciar en `.stratumrc.json`,
 *     y `rm -rf /` no puede depender de un fichero JSON. Rechazan con
 *     `recoverable: false` ANTES de la fase de confirmación: al usuario no se le
 *     pregunta por algo que nunca se va a ejecutar.
 *  2. **Comandos guardados** — mapa `clave → allow|confirm|block` configurable en
 *     `tools.guardedCommands`. `block` es absoluto (ni `--allow-destructive` ni
 *     el allow-all de sesión lo levantan); `confirm` entra por la vía normal de
 *     `isDestructive()` y por tanto sí cede ante allow/allow-all.
 *  3. **Rutas sensibles** — dos niveles. `blocked` (material criptográfico y
 *     credenciales) no se puede levantar de ninguna forma; `confirm` (.env,
 *     secrets/) pasa por `confirmDestructive` y admite allowlist en config.
 *
 * Adaptado de las guardas por capas de gentle-pi (Alan Buscaglia, MIT).
 * Ver CLI-DOC/Investigacion/gentle-pi.md §2.
 */

// ---------------------------------------------------------------------------
// Tokenización de comandos
// ---------------------------------------------------------------------------

/**
 * Parte un comando compuesto en segmentos ejecutables independientes. Un
 * `rm -rf /` escondido tras un `&&` sigue siendo un `rm -rf /`, así que cada
 * regla se evalúa por segmento y no sobre la cadena entera.
 */
export function splitCommandSegments(command: string): string[] {
  return splitCommandParts(command).map((p) => p.text);
}

/** Operador que precede a un segmento: `|` es una tubería; el resto solo encadena. */
export type SegmentOperator = '' | ';' | '|' | '||' | '&' | '&&';

export interface CommandPart {
  text: string;
  /** Qué lo une al segmento anterior (`''` en el primero). */
  op: SegmentOperator;
}

/**
 * Como `splitCommandSegments`, pero conservando el operador que precede a cada
 * segmento: hace falta para saber si un intérprete recibe su código por una
 * tubería (`… | sh`), que es lo único que distingue `sh` de `echo x | sh`.
 */
export function splitCommandParts(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let current = '';
  let op: SegmentOperator = '';
  let quote: string | null = null;
  const push = (next: SegmentOperator): void => {
    const text = current.trim();
    if (text) {
      parts.push({ text, op });
      op = next;
    } else if (next === '|' || op === '') {
      // Un segmento vacío no rompe la tubería que venía (`a | | b` no existe,
      // pero `a |& b` sí: el `&` no debe borrar el `|`).
      op = op === '|' ? '|' : next;
    }
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      push(';');
      continue;
    }
    if (ch === '|' || ch === '&') {
      const double = command[i + 1] === ch;
      push(double ? (`${ch}${ch}` as SegmentOperator) : ch);
      if (double) i++;
      continue;
    }
    current += ch;
  }
  push(';');
  return parts;
}

/** Tokeniza un segmento respetando comillas simples y dobles (las retira). */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) tokens.push(current);

  return tokens.filter((t) => t.length > 0);
}

/**
 * Nombre del ejecutable de un segmento, ignorando asignaciones de entorno y
 * envoltorios (`sudo`, `env`, `command`, `nohup`, …). Devuelve el basename para
 * que `/usr/bin/rm` y `rm` se traten igual. `rest` son los tokens que siguen.
 */
export function parseInvocation(tokens: string[]): { name: string; rest: string[] } | null {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    // VAR=value delante del comando
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    // Un comando entero entre comillas (`cmd /c "rd /s /q x"`) llega como un solo
    // token: se devuelve tal cual y `effectiveInvocations` lo vuelve a trocear.
    // Una ruta con espacios (`"C:\Program Files\Git\git.exe"`) no empieza por una
    // palabra suelta, así que sigue por el camino normal.
    if (/^[A-Za-z][\w.-]*\s/.test(tok)) return { name: tok, rest: tokens.slice(i + 1) };
    const base = tok.replace(/\\/g, '/').split('/').pop() ?? tok;
    const bare = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const wrapper = WRAPPERS[bare];
    if (wrapper) {
      i++;
      // Flags del envoltorio, con el valor de los que lo llevan (`sudo -u root`,
      // `nice -n 10`): sin saltarlo, `root` pasaba por ser el comando.
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        i += wrapper.valueFlags.includes(tokens[i]!) ? 2 : 1;
      }
      // Operandos propios antes del comando (`timeout 30 rm …`, `chroot /mnt rm …`).
      for (let n = 0; n < wrapper.operands && i < tokens.length; n++) i++;
      continue;
    }
    // `cmd /c del x` (Windows): el comando real va tras `/c` o `/k`.
    if (bare.toLowerCase() === 'cmd') {
      const run = tokens.findIndex((t, j) => j > i && /^\/[ck]$/i.test(t));
      if (run !== -1) {
        i = run + 1;
        continue;
      }
    }
    return { name: bare, rest: tokens.slice(i + 1) };
  }
  return null;
}

interface WrapperSpec {
  /** Flags que consumen el token siguiente. */
  valueFlags: readonly string[];
  /** Operandos del propio envoltorio antes del comando. */
  operands: number;
}

const wrapper = (valueFlags: readonly string[] = [], operands = 0): WrapperSpec => ({
  valueFlags,
  operands,
});

/**
 * Comandos que solo lanzan a otro: lo que cuenta es lo que envuelven. Lista
 * cerrada a propósito — no es un intérprete de shell —, con los flags que
 * consumen un valor para no confundir ese valor con el comando.
 */
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: wrapper(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t']),
  doas: wrapper(['-u', '-C']),
  env: wrapper(['-u', '-C', '--unset', '--chdir']),
  command: wrapper(),
  exec: wrapper(['-a']),
  nohup: wrapper(),
  setsid: wrapper(),
  time: wrapper(['-f', '-o']),
  nice: wrapper(['-n', '--adjustment']),
  ionice: wrapper(['-c', '-n', '-p']),
  stdbuf: wrapper(['-i', '-o', '-e']),
  timeout: wrapper(['-s', '-k', '--signal', '--kill-after'], 1),
  chroot: wrapper(['--userspec', '--groups'], 1),
  busybox: wrapper(),
  xargs: wrapper(['-n', '-I', '-P', '-L', '-d', '-a', '-s', '-E']),
};

// ---------------------------------------------------------------------------
// Comando efectivo
// ---------------------------------------------------------------------------

/** Una invocación tal como se va a ejecutar, una vez quitado lo que la envuelve. */
export interface EffectiveInvocation {
  /** Ejecutable (basename, sin extensión). */
  name: string;
  rest: string[];
  /** Segmento de primer nivel del que sale. */
  segment: string;
  /** Recibe su entrada por una tubería. */
  piped: boolean;
  /** 0 = escrita tal cual; >0 = dentro de un `sh -c`, un `find -exec`… */
  depth: number;
  /**
   * El ejecutable (o el código) se decide en tiempo de ejecución y no se puede
   * leer aquí: `$CMD args`, `$(…) args`, `pwsh -EncodedCommand`, `iex`.
   */
  dynamic?: string;
  /**
   * Envoltorios y prefijos que se saltaron para llegar al ejecutable (`sudo`,
   * `nohup`, `cmd`…), en minúsculas. Casi nunca importan —por eso se saltan—,
   * salvo los que cambian de quién es el proceso (`shellDetachReason`).
   */
  wrappers?: string[];
}

/** Shells que aceptan `-c "<comando>"`. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
/** Palabras de control de flujo que preceden a un comando (`then rm …`). */
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  '(',
]);
const SHELL_CLOSERS = new Set(['fi', 'done', '}', ')', 'esac']);
/** Operadores de PowerShell: `$a -eq 1` es una expresión, no `$a` ejecutándose. */
const PS_OPERATOR =
  /^(?:=|\+=|-=|\*=|\/=|-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|and|or|xor|not|join|split|replace|f|is|isnot|as|in|notin|contains|notcontains|band|bor|shl|shr))$/i;
const PLAIN_VARIABLE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
const MAX_NESTING = 2;

/** Quita los paréntesis y llaves de agrupación y las palabras de control. */
function stripGrouping(tokens: string[]): string[] {
  const out = tokens
    .map((t, i) => (i === 0 ? t.replace(/^[({]+/, '') : t))
    .map((t, i, all) => (i === all.length - 1 ? t.replace(/\)+$/, '') : t))
    .filter((t) => t.length > 0 && !SHELL_CLOSERS.has(t));
  let i = 0;
  while (i < out.length && SHELL_KEYWORDS.has(out[i]!)) i++;
  return out.slice(i).map((t, j) => (j === 0 ? t.replace(/^[({]+/, '') : t));
}

/** Sustituye `$VAR` / `${VAR}` por el valor que el propio comando le dio antes. */
function expandKnown(token: string, vars: ReadonlyMap<string, string>): string {
  if (vars.size === 0 || !token.includes('$')) return token;
  return token.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
    vars.has(name) ? vars.get(name)! : whole,
  );
}

/**
 * Las invocaciones que un comando va a ejecutar de verdad. Es el punto único
 * donde se deshace lo que esconde al ejecutable — sin ser un intérprete de
 * shell —, y todas las capas clasifican sobre su resultado:
 *
 *  - envoltorios (`sudo -u root`, `timeout 30`, `env X=1`, `nice`…) y agrupación
 *    (`( … )`, `{ …; }`, `then …`);
 *  - un nivel de comando interno: `sh -c "…"`, `pwsh -Command …`, `eval …`,
 *    `su -c "…"`, `find … -exec … ;` (y `cmd /c`, que ya resuelve
 *    `parseInvocation`). Hasta `MAX_NESTING` niveles;
 *  - variables asignadas en el mismo comando (`R=rm; $R -rf /`).
 *
 * Lo que no se puede resolver —el ejecutable sale de una variable desconocida,
 * de una sustitución o de código codificado— se marca `dynamic` en vez de
 * darse por inocuo: quien clasifica decide, y falla hacia el lado seguro.
 */
export function effectiveInvocations(
  command: string,
  depth = 0,
  inherited: ReadonlyMap<string, string> = new Map(),
): EffectiveInvocation[] {
  const found: EffectiveInvocation[] = [];
  const vars = new Map(inherited);

  for (const part of splitCommandParts(command)) {
    let tokens = stripGrouping(tokenize(part.text));
    if (tokens.length === 0) continue;

    // `R=rm` (o `export R=rm`) suelto: no ejecuta nada, pero se recuerda.
    const assigning = /^(export|declare|local|readonly|set)$/.test(tokens[0]!) ? 1 : 0;
    const assignments = tokens.slice(assigning);
    if (assignments.length > 0 && assignments.every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t))) {
      for (const t of assignments) {
        const eq = t.indexOf('=');
        vars.set(t.slice(0, eq), expandKnown(t.slice(eq + 1), vars));
      }
      continue;
    }

    tokens = tokens.flatMap((t, i) => {
      const expanded = expandKnown(t, vars);
      // El valor de una variable usada como comando puede traer sus argumentos.
      return i === 0 && expanded !== t ? tokenize(expanded) : [expanded];
    });
    const invocation = parseInvocation(tokens);
    if (!invocation) continue;
    const { name, rest } = invocation;
    const lower = name.toLowerCase();
    const entry: EffectiveInvocation = {
      name,
      rest,
      segment: part.text,
      piped: part.op === '|',
      depth,
    };
    const skipped = tokens
      .slice(0, Math.max(0, tokens.length - rest.length - 1))
      .map((t) => bareName(t).toLowerCase())
      .filter((t) => !t.startsWith('-') && !/^[a-z_][a-z0-9_]*=/.test(t));
    if (skipped.length > 0) entry.wrappers = skipped;

    if (name.startsWith('$(') || name.startsWith('`') || name.startsWith('<(')) {
      entry.dynamic = 'command substitution used as the executable';
    } else if (PLAIN_VARIABLE.test(name) && rest.length > 0 && !PS_OPERATOR.test(rest[0]!)) {
      entry.dynamic = `variable ${name} used as the executable`;
    } else if (lower === 'iex' || lower === 'invoke-expression') {
      entry.dynamic = 'Invoke-Expression runs a string as code';
    } else if (
      POWERSHELLS.has(lower) &&
      rest.some((t) => /^-(e|ec|enc|encodedcommand)$/i.test(t))
    ) {
      entry.dynamic = 'PowerShell -EncodedCommand hides the command';
    } else if (
      (SHELLS.has(lower) || lower === 'source' || name === '.') &&
      rest.some((t) => t.startsWith('<('))
    ) {
      entry.dynamic = 'process substitution run as a script';
    }
    found.push(entry);

    if (depth >= MAX_NESTING) continue;
    const nest = (inner: string): void => {
      for (const child of effectiveInvocations(inner, depth + 1, vars)) {
        found.push({ ...child, segment: part.text, piped: child.piped || entry.piped });
      }
    };

    // Un comando entero entre comillas: su contenido es el comando.
    if (/\s/.test(name)) {
      nest([name, ...rest].join(' '));
      continue;
    }
    if (SHELLS.has(lower) || lower === 'su') {
      const flag = rest.findIndex((t) => /^-[A-Za-z]*c$/.test(t));
      if (flag !== -1 && rest[flag + 1] !== undefined) nest(rest[flag + 1]!);
    } else if (POWERSHELLS.has(lower)) {
      const flag = rest.findIndex((t) => /^-(c|command)$/i.test(t));
      const inner = flag !== -1 ? rest.slice(flag + 1) : rest.filter((t) => !t.startsWith('-'));
      // `pwsh script.ps1` lanza un fichero: no hay comando interno que leer.
      if (inner.length > 0 && !(flag === -1 && /\.ps1$/i.test(inner[0]!))) nest(inner.join(' '));
    } else if (lower === 'eval') {
      if (rest.length > 0) nest(rest.join(' '));
    } else if (lower === 'find') {
      for (let i = 0; i < rest.length; i++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(rest[i]!)) continue;
        const end = rest.findIndex((t, j) => j > i && (t === ';' || t === '\\;' || t === '+'));
        const inner = parseInvocation(rest.slice(i + 1, end === -1 ? undefined : end));
        if (inner) found.push({ ...inner, segment: part.text, piped: false, depth: depth + 1 });
        if (end === -1) break;
        i = end;
      }
    }
  }
  return found;
}

/** Basename sin extensión de ejecutable: `/usr/bin/nohup` y `nohup.exe` son `nohup`. */
function bareName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** ¿Llevan los flags cortos agrupados alguna de estas letras? (`-rf` → r y f). */
function hasShortFlags(rest: string[], letters: string[]): boolean {
  const found = new Set<string>();
  for (const tok of rest) {
    if (!tok.startsWith('-') || tok.startsWith('--')) continue;
    for (const ch of tok.slice(1)) found.add(ch);
  }
  return letters.every((l) => found.has(l));
}

function hasLongFlag(rest: string[], ...names: string[]): boolean {
  return rest.some((tok) => names.some((n) => tok === n || tok.startsWith(`${n}=`)));
}

/** Argumentos posicionales (todo lo que no empieza por `-`). */
function positionals(rest: string[]): string[] {
  return rest.filter((tok) => !tok.startsWith('-'));
}

/** Primer subcomando de un comando tipo git: salta los flags globales (`git -C /repo push`). */
function subcommand(rest: string[]): { name: string | null; rest: string[] } {
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i]!;
    if (tok.startsWith('-')) {
      // `git -C <dir>` consume un argumento; `git --no-pager` no.
      if (tok === '-C' || tok === '-c' || tok === '--git-dir' || tok === '--work-tree') i += 2;
      else i++;
      continue;
    }
    return { name: tok, rest: rest.slice(i + 1) };
  }
  return { name: null, rest: [] };
}

// ---------------------------------------------------------------------------
// Capa 1 — Hard-deny (no configurable)
// ---------------------------------------------------------------------------

/** Rutas cuya destrucción recursiva no tiene vuelta atrás. */
const CATASTROPHIC_TARGETS = /^(?:\/|~|~\/\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\.|\.\.|\/\*)$/;

/**
 * Forma canónica de una ruta para compararla con las catastróficas: `//`,
 * `/.`, `/./`, `/etc/..` y `.//` son la raíz o el directorio actual escritos
 * de otra manera. Solo sintaxis: no toca el disco ni expande variables.
 */
export function normalizeTarget(path: string): string {
  const glob = /\/\*$/.test(path) || path === '*' ? '/*' : '';
  const body = glob ? path.slice(0, -1) : path;
  const prefix =
    /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(body)?.[0] ?? (body.startsWith('/') ? '/' : '');
  const parts: string[] = [];
  for (const part of body.slice(prefix.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    // Por encima de la raíz no hay nada: `/..` es `/`.
    else if (part === '..' && prefix === '/') continue;
    else parts.push(part);
  }
  const joined = parts.join('/');
  if (prefix === '/') return `/${joined}${joined ? glob : glob.slice(1)}`;
  if (prefix) return joined ? `${prefix}/${joined}${glob}` : `${prefix}${glob}`;
  return joined ? `${joined}${glob}` : glob ? '*' : '.';
}

const isCatastrophicTarget = (path: string): boolean =>
  CATASTROPHIC_TARGETS.test(path) || CATASTROPHIC_TARGETS.test(normalizeTarget(path));

/** Expresiones de `find` que no filtran qué se borra (y cuántos valores consumen). */
const FIND_NON_FILTERS: Readonly<Record<string, number>> = {
  '-delete': 0,
  '-xdev': 0,
  '-mount': 0,
  '-depth': 0,
  '-d': 0,
  '-print': 0,
  '-print0': 0,
  '-follow': 0,
  '-noleaf': 0,
  '-L': 0,
  '-H': 0,
  '-P': 0,
  '-mindepth': 1,
  '-maxdepth': 1,
};
const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;
/** Lo que, lanzado por `find -exec`, borra lo encontrado. */
const FIND_DELETERS = new Set(['rm', 'unlink', 'shred', 'rmdir']);

/** Cómo borra un `find`: raíces, si borra y si algo acota qué. */
export function findDeletion(rest: string[]): { roots: string[]; filtered: boolean } | null {
  const first = rest.findIndex((t) => t.startsWith('-') || t === '(' || t === '!');
  const roots = (first === -1 ? rest : rest.slice(0, first)).filter((t) => t.length > 0);
  let deletes = false;
  let filtered = false;
  for (let i = first === -1 ? rest.length : first; i < rest.length; i++) {
    const tok = rest[i]!;
    if (FIND_EXEC.test(tok)) {
      const end = rest.findIndex((t, j) => j > i && (t === ';' || t === '\\;' || t === '+'));
      const inner = parseInvocation(rest.slice(i + 1, end === -1 ? undefined : end));
      if (inner && FIND_DELETERS.has(inner.name)) deletes = true;
      if (end === -1) break;
      i = end;
      continue;
    }
    if (tok === '-delete') deletes = true;
    const skip = FIND_NON_FILTERS[tok];
    if (skip === undefined) filtered = true;
    else i += skip;
  }
  return deletes ? { roots: roots.length > 0 ? roots : ['.'], filtered } : null;
}

/**
 * Lo mismo con sintaxis de Windows/PowerShell: raíz de una unidad (`C:\`, `C:`,
 * `\`), home (`~`, `$HOME`, `$env:USERPROFILE`), directorio actual y padre, con o
 * sin `\*` final. Sin distinguir mayúsculas, como PowerShell.
 */
const WINDOWS_CATASTROPHIC =
  /^(?:[a-z]:[\\/]?|[\\/]|~[\\/]?|\$home[\\/]?|\$env:(?:userprofile|homedrive|systemdrive|systemroot|windir)[\\/]?|\.[\\/]?|\.\.[\\/]?)\*?$/i;

/** `Remove-Item` y todos sus alias, más los borrados de `cmd.exe`. */
const PS_REMOVE_COMMANDS = new Set(['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir']);

/** `-Recurse` y sus abreviaturas (PowerShell acepta cualquier prefijo único). */
const PS_RECURSE_FLAG = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$true)?$/i;

export interface HardDenyRule {
  id: string;
  reason: string;
  matches(name: string, rest: string[]): boolean;
}

export const HARD_DENY_RULES: readonly HardDenyRule[] = [
  {
    id: 'rm_recursive_root',
    reason: 'borrado recursivo de la raíz del sistema, del home o del directorio actual',
    matches(name, rest) {
      if (name !== 'rm') return false;
      const recursive = hasShortFlags(rest, ['r']) || hasLongFlag(rest, '--recursive');
      if (!recursive) return false;
      return positionals(rest).some(isCatastrophicTarget);
    },
  },
  {
    // `find / -delete` es un `rm -rf /` sin la palabra `rm`. Con un filtro
    // (`-name '*.tmp'`) ya no es indiscriminado: eso pide confirmación, no veto.
    id: 'find_delete_root',
    reason:
      'find sin filtros borrando la raíz del sistema, el home o el directorio actual (equivale a un rm -rf)',
    matches(name, rest) {
      if (name !== 'find') return false;
      const deletion = findDeletion(rest);
      return deletion !== null && !deletion.filtered && deletion.roots.some(isCatastrophicTarget);
    },
  },
  {
    // En Windows `exec` corre en PowerShell: el `rm -rf /` de allí es un
    // `Remove-Item -Recurse` (o sus alias) sobre la raíz de una unidad o el home.
    id: 'ps_remove_recursive_root',
    reason: 'borrado recursivo de la raíz de una unidad, del home o del directorio actual',
    matches(name, rest) {
      const cmd = name.toLowerCase();
      if (!PS_REMOVE_COMMANDS.has(cmd)) return false;
      const recursive =
        rest.some((tok) => PS_RECURSE_FLAG.test(tok)) ||
        ((cmd === 'rd' || cmd === 'rmdir') && rest.some((tok) => /^\/s$/i.test(tok)));
      if (!recursive) return false;
      return rest.some(
        (tok) => !tok.startsWith('-') && !/^\/[a-z]$/i.test(tok) && WINDOWS_CATASTROPHIC.test(tok),
      );
    },
  },
  {
    id: 'git_clean_force_dirs',
    reason:
      'git clean -fd borra ficheros y directorios no versionados de forma definitiva (el reflog no los recupera)',
    matches(name, rest) {
      if (name !== 'git') return false;
      const sub = subcommand(rest);
      if (sub.name !== 'clean') return false;
      const force = hasShortFlags(sub.rest, ['f']) || hasLongFlag(sub.rest, '--force');
      const dirs = hasShortFlags(sub.rest, ['d']) || hasLongFlag(sub.rest, '--directories');
      return force && dirs;
    },
  },
  {
    id: 'chmod_recursive_777',
    reason: 'chmod -R 777 deja el árbol completo escribible por cualquiera',
    matches(name, rest) {
      if (name !== 'chmod') return false;
      const recursive = hasShortFlags(rest, ['R']) || hasLongFlag(rest, '--recursive');
      return recursive && positionals(rest).some((p) => /^0?777$/.test(p));
    },
  },
  {
    id: 'chown_recursive',
    reason: 'chown -R reasigna la propiedad de un árbol completo de ficheros',
    matches(name, rest) {
      if (name !== 'chown' && name !== 'chgrp') return false;
      return hasShortFlags(rest, ['R']) || hasLongFlag(rest, '--recursive');
    },
  },
  {
    id: 'mkfs',
    reason: 'formatear un sistema de ficheros destruye todos los datos del dispositivo',
    matches(name) {
      return name === 'mkfs' || name.startsWith('mkfs.');
    },
  },
  {
    id: 'dd_to_device',
    reason: 'dd escribiendo sobre un dispositivo de bloque destruye su contenido',
    matches(name, rest) {
      if (name !== 'dd') return false;
      return rest.some((tok) => /^of=\/dev\//i.test(tok));
    },
  },
  {
    id: 'fork_bomb',
    reason: 'fork bomb: agota la tabla de procesos de la máquina',
    matches(name) {
      return name === ':(){';
    },
  },
];

/**
 * Capa 1. Devuelve el motivo del bloqueo, o `null` si el comando pasa. Evalúa
 * cada segmento por separado: un `&&` no esconde nada.
 */
export function hardDenyReason(command: string): string | null {
  // Escritura directa sobre un dispositivo de bloque: es una redirección, no un
  // comando, así que no sobrevive a la tokenización por argumentos.
  if (/>\s*\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z])/i.test(command)) {
    return 'redirección de salida sobre un dispositivo de bloque';
  }
  // Fork bomb clásico: `:(){ :|:& };:` — los `|` y `&` lo parten en segmentos.
  if (/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(command.replace(/\n/g, ' '))) {
    return 'fork bomb: agota la tabla de procesos de la máquina';
  }

  // Sobre el comando efectivo: un envoltorio, un `sh -c` o una variable no
  // cambian lo que se va a ejecutar.
  for (const invocation of effectiveInvocations(command)) {
    for (const rule of HARD_DENY_RULES) {
      if (rule.matches(invocation.name, invocation.rest)) return rule.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Veto de comando compartido por todos los targets de ejecución
// ---------------------------------------------------------------------------

/**
 * Safety check (§12.5): detecta si un comando contiene patrones destructivos.
 * Los patrones vienen de `tools.destructivePatterns` en la config. Cada patrón
 * se busca como palabra completa (case-sensitive — `DROP`/`DELETE` apuntan a
 * SQL en mayúsculas; `rm`/`dd` a comandos shell en minúsculas).
 */
export function commandIsDestructive(command: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s;|&("'\`])${escaped}(?:$|[\\s;|&)"'\`])`);
    if (re.test(command)) return true;
  }
  return false;
}

/**
 * Cmdlets de PowerShell que borran o destruyen datos. Son nombres inequívocos,
 * así que se buscan en cualquier parte del comando (también dentro de un
 * `pwsh -Command "…"`), sin distinguir mayúsculas.
 */
const PS_DESTRUCTIVE_CMDLETS = [
  'Remove-Item',
  'Remove-ItemProperty',
  'Clear-Content',
  'Clear-Item',
  'Clear-RecycleBin',
  'Format-Volume',
  'Clear-Disk',
  'Initialize-Disk',
  'Remove-Partition',
];

/** Alias de borrado de PowerShell/`cmd.exe`: solo cuentan como comando, no como palabra suelta. */
const PS_DESTRUCTIVE_ALIASES = new Set(['rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'format']);

/**
 * Borrados con sintaxis de Windows (§12.5). En Windows `exec` corre en
 * PowerShell y `tools.destructivePatterns` solo trae nombres POSIX que
 * distinguen mayúsculas: un `Remove-Item`, un `del` o un `RM` se ejecutaban sin
 * confirmación. Es intrínseco —no depende de la config— igual que la capa 1:
 * quien personaliza `destructivePatterns` no debe perderlo sin saberlo.
 */
/** ¿Es este ejecutable un borrado de PowerShell/`cmd.exe` (cmdlet o alias)? */
export function isWindowsDeleteCommand(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    PS_DESTRUCTIVE_ALIASES.has(lower) ||
    PS_DESTRUCTIVE_CMDLETS.some((cmdlet) => cmdlet.toLowerCase() === lower)
  );
}

export function windowsDestructiveCommand(command: string): string | null {
  for (const cmdlet of PS_DESTRUCTIVE_CMDLETS) {
    const re = new RegExp(`(?:^|[\\s;|&("'\`{])${cmdlet}(?:$|[\\s;|&)"'\`}])`, 'i');
    if (re.test(command)) return cmdlet;
  }
  for (const segment of splitCommandSegments(command)) {
    const invocation = parseInvocation(tokenize(segment.replace(/^[({]+/, '')));
    const name = invocation?.name.toLowerCase();
    if (name && PS_DESTRUCTIVE_ALIASES.has(name)) return name;
  }
  return null;
}

/**
 * Veto de capas 1, 2 y 3-blocked sobre un comando de shell. Hito 16: lo evalúa
 * `exec` una sola vez para cualquier target (antes lo compartían a medias
 * `bash` y `ssh_exec`). Recibe el target para que las políticas por entorno
 * puedan enchufarse aquí sin tocar la tool; hoy la semántica es idéntica en
 * todos: un `rm -rf /` no es menos catastrófico al otro lado de un socket.
 * Devuelve el motivo del rechazo, o `null` si el comando pasa.
 */
export function commandVeto(
  command: string,
  guardedCommands?: Record<string, GuardAction>,
  target?: string,
): string | null {
  const hard = hardDenyReason(command);
  if (hard) {
    return (
      `Blocked by a non-negotiable safety rule: ${hard}. ` +
      'This rule cannot be disabled by configuration or by user approval. ' +
      'Narrow the command to the specific target you actually need.'
    );
  }
  if (
    target === LOCAL_TARGET &&
    resolveGuardAction(SHELL_DETACH_GUARD, guardedCommands) === 'block'
  ) {
    const detach = shellDetachReason(command);
    if (detach) {
      return (
        `the command would leave a process running outside the session (${detach}). ` +
        'Stratum has to own every process it starts so it can report on it and stop it: run the ' +
        'command with exec background:true instead (then get_job_output / cancel_job), or in ' +
        'the foreground if it finishes on its own. No approval lifts this; the policy is ' +
        '"shellDetach" in tools.guardedCommands.'
      );
    }
  }
  const guarded = guardedBlockReason(command, guardedCommands);
  if (guarded) {
    return (
      `Blocked by policy: ${guarded} is set to "block" in tools.guardedCommands. ` +
      'Ask the user to run it themselves, or to change that policy in .stratumrc.json.'
    );
  }
  // Capa 3 sobre el shell: sin esto, bloquear `read_file` sobre una clave no
  // sirve de nada, porque `cat` sigue disponible y el modelo encuentra el
  // rodeo solo. Mismo veredicto y mismo texto que en las tools de fichero.
  const sensitive = commandPathVerdict(command);
  if (sensitive && sensitive.tier === 'blocked') {
    return (
      `the command reads or writes "${sensitive.path}" (${sensitive.reason}). ` +
      'Credentials and private key material are never accessed by the agent, through file tools ' +
      'or through the shell, and no configuration or user approval can enable it. ' +
      'If you need a value from it, ask the user to provide just that value.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Procesos que se desligan de la sesión
// ---------------------------------------------------------------------------

const LOCAL_TARGET = 'local';
/** Clave de `tools.guardedCommands` (default `block`). */
export const SHELL_DETACH_GUARD = 'shellDetach';

/** Envoltorios que sacan al proceso del grupo o de la sesión del shell. */
const DETACH_WRAPPERS: Readonly<Record<string, string>> = {
  nohup: 'nohup detaches the process from the shell',
  setsid: 'setsid moves the process to a session of its own',
};

/** Comandos cuyo trabajo es lanzar algo que les sobrevive. */
const DETACH_COMMANDS: Readonly<Record<string, (rest: string[]) => string | null>> = {
  disown: () => 'disown removes the process from the shell job table',
  daemonize: () => 'daemonize starts a detached daemon',
  daemon: () => 'daemon starts a detached daemon',
  'start-stop-daemon': (rest) =>
    hasLongFlag(rest, '--start') || hasShortFlags(rest, ['S'])
      ? 'start-stop-daemon starts a detached daemon'
      : null,
  'systemd-run': () => 'systemd-run starts the command as a separate unit',
  'start-process': () => 'Start-Process launches an independent process',
  saps: () => 'Start-Process launches an independent process',
  start: () => 'start launches an independent process',
  'start-job': () => 'Start-Job runs the command as a PowerShell background job',
  sajb: () => 'Start-Job runs the command as a PowerShell background job',
  'start-threadjob': () => 'Start-ThreadJob runs the command as a PowerShell background job',
  screen: (rest) =>
    hasShortFlags(rest, ['d']) && hasShortFlags(rest, ['m'])
      ? 'screen -dm starts a detached session'
      : null,
  tmux: (rest) =>
    /^(new|new-session)$/.test(positionals(rest)[0] ?? '') && hasShortFlags(rest, ['d'])
      ? 'tmux new-session -d starts a detached session'
      : null,
};

/** Esperar a lo lanzado en el propio comando lo mantiene dentro: no es un desligue. */
const WAITERS = new Set(['wait', 'wait-job', 'wjb', 'receive-job', 'rcjb', 'wait-process']);

/**
 * ¿Hay un `&` de segundo plano? Es el que tiene un comando delante: el `&` de
 * PowerShell que abre una sentencia (`& $cmd`, `{ & foo }`, `$x = & foo`) es el
 * operador de llamada, y `&&`, `>&`, `&>`, `<&` y `|&` son otra cosa.
 */
function hasBackgroundOperator(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' || ch === '`') {
      // Un `&` escapado (con barra en POSIX, con acento grave en PowerShell) es
      // literal. Un acento grave que abre una sustitución también salta un
      // carácter: da igual, no es un `&`.
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== '&') continue;
    const next = command[i + 1];
    if (next === '&') {
      i++;
      continue;
    }
    const prev = command[i - 1];
    if (next === '>' || prev === '>' || prev === '<' || prev === '|') continue;
    const last = command.slice(0, i).trimEnd().at(-1);
    if (last === undefined || ';{(=|&\n'.includes(last)) continue;
    return true;
  }
  return false;
}

/**
 * Por qué el comando dejaría un proceso vivo fuera del control de Stratum, o
 * `null`. Un proceso desligado (`cmd &` con la salida redirigida, `nohup`,
 * `Start-Process`…) sobrevive a su `exec`, no tiene dueño, no se puede
 * cancelar y sigue ahí al cerrar la sesión: justo lo que `exec` con
 * `background: true` existe para evitar. Solo se aplica al target local — en un
 * host remoto no hay `JobManager` que saltarse.
 *
 * Best-effort, como el resto de las guardas: mira el comando efectivo, también
 * dentro de un `sh -c` o un `pwsh -Command`.
 */
export function shellDetachReason(command: string, depth = 0): string | null {
  const invocations = effectiveInvocations(command);
  const waits = invocations.some((inv) => WAITERS.has(inv.name.toLowerCase()));

  for (const inv of invocations) {
    for (const w of inv.wrappers ?? []) {
      if (DETACH_WRAPPERS[w]) return DETACH_WRAPPERS[w]!;
    }
    const lower = inv.name.toLowerCase();
    const reason = DETACH_COMMANDS[lower]?.(inv.rest) ?? null;
    // Un job de PowerShell que el propio comando espera no se queda atrás.
    if (reason && !(waits && /^(start-job|sajb|start-threadjob)$/.test(lower))) return reason;
  }

  if (!waits && hasBackgroundOperator(command)) {
    return 'a "&" puts the command in the background of a shell that then exits';
  }

  // El `&` dentro del comando que recibe otro shell (`sh -c "x &"`): las
  // comillas lo esconden del barrido de arriba.
  if (depth >= 2) return null;
  for (const part of splitCommandParts(command)) {
    const tokens = tokenize(part.text);
    for (let i = 1; i < tokens.length; i++) {
      if (!/^(?:-[A-Za-z]*c|-command|\/[ck])$/i.test(tokens[i - 1]!)) continue;
      const inner = tokens[i]!;
      if (!/\s/.test(inner)) continue;
      const nested = shellDetachReason(inner, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Motivo de confirmación cuando `shellDetach` está en `confirm` (target local). */
export function shellDetachConfirmReason(
  command: string,
  overrides: Record<string, GuardAction> | undefined,
  target: string,
): string | null {
  if (target !== LOCAL_TARGET) return null;
  if (resolveGuardAction(SHELL_DETACH_GUARD, overrides) !== 'confirm') return null;
  return shellDetachReason(command);
}

// ---------------------------------------------------------------------------
// Capa 2 — Comandos guardados (configurables)
// ---------------------------------------------------------------------------

export type GuardAction = 'allow' | 'confirm' | 'block';

export interface GuardedCommand {
  key: string;
  label: string;
  /**
   * `segment` es el trozo ejecutable actual; `command` el comando completo, que
   * hace falta para las reglas cuya señal está en la tubería (`curl … | sh`):
   * el troceado por segmentos se lleva por delante justo el `|` que las define.
   */
  matches(name: string, rest: string[], segment: string, command: string): boolean;
}

export const GUARDED_COMMANDS: readonly GuardedCommand[] = [
  {
    key: 'gitPushForce',
    label: 'git push --force',
    matches(name, rest) {
      if (name !== 'git') return false;
      const sub = subcommand(rest);
      if (sub.name !== 'push') return false;
      return (
        hasLongFlag(sub.rest, '--force', '--force-with-lease', '--force-if-includes') ||
        hasShortFlags(sub.rest, ['f'])
      );
    },
  },
  {
    key: 'gitResetHard',
    label: 'git reset --hard',
    matches(name, rest) {
      if (name !== 'git') return false;
      const sub = subcommand(rest);
      return sub.name === 'reset' && hasLongFlag(sub.rest, '--hard');
    },
  },
  {
    key: 'gitRebase',
    label: 'git rebase',
    matches(name, rest) {
      if (name !== 'git') return false;
      return subcommand(rest).name === 'rebase';
    },
  },
  {
    key: 'gitBranchDeleteForce',
    label: 'git branch -D',
    matches(name, rest) {
      if (name !== 'git') return false;
      const sub = subcommand(rest);
      if (sub.name !== 'branch') return false;
      return hasShortFlags(sub.rest, ['D']) || hasLongFlag(sub.rest, '--delete');
    },
  },
  {
    // `git clean -fd` sin más es capa 1. Acotado a una ruta, o sin `-d`, sigue
    // borrando ficheros sin seguimiento que no vuelven: pide confirmación, para
    // que «acotar el comando» no sea la forma de saltarse el veto.
    key: 'gitCleanForce',
    label: 'git clean -f',
    matches(name, rest) {
      if (name !== 'git') return false;
      const sub = subcommand(rest);
      if (sub.name !== 'clean') return false;
      if (hasShortFlags(sub.rest, ['n']) || hasLongFlag(sub.rest, '--dry-run')) return false;
      return hasShortFlags(sub.rest, ['f']) || hasLongFlag(sub.rest, '--force');
    },
  },
  {
    key: 'npmPublish',
    label: 'npm publish',
    matches(name, rest) {
      if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn') return false;
      return subcommand(rest).name === 'publish';
    },
  },
  {
    key: 'dockerPrune',
    label: 'docker system prune',
    matches(name, rest) {
      if (name !== 'docker') return false;
      return rest.includes('prune');
    },
  },
  {
    key: 'curlPipeShell',
    label: 'descarga canalizada a un intérprete',
    matches(name, _rest, _segment, command) {
      if (name !== 'curl' && name !== 'wget') return false;
      return /\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/.test(command);
    },
  },
];

/**
 * Acciones por defecto. `npmPublish` bloqueado: publicar un paquete es
 * irreversible de cara al mundo y jamás debe salir de una decisión del modelo.
 */
export const DEFAULT_GUARD_ACTIONS: Readonly<Record<string, GuardAction>> = {
  gitPushForce: 'confirm',
  gitResetHard: 'confirm',
  gitRebase: 'confirm',
  gitBranchDeleteForce: 'confirm',
  gitCleanForce: 'confirm',
  npmPublish: 'block',
  dockerPrune: 'confirm',
  curlPipeShell: 'confirm',
  // No está en `GUARDED_COMMANDS` porque solo aplica al target local: ver
  // `shellDetachReason`.
  shellDetach: 'block',
};

export function resolveGuardAction(
  key: string,
  overrides?: Record<string, GuardAction>,
): GuardAction {
  return overrides?.[key] ?? DEFAULT_GUARD_ACTIONS[key] ?? 'allow';
}

export interface GuardMatch {
  key: string;
  label: string;
  action: GuardAction;
}

/** Todos los comandos guardados que encajan en algún segmento, con su acción resuelta. */
export function matchGuardedCommands(
  command: string,
  overrides?: Record<string, GuardAction>,
): GuardMatch[] {
  const matches: GuardMatch[] = [];
  const seen = new Set<string>();

  for (const invocation of effectiveInvocations(command)) {
    for (const guarded of GUARDED_COMMANDS) {
      if (seen.has(guarded.key)) continue;
      if (!guarded.matches(invocation.name, invocation.rest, invocation.segment, command)) continue;
      seen.add(guarded.key);
      matches.push({
        key: guarded.key,
        label: guarded.label,
        action: resolveGuardAction(guarded.key, overrides),
      });
    }
  }
  return matches;
}

/** Motivo del bloqueo por capa 2 (`block`), o `null`. Absoluto: allow-all no lo levanta. */
export function guardedBlockReason(
  command: string,
  overrides?: Record<string, GuardAction>,
): string | null {
  const blocked = matchGuardedCommands(command, overrides).filter((m) => m.action === 'block');
  if (blocked.length === 0) return null;
  return blocked.map((m) => m.label).join(', ');
}

/** ¿Requiere confirmación por capa 2? Devuelve la etiqueta que la motiva, o `null`. */
export function guardedConfirmLabel(
  command: string,
  overrides?: Record<string, GuardAction>,
): string | null {
  const confirm = matchGuardedCommands(command, overrides).filter((m) => m.action === 'confirm');
  if (confirm.length === 0) return null;
  return confirm.map((m) => m.label).join(', ');
}

// ---------------------------------------------------------------------------
// Capa 3 — Rutas sensibles
// ---------------------------------------------------------------------------

export type PathTier = 'blocked' | 'confirm';

interface PathRule {
  tier: PathTier;
  re: RegExp;
  reason: string;
}

/**
 * Reglas sobre la ruta normalizada a separadores POSIX y minúsculas. `blocked`
 * es material criptográfico o credenciales de acceso: no hay razón legítima
 * para que el agente lo lea y lo vuelque al provider, así que no se puede
 * levantar ni con allowlist. `confirm` es contenido que sí se edita a veces.
 */
const PATH_RULES: readonly PathRule[] = [
  { tier: 'blocked', re: /(?:^|\/)\.ssh(?:\/|$)/, reason: 'claves SSH' },
  { tier: 'blocked', re: /(?:^|\/)\.gnupg(?:\/|$)/, reason: 'claves GPG' },
  { tier: 'blocked', re: /(?:^|\/)\.aws\/credentials$/, reason: 'credenciales AWS' },
  { tier: 'blocked', re: /(?:^|\/)\.config\/gh\/hosts\.ya?ml$/, reason: 'token de GitHub CLI' },
  { tier: 'blocked', re: /(?:^|\/)\.credentials(?:\/|$)/, reason: 'almacén de credenciales' },
  { tier: 'blocked', re: /(?:^|\/)library\/keychains(?:\/|$)/, reason: 'llavero de macOS' },
  { tier: 'blocked', re: /(?:^|\/)\.netrc$/, reason: 'credenciales de red (.netrc)' },
  { tier: 'blocked', re: /\.(?:pem|key|p12|pfx|jks|keystore)$/, reason: 'clave o certificado' },
  {
    tier: 'blocked',
    re: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
    reason: 'clave privada SSH',
  },
  { tier: 'confirm', re: /(?:^|\/)\.env(?:$|[./_-])/, reason: 'fichero de entorno (.env)' },
  { tier: 'confirm', re: /(?:^|\/)secrets?(?:\/|$)/, reason: 'directorio de secretos' },
  { tier: 'confirm', re: /(?:^|\/)\.npmrc$/, reason: 'configuración npm (puede llevar token)' },
];

/** Normaliza a separadores POSIX y minúsculas para evaluar las reglas. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Clasifica una ruta. `null` si no es sensible. */
export function classifySensitivePath(path: string): { tier: PathTier; reason: string } | null {
  const normalized = normalizePath(path);
  for (const rule of PATH_RULES) {
    if (rule.re.test(normalized)) return { tier: rule.tier, reason: rule.reason };
  }
  return null;
}

/** Claves de parámetro que se interpretan como rutas, a cualquier profundidad. */
const PATH_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filepath',
  'filepaths',
  'filename',
  'localpath',
  'remotepath',
  'source',
  'destination',
  'dest',
  'directory',
  'dir',
]);

/**
 * Extrae recursivamente las rutas de los parámetros de una tool. Recursivo a
 * propósito: no todas las tools (las MCP, sobre todo) tienen parámetros planos.
 */
export function collectPathInputs(params: unknown, depth = 0): string[] {
  if (depth > 6 || params === null || typeof params !== 'object') return [];
  const found: string[] = [];

  const visit = (key: string, value: unknown): void => {
    const isPathKey = PATH_KEYS.has(key.toLowerCase());
    if (typeof value === 'string') {
      if (isPathKey && value.trim()) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          if (isPathKey && item.trim()) found.push(item);
        } else {
          found.push(...collectPathInputs(item, depth + 1));
        }
      }
      return;
    }
    found.push(...collectPathInputs(value, depth + 1));
  };

  if (Array.isArray(params)) {
    for (const item of params) found.push(...collectPathInputs(item, depth + 1));
    return found;
  }
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    visit(key, value);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Capa 3 sobre comandos de shell
// ---------------------------------------------------------------------------

/**
 * Comandos que vuelcan el CONTENIDO de un fichero (a stdout, a otro fichero o
 * a la red). Son la vía por la que la capa 3 se esquivaba: bloquear `read_file`
 * sobre `.env` no sirve de nada si `cat .env` sigue disponible, y el modelo
 * encuentra ese rodeo solo — se observó haciéndolo.
 *
 * La lista es deliberadamente de comandos que EXPONEN contenido, no de todo lo
 * que abre un fichero: `wc -l .env` o `stat` no filtran el secreto, y meterlos
 * solo añadiría falsos positivos. Cubre POSIX y los alias de PowerShell, que es
 * el shell por defecto en Windows.
 */
const CONTENT_READERS = new Set([
  // volcado directo
  'cat',
  'bat',
  'tac',
  'head',
  'tail',
  'more',
  'less',
  'nl',
  'strings',
  'xxd',
  'od',
  'hexdump',
  'base64',
  'openssl',
  // filtros que imprimen líneas del fichero
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sed',
  'awk',
  'gawk',
  'perl',
  'sort',
  'uniq',
  'cut',
  // copia (mover el material a otro sitio lo saca del alcance de la guarda)
  'cp',
  'mv',
  'install',
  'rsync',
  'scp',
  'tee',
  // PowerShell
  'get-content',
  'gc',
  'type',
  'select-string',
  'sls',
  'copy-item',
  'copy',
  'move-item',
  'out-file',
  'set-content',
  'add-content',
]);

/**
 * Flags que consumen el token siguiente como valor y no como ruta. Depende del
 * comando a propósito: `-n` es un número en `head -n 5` y una opción sin valor
 * en `sed -n`, así que una lista única acertaría en uno y fallaría en el otro.
 */
const VALUE_FLAGS_BY_COMMAND: Record<string, readonly string[]> = {
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes'],
  grep: ['-m', '-A', '-B', '-C', '-e', '-f', '--regexp', '--file', '--max-count'],
  egrep: ['-m', '-A', '-B', '-C', '-e', '-f'],
  fgrep: ['-m', '-A', '-B', '-C', '-e', '-f'],
  rg: ['-m', '-A', '-B', '-C', '-e', '-f', '--max-count', '--regexp', '--file'],
  sed: ['-e', '-f', '--expression', '--file'],
  awk: ['-v', '-f'],
  gawk: ['-v', '-f'],
  perl: ['-e', '-I'],
  'select-string': ['-Pattern', '-pattern'],
  sls: ['-Pattern', '-pattern'],
  cut: ['-d', '-f', '-c', '--delimiter', '--fields'],
  openssl: ['-in', '-out', '-passin', '-passout'],
};

/** Flags que aportan el patrón por opción: con uno de ellos, el primer operando YA es una ruta. */
const PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file', '-Pattern', '-pattern']);

interface ReaderOperands {
  paths: string[];
  /** true si el patrón vino por flag, así que no hay que descartar el primer operando. */
  patternFromFlag: boolean;
}

/** Operandos de un lector, saltando flags y los valores que estos consumen. */
function readerOperands(name: string, rest: string[]): ReaderOperands {
  const valueFlags = new Set(VALUE_FLAGS_BY_COMMAND[name] ?? []);
  const paths: string[] = [];
  let patternFromFlag = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('-')) {
      if (valueFlags.has(tok)) {
        if (PATTERN_FLAGS.has(tok)) patternFromFlag = true;
        i++;
      }
      continue;
    }
    paths.push(tok);
  }
  return { paths, patternFromFlag };
}

/** Flags de subida de `curl`: `curl -T .env https://…` es exfiltración directa. */
const CURL_UPLOAD_FLAGS = new Set(['-T', '--upload-file', '--data-binary', '-d', '--data', '-F']);

/**
 * Extrae las rutas que un comando de shell va a leer o escribir. Cubre tres
 * vías: los operandos de un comando de la lista de arriba, las redirecciones
 * (`< .env`, `> .ssh/authorized_keys`) y las subidas de `curl`.
 *
 * Es best-effort por construcción — un shell puede componer una ruta de mil
 * maneras (variables, `$(...)`, globs) y esto no es un intérprete. Sube el
 * listón lo suficiente para que el rodeo obvio deje de funcionar, que es de lo
 * que se trata; la defensa real de un secreto es no tenerlo en el disco donde
 * corre el agente.
 */
export function collectCommandPaths(command: string): string[] {
  const found: string[] = [];

  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    // Redirecciones: `> f`, `>> f`, `< f`, y las formas pegadas `>f` / `<f`.
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      const redirect = tok.match(/^\d?(?:>>|>|<)(.*)$/);
      if (!redirect) continue;
      const inline = redirect[1] ?? '';
      const target = inline || tokens[i + 1] || '';
      if (target && !target.startsWith('-')) found.push(target);
    }

    const invocation = parseInvocation(tokens);
    if (!invocation) continue;
    const name = invocation.name.toLowerCase();

    if (CONTENT_READERS.has(name)) {
      // El primer operando de sed/awk/perl/grep es el programa o el patrón, no
      // una ruta; contarlo daría falsos positivos con expresiones tipo `s/a/b/`.
      const skipFirst =
        name === 'sed' ||
        name === 'awk' ||
        name === 'gawk' ||
        name === 'perl' ||
        name === 'grep' ||
        name === 'egrep' ||
        name === 'fgrep' ||
        name === 'rg' ||
        name === 'select-string' ||
        name === 'sls';
      const { paths, patternFromFlag } = readerOperands(name, invocation.rest);
      found.push(...(skipFirst && !patternFromFlag ? paths.slice(1) : paths));
      continue;
    }

    if (name === 'curl' || name === 'wget' || name === 'invoke-webrequest' || name === 'iwr') {
      for (let i = 0; i < invocation.rest.length; i++) {
        const tok = invocation.rest[i]!;
        if (!CURL_UPLOAD_FLAGS.has(tok)) continue;
        const value = invocation.rest[i + 1] ?? '';
        // `-d @fichero` sube el contenido; `-d clave=valor` no.
        const path = value.startsWith('@')
          ? value.slice(1)
          : tok === '-T' || tok === '--upload-file'
            ? value
            : '';
        if (path) found.push(path);
      }
    }
  }

  return found.filter((p) => p.length > 0 && !p.startsWith('-'));
}

/**
 * Veredicto de capa 3 para un comando de shell. Mismo criterio que el de las
 * tools de fichero: `blocked` es inapelable, `confirm` admite allowlist.
 */
export function commandPathVerdict(command: string, allowlist: string[] = []): PathVerdict | null {
  return sensitivePathVerdict({ paths: collectCommandPaths(command) }, allowlist);
}

export interface PathVerdict {
  tier: PathTier;
  path: string;
  reason: string;
}

/**
 * Veredicto de capa 3 sobre los parámetros de una tool. Devuelve el nivel más
 * severo encontrado. La `allowlist` solo puede levantar el nivel `confirm`:
 * una entrada que apunte a material del nivel `blocked` se ignora.
 */
export function sensitivePathVerdict(
  params: unknown,
  allowlist: string[] = [],
): PathVerdict | null {
  const allowed = allowlist.map(normalizePath).filter((a) => a.length > 0);
  let confirmHit: PathVerdict | null = null;

  for (const path of collectPathInputs(params)) {
    const verdict = classifySensitivePath(path);
    if (!verdict) continue;
    if (verdict.tier === 'blocked') return { tier: 'blocked', path, reason: verdict.reason };
    const normalized = normalizePath(path);
    if (
      allowed.some(
        (a) => normalized === a || normalized.endsWith(`/${a}`) || normalized.includes(a),
      )
    ) {
      continue;
    }
    confirmHit ??= { tier: 'confirm', path, reason: verdict.reason };
  }
  return confirmHit;
}

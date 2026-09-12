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
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

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
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
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
  const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'xargs', 'nice']);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    // VAR=value delante del comando
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    const base = tok.replace(/\\/g, '/').split('/').pop() ?? tok;
    const bare = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (WRAPPERS.has(bare)) {
      i++;
      // saltar los flags del envoltorio (sudo -u foo, env -i, …)
      while (i < tokens.length && tokens[i]!.startsWith('-')) i++;
      continue;
    }
    return { name: bare, rest: tokens.slice(i + 1) };
  }
  return null;
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
      return positionals(rest).some((p) => CATASTROPHIC_TARGETS.test(p));
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

  for (const segment of splitCommandSegments(command)) {
    const invocation = parseInvocation(tokenize(segment));
    if (!invocation) continue;
    for (const rule of HARD_DENY_RULES) {
      if (rule.matches(invocation.name, invocation.rest)) return rule.reason;
    }
  }
  return null;
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
  npmPublish: 'block',
  dockerPrune: 'confirm',
  curlPipeShell: 'confirm',
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

  for (const segment of splitCommandSegments(command)) {
    const invocation = parseInvocation(tokenize(segment));
    if (!invocation) continue;
    for (const guarded of GUARDED_COMMANDS) {
      if (seen.has(guarded.key)) continue;
      if (!guarded.matches(invocation.name, invocation.rest, segment, command)) continue;
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

/**
 * Confinamiento de las tools de fichero a un espacio de trabajo (Stratum
 * Desktop D2, punto ciego 16.2).
 *
 * Con `ToolContext.workspace` presente, toda ruta que reciban `read_file`,
 * `write_file`, `edit_file`, `glob`, `grep` o `list_directory` se resuelve
 * contra la raíz del workspace y se veta si su `realpath` queda fuera: `..`,
 * rutas absolutas, symlinks y junctions de Windows. Es un veto de `preflight`
 * (inapelable, como las rutas `blocked` del Hito 11), no una confirmación.
 *
 * Dos propiedades que no deben perderse:
 *  - **Falla cerrado.** El dispatcher deja pasar un `preflight` que lanza (un
 *    fallo del hook no puede bloquear a la CLI); aquí cualquier excepción se
 *    convierte en veto, porque dejar pasar una ruta que no se pudo comprobar es
 *    exactamente el escape que se quiere evitar.
 *  - **Se comprueba también al ejecutar** (`workspaceExecuteGuard`): el
 *    `preflight` es el punto de decisión, pero una tool invocada por otra vía
 *    que no pase por el dispatcher no puede quedar sin confinar.
 *
 * Sin `ToolContext.workspace` nada de esto actúa: la CLI no cambia.
 */
import { lstatSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { ToolContext, ToolResult, WorkspaceConfinement } from '../../agent/types.js';

export type WorkspaceAccess = 'read' | 'write';

export type ConfinedPath =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; reason: string };

const IS_WINDOWS = process.platform === 'win32';

/** Nombres de dispositivo de Windows: reservados en cualquier directorio, con o sin extensión. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/**
 * Rechazos sintácticos de Windows antes de resolver nada: rutas UNC y de
 * dispositivo (`\\server\share`, `\\?\C:\…`, `\\.\pipe\…`), rutas relativas a
 * la unidad (`C:foo`, que se resuelven contra el cwd de esa unidad), flujos
 * alternativos (`informe.txt:oculto`) y nombres de dispositivo (`outputs/CON`).
 */
function windowsSyntaxProblem(input: string): string | null {
  if (/^[\\/]{2}/.test(input)) return 'UNC and device paths are not allowed';
  if (/^[a-zA-Z]:(?![\\/])/.test(input)) return 'drive-relative paths are not allowed';
  const rest = /^[a-zA-Z]:[\\/]/.test(input) ? input.slice(2) : input;
  if (rest.includes(':')) return 'alternate data streams are not allowed';
  for (const segment of rest.split(/[\\/]/)) {
    // Windows ignora puntos y espacios finales: `CON. ` también es el dispositivo.
    if (WINDOWS_DEVICE.test(segment.replace(/[. ]+$/, ''))) {
      return `"${segment}" is a reserved device name`;
    }
  }
  return null;
}

/**
 * `realpath` de una ruta que puede no existir todavía (un `write_file` nuevo):
 * se resuelve el ancestro existente más profundo y se le añade el resto. Se
 * busca con `lstat`, no con `exists`, para que un symlink roto cuente como
 * existente: si no, el ancestro sería su padre y la escritura atravesaría el
 * enlace hacia fuera. Un symlink roto no tiene `realpath` y se veta.
 */
function realpathAllowingMissing(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error('no existing ancestor');
      missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
  const real = realpathSync.native(current);
  return missing.length > 0 ? join(real, ...missing) : real;
}

function normalizeForCompare(p: string): string {
  return IS_WINDOWS ? p.toLowerCase() : p;
}

/** Ruta relativa de `target` dentro de `root`, o `null` si queda fuera. */
function relativeInside(root: string, target: string): string | null {
  // `path.win32.relative` ya compara sin distinguir mayúsculas; en POSIX la
  // comparación exacta es la correcta.
  const rel = relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

function firstSegment(rel: string): string {
  return normalizeForCompare(rel.split(/[\\/]/)[0] ?? '');
}

function describeLayout(ws: WorkspaceConfinement): string {
  const parts: string[] = [];
  for (const dir of ws.readOnly ?? []) parts.push(`${dir}/ (read-only)`);
  for (const dir of ws.writable ?? []) parts.push(`${dir}/`);
  return parts.length > 0 ? ` Available: ${parts.join(', ')}.` : '';
}

/**
 * Resuelve `input` dentro del workspace. Nunca lanza: cualquier fallo es un
 * rechazo con motivo.
 */
export function confinePath(
  ws: WorkspaceConfinement,
  input: string,
  access: WorkspaceAccess,
): ConfinedPath {
  try {
    if (input.includes('\0')) return { ok: false, reason: 'the path contains a NUL byte' };
    if (IS_WINDOWS) {
      const problem = windowsSyntaxProblem(input);
      if (problem) return { ok: false, reason: problem };
    }
    const root = realpathSync.native(ws.root);
    const absolute = resolve(ws.root, input);
    const real = realpathAllowingMissing(absolute);
    const rel = relativeInside(root, real);
    if (rel === null) {
      return { ok: false, reason: 'it resolves outside the conversation workspace' };
    }
    if (access === 'write') {
      if (rel === '') return { ok: false, reason: 'the workspace root itself cannot be written' };
      const top = firstSegment(rel);
      if ((ws.readOnly ?? []).some((d) => normalizeForCompare(d) === top)) {
        return {
          ok: false,
          reason: `${top}/ is read-only: it keeps the files the user uploaded unchanged`,
        };
      }
      const writable = ws.writable;
      const isDirectChild = !/[\\/]/.test(rel);
      if (writable && (isDirectChild || !writable.some((d) => normalizeForCompare(d) === top))) {
        return {
          ok: false,
          reason: `files can only be written inside ${writable.map((d) => `${d}/`).join(' or ')}`,
        };
      }
    }
    return { ok: true, absolute, relative: rel.split(sep).join('/') };
  } catch (err) {
    return {
      ok: false,
      reason: `it could not be resolved safely (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Veto de `preflight` para una ruta. `null` sin workspace (la CLI) o si la ruta
 * está dentro. Inapelable: ni `--allow-destructive` ni el allow-all lo levantan.
 */
export function workspacePathPreflight(
  input: string | undefined,
  ctx: ToolContext,
  access: WorkspaceAccess,
): ToolResult | null {
  const ws = ctx.workspace;
  if (!ws) return null;
  const verdict = confinePath(ws, input ?? '.', access);
  if (verdict.ok) return null;
  return {
    ok: false,
    error:
      `Access to "${input ?? '.'}" is blocked: ${verdict.reason}. ` +
      'In this conversation you can only work with files inside its workspace, using paths ' +
      `relative to it (for example "outputs/summary.md").${describeLayout(ws)} ` +
      'No configuration or user approval can lift this restriction.',
    recoverable: true,
  };
}

/** Lee un campo de texto de los parámetros crudos sin asumir su forma. */
export function stringParam(params: unknown, key: string): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Segunda comprobación dentro de `execute` (defensa en profundidad, ver cabecera). */
export const workspaceExecuteGuard = workspacePathPreflight;

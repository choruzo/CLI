/**
 * Invocaciones de git del almacén de snapshots y parseo de sus salidas (UX-1).
 *
 * Dos mitades, como en `git/changes.ts`: parseo puro (testeable, sin I/O) y
 * ejecución (`execa`, nunca `child_process`). TODAS las invocaciones pasan por
 * `gitRun` con el entorno cerrado de `env.ts` (`reject: false`: un fallo de git
 * se devuelve, no se lanza — un fallo auxiliar nunca es un error del agente).
 */
import { execa } from 'execa';

export interface GitRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** El proceso se mató por agotar `timeoutMs` (no es un fallo de git). */
  timedOut?: boolean;
}

export interface GitRunOptions {
  /** Siempre la raíz del worktree del proyecto, nunca otra cosa. */
  cwd: string;
  /** Entorno cerrado de `snapshotGitEnv()`. */
  env: NodeJS.ProcessEnv;
  /** stdin: pathspec files (`--pathspec-from-file=-`) y mensajes de commit-tree. */
  input?: string;
  /**
   * Techo de la invocación (`snapshots.timeoutMs`). Sin él, un git colgado
   * bloquearía el turno del agente, que es quien paga el snapshot.
   */
  timeoutMs?: number;
}

/**
 * Ejecuta git y nunca lanza (git ausente del PATH incluido). `extendEnv: false`
 * + env ya saneado: el subproceso no hereda nada que no venga en `env`.
 */
export async function gitRun(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  try {
    const result = await execa('git', args, {
      cwd: opts.cwd,
      env: opts.env,
      input: opts.input,
      reject: false,
      stripFinalNewline: false,
      extendEnv: false,
      ...(opts.timeoutMs
        ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const, forceKillAfterDelay: 1000 }
        : {}),
    });
    const timedOut = result.timedOut === true;
    return {
      ok: !timedOut && result.exitCode === 0,
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout ?? '',
      stderr: timedOut ? `git ${args[0] ?? ''} timed out after ${opts.timeoutMs} ms`.trim() : (result.stderr ?? ''),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } catch (err) {
    return { ok: false, exitCode: -1, stdout: '', stderr: String(err) };
  }
}

/** Cola de un stderr para logs (un stderr de git puede ser enorme). */
export function tail(text: string, max = 400): string {
  const clean = text.replace(/\s+$/, '');
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

// ---------------------------------------------------------------------------
// Parseo de `diff-tree` entre dos árboles (puro)
// ---------------------------------------------------------------------------

export interface NameStatusEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

/**
 * Parsea `git diff-tree -r -z --no-renames --name-status <T0> <T1>`: registros
 * `STATUS<NUL>path<NUL>`. `-z` porque el formato por defecto entrecomilla las
 * rutas con espacios o acentos y desescaparlas a mano es una fuente de bugs.
 * Con `--no-renames` no hay R/C (un renombrado aparece como add + delete);
 * se toleran por si un git antiguo los emite igualmente.
 */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  const fields = text.split('\0');
  const out: NameStatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.startsWith(':')) continue; // cabecera de modo raw: no ocurre con --name-status
    if (field.length !== 1) continue;
    const code = field;
    const path = fields[++i];
    if (!path) continue;
    if (code === 'R' || code === 'C') {
      // Renombrado/copiado: el campo siguiente es el origen, el otro el destino.
      const from = path;
      const dest = fields[++i];
      if (!dest) continue;
      out.push({ path: dest, status: code === 'C' ? 'added' : 'modified' });
      if (code === 'R') out.push({ path: from, status: 'deleted' });
      continue;
    }
    out.push({
      path,
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
    });
  }
  return out;
}

export interface NumstatEntry {
  path: string;
  /** Líneas añadidas. Binario (`-`): ausente, nunca 0. */
  additions?: number;
  /** Líneas borradas. Binario (`-`): ausente, nunca 0. */
  deletions?: number;
}

/**
 * Parsea `git diff-tree -r -z --no-renames --numstat <T0> <T1>`: registros
 * `add<TAB>del<TAB>path<NUL>`. Un binario se marca con `-` en ambos contadores:
 * no tiene líneas que contar (de ahí el `undefined`, nunca 0).
 */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  for (const record of text.split('\0')) {
    if (!record || record.startsWith(':')) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0]!;
    const delRaw = parts[1]!;
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    const binary = addRaw === '-' || delRaw === '-';
    out.push({
      path,
      additions: binary ? undefined : Number(addRaw) || 0,
      deletions: binary ? undefined : Number(delRaw) || 0,
    });
  }
  return out;
}

/**
 * Cruza name-status y numstat por ruta: el estado lo manda name-status, las
 * líneas el numstat. Se ordena por ruta para que el registro sea determinista.
 */
export function mergeTreeDiff(
  nameStatus: NameStatusEntry[],
  numstat: NumstatEntry[],
): Array<{ path: string; status: NameStatusEntry['status']; additions?: number; deletions?: number }> {
  const byPath = new Map<string, { path: string; status: NameStatusEntry['status']; additions?: number; deletions?: number }>();
  for (const ns of nameStatus) {
    byPath.set(ns.path, { path: ns.path, status: ns.status });
  }
  for (const n of numstat) {
    const existing = byPath.get(n.path);
    if (existing) {
      if (n.additions !== undefined) existing.additions = n.additions;
      if (n.deletions !== undefined) existing.deletions = n.deletions;
    } else {
      byPath.set(n.path, {
        path: n.path,
        status: 'modified',
        additions: n.additions,
        deletions: n.deletions,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** True si un `tree hash` tiene forma de hash de objeto git. */
export function isTreeHash(hash: string): boolean {
  return /^[0-9a-f]{40}$/.test(hash);
}

/**
 * Hito 13 — Panel de cambios del working tree (P3 de `gentle-pi`).
 *
 * El usuario mira `git status` constantemente mientras el agente trabaja, y
 * hoy eso obliga a salir al shell. El módulo tiene dos mitades bien separadas:
 * el parseo (puro, testeable, sin I/O) y la recolección (invocaciones de git).
 * La UI solo consume el resumen.
 *
 * Hacen falta dos fuentes:
 *  - `git diff --numstat HEAD` da las LÍNEAS, pero no ve los untracked.
 *  - `git status --porcelain -z` ve todo (untracked incluidos) y da el ESTADO,
 *    pero no cuenta líneas.
 * Se cruzan por ruta; a los untracked se les cuentan las líneas leyendo el
 * fichero, que es la única forma de que un fichero nuevo no aparezca como +0.
 *
 * Ver CLI-DOC/Investigacion/gentle-pi.md §2 (P3).
 */
import { execa } from 'execa';
import { scrubGitEnv } from './env.js';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface WorkingTreeChange {
  path: string;
  added: number;
  deleted: number;
  status: ChangeStatus;
  /** `git diff --numstat` marca los binarios con `-`: no tienen líneas que contar. */
  binary?: boolean;
}

export interface ChangesSummary {
  files: number;
  added: number;
  deleted: number;
  changes: WorkingTreeChange[];
  /** `false` cuando el cwd no es un repo git o git no está disponible. */
  isRepo: boolean;
}

export const EMPTY_SUMMARY: ChangesSummary = {
  files: 0,
  added: 0,
  deleted: 0,
  changes: [],
  isRepo: false,
};

/** Tope de tamaño al contar líneas de un untracked. Por encima, se marca binario. */
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024;

/** Tope de untracked a los que se les cuentan líneas: un `git add` masivo no debe colgar la UI. */
const UNTRACKED_COUNT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Parseo (puro)
// ---------------------------------------------------------------------------

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** Ruta original de un renombrado, cuando git la reporta. */
  from?: string;
}

/**
 * Parsea `git diff --numstat`. Se acepta tanto la forma con llaves
 * (`dir/{a => b}/f.ts`) como la plana (`a.ts => b.ts`); en ambas la ruta que
 * interesa es el destino, que es la que existe en el disco ahora.
 */
export function parseNumstat(text: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const addedRaw = parts[0]!;
    const deletedRaw = parts[1]!;
    const rawPath = parts.slice(2).join('\t');
    const binary = addedRaw === '-' || deletedRaw === '-';
    const { path, from } = splitRename(rawPath);
    out.push({
      path,
      added: binary ? 0 : Number(addedRaw) || 0,
      deleted: binary ? 0 : Number(deletedRaw) || 0,
      binary,
      from,
    });
  }
  return out;
}

function splitRename(raw: string): { path: string; from?: string } {
  if (!raw.includes('=>')) return { path: raw };
  const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    const prefix = braced[1] ?? '';
    const oldMid = braced[2] ?? '';
    const newMid = braced[3] ?? '';
    const suffix = braced[4] ?? '';
    const collapse = (mid: string) => `${prefix}${mid}${suffix}`.replace(/\/{2,}/g, '/');
    return { path: collapse(newMid), from: collapse(oldMid) };
  }
  const parts = raw.split(' => ');
  return { path: (parts[parts.length - 1] ?? raw).trim(), from: parts[0]?.trim() };
}

export interface PorcelainEntry {
  path: string;
  status: ChangeStatus;
  from?: string;
}

/**
 * Parsea `git status --porcelain -z`. El formato `-z` separa entradas con NUL
 * y, en los renombrados, mete la ruta ORIGEN como campo extra justo después de
 * la del destino — por eso el recorrido consume dos campos ahí y no uno. Se usa
 * `-z` y no el formato por defecto porque este último escapa y entrecomilla las
 * rutas con espacios o acentos, y desescaparlas a mano es una fuente de bugs.
 */
export function parsePorcelain(text: string): PorcelainEntry[] {
  const fields = text.split('\0');
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const x = field[0]!;
    const y = field[1]!;
    const path = field.slice(3);
    if (x === 'R' || y === 'R') {
      const from = fields[++i];
      out.push({ path, status: 'renamed', from: from || undefined });
      continue;
    }
    out.push({ path, status: statusFromXY(x, y) });
  }
  return out;
}

function statusFromXY(x: string, y: string): ChangeStatus {
  if (x === '?' || y === '?') return 'untracked';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A' || x === 'C' || y === 'C') return 'added';
  return 'modified';
}

/**
 * Cruza numstat y porcelain por ruta. El estado lo manda porcelain (es quien ve
 * los untracked y los renombrados); las líneas las manda numstat. Un fichero
 * que solo aparece en una de las dos listas se conserva igualmente: los
 * untracked solo están en porcelain, y un cambio indexado y luego revertido en
 * el árbol puede aparecer solo en numstat.
 */
export function mergeChanges(
  numstat: NumstatEntry[],
  porcelain: PorcelainEntry[],
): WorkingTreeChange[] {
  const byPath = new Map<string, WorkingTreeChange>();

  for (const entry of numstat) {
    byPath.set(entry.path, {
      path: entry.path,
      added: entry.added,
      deleted: entry.deleted,
      status: entry.from ? 'renamed' : 'modified',
      binary: entry.binary || undefined,
    });
  }

  for (const entry of porcelain) {
    const existing = byPath.get(entry.path);
    if (existing) {
      existing.status = entry.status;
    } else {
      byPath.set(entry.path, { path: entry.path, added: 0, deleted: 0, status: entry.status });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function summarize(changes: WorkingTreeChange[], isRepo = true): ChangesSummary {
  let added = 0;
  let deleted = 0;
  for (const c of changes) {
    added += c.added;
    deleted += c.deleted;
  }
  return { files: changes.length, added, deleted, changes, isRepo };
}

/** `+N/-M` compacto para la barra de estado. Cadena vacía si no hay nada que enseñar. */
export function formatCompact(summary: ChangesSummary): string {
  if (!summary.isRepo || summary.files === 0) return '';
  return `+${summary.added}/-${summary.deleted}`;
}

const STATUS_MARK: Record<ChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

/** Desglose por fichero para `/changes`. */
export function formatChangesReport(summary: ChangesSummary): string {
  if (!summary.isRepo) {
    return 'El directorio actual no es un repositorio git (o git no está disponible).';
  }
  if (summary.files === 0) return 'El working tree está limpio.';

  const width = Math.min(60, Math.max(...summary.changes.map((c) => c.path.length)));
  const rows = summary.changes.map((c) => {
    const counts = c.binary ? 'bin' : `+${c.added}/-${c.deleted}`;
    return `  ${STATUS_MARK[c.status]} ${c.path.padEnd(width)}  ${counts}`;
  });
  return [
    `Cambios en el working tree (${summary.files} fichero(s), +${summary.added}/-${summary.deleted}):`,
    '',
    ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Recolección (I/O)
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execa('git', args, {
      cwd,
      reject: false,
      stripFinalNewline: false,
      // Sin esto, un `GIT_DIR` heredado del entorno haría que estas dos
      // invocaciones midieran otro repositorio, ignorando `cwd` (ver git/env.ts).
      env: scrubGitEnv(),
      extendEnv: false,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout;
  } catch {
    // git ausente del PATH: se degrada a «no es un repo», nunca se lanza.
    return null;
  }
}

/**
 * Estado del working tree. Nunca lanza: ante cualquier fallo (no es un repo,
 * git no instalado, repo sin commits) devuelve `isRepo: false` y la UI
 * simplemente no pinta el segmento.
 */
export async function collectWorkingTreeChanges(cwd: string): Promise<ChangesSummary> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') return EMPTY_SUMMARY;

  // git reporta las rutas relativas a la RAÍZ del repo, no al cwd. Sin esto,
  // invocar Stratum desde un subdirectorio hace que las lecturas de los
  // untracked apunten a rutas inexistentes y todos cuenten 0 líneas.
  const top = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  const root = top && top.length > 0 ? top : cwd;

  // `HEAD` no existe en un repo recién iniciado sin commits; ahí el diff está
  // vacío y todo lo que hay son untracked, que porcelain sí ve.
  const hasHead = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])) !== null;
  const numstatText = hasHead ? ((await git(cwd, ['diff', '--numstat', 'HEAD'])) ?? '') : '';
  // `-uall` es imprescindible: por defecto git colapsa un directorio nuevo
  // entero en una sola entrada `dir/`, y entonces no hay líneas que contar ni
  // ficheros que enseñar.
  const porcelainText = (await git(cwd, ['status', '--porcelain', '-z', '-uall'])) ?? '';

  const changes = mergeChanges(parseNumstat(numstatText), parsePorcelain(porcelainText));
  await countUntrackedLines(root, changes);
  return summarize(changes);
}

/**
 * Un fichero nuevo con 300 líneas escritas por el agente no puede aparecer como
 * `+0`: es justo el cambio que el usuario quiere ver. git no lo cuenta porque
 * no lo tiene indexado, así que se cuenta leyéndolo.
 */
async function countUntrackedLines(root: string, changes: WorkingTreeChange[]): Promise<void> {
  const untracked = changes.filter((c) => c.status === 'untracked').slice(0, UNTRACKED_COUNT_LIMIT);
  await Promise.all(
    untracked.map(async (change) => {
      try {
        const full = join(root, change.path);
        const info = await stat(full);
        if (!info.isFile()) return;
        if (info.size > UNTRACKED_MAX_BYTES) {
          change.binary = true;
          return;
        }
        const buf = await readFile(full);
        if (buf.includes(0)) {
          change.binary = true;
          return;
        }
        change.added = countLines(buf.toString('utf8'));
      } catch {
        /* fichero borrado entre el status y la lectura: se deja en 0 */
      }
    }),
  );
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  // Un fichero terminado en \n no tiene una última línea vacía.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

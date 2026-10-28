/**
 * El workspace de un escenario como mapa `ruta relativa → contenido`: lo que
 * `setup.files` escribe al empezar y lo que el criterio `workspace_expected`
 * compara al terminar. Las rutas van siempre con `/`.
 */
import { lstatSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Lo que no es del workspace del usuario: lo escribe el runner (la config del
 * escenario) o el propio Stratum (memoria, guías), o no es código.
 */
const IGNORED_DIRS = new Set(['.git', '.stratum', 'node_modules']);
const IGNORED_ROOT_FILES = new Set(['.stratumrc.json']);

/** Topes al leer una carpeta para meterla en un escenario: va entera en el JSON. */
export const WORKSPACE_MAX_FILES = 500;
export const WORKSPACE_MAX_BYTES = 2_000_000;

export interface WorkspaceEntry {
  path: string;
  /** Fichero normal, enlace u otra cosa (socket, dispositivo). */
  type: 'file' | 'symlink' | 'other';
}

/** Entradas del workspace que cuentan, en orden estable. Ninguna lectura falla. */
export function listWorkspace(root: string): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  const visit = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) visit(full, rel);
      } else if (!prefix && IGNORED_ROOT_FILES.has(name)) {
        continue;
      } else {
        out.push({
          path: rel,
          type: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other',
        });
      }
    }
  };
  visit(root, '');
  return out;
}

export class WorkspaceReadError extends Error {}

/**
 * Lee una carpeta como `setup.files` o como el esperado de `workspace_expected`.
 * Solo texto UTF-8: un binario, un enlace o pasarse de los topes es un error,
 * nunca un fichero que se salta en silencio (el escenario mentiría sobre el mundo).
 */
export function readWorkspaceDir(root: string): Record<string, string> {
  try {
    if (!lstatSync(root).isDirectory()) throw new WorkspaceReadError(`${root} no es una carpeta`);
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw err;
    throw new WorkspaceReadError(`no se puede leer ${root}`);
  }
  const entries = listWorkspace(root);
  if (entries.length > WORKSPACE_MAX_FILES) {
    throw new WorkspaceReadError(
      `${root}: ${entries.length} ficheros (máximo ${WORKSPACE_MAX_FILES})`,
    );
  }
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const entry of entries) {
    if (entry.type !== 'file') {
      throw new WorkspaceReadError(`${entry.path}: no es un fichero normal (${entry.type})`);
    }
    const raw = readFileSync(join(root, entry.path));
    bytes += raw.length;
    if (bytes > WORKSPACE_MAX_BYTES) {
      throw new WorkspaceReadError(`${root}: más de ${WORKSPACE_MAX_BYTES} bytes`);
    }
    const text = raw.toString('utf8');
    if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(raw)) {
      throw new WorkspaceReadError(`${entry.path}: no es texto UTF-8`);
    }
    files[entry.path] = text;
  }
  return files;
}

/** Primera línea (1-based) en la que dos textos difieren. */
export function firstDifferingLine(a: string, b: string): number {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) if (la[i] !== lb[i]) return i + 1;
  return n;
}

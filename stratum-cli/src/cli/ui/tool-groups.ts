/**
 * Agrupación de tool calls exploratorias en los turnos cerrados (UX-3). Cinco
 * `read_file` seguidos son una sola idea —«ha estado leyendo»— y ocupaban cinco
 * líneas del scrollback. Solo se agrupa lo que no cambia nada y salió bien: un
 * error, una escritura o un comando cortan el grupo y se ven sueltos. Puro.
 */
import type { ToolCallState } from './ToolCallBlock.js';
import { primaryArg } from './tool-arg-label.js';

/** Cuánto detalle pinta la conversación (`/verbosity`). */
export type Verbosity = 'compact' | 'standard' | 'verbose';

export const VERBOSITY_LEVELS: readonly Verbosity[] = ['compact', 'standard', 'verbose'];

export type ToolFamily = 'read' | 'search' | 'web';

const FAMILY: Record<string, ToolFamily> = {
  read_file: 'read',
  list_directory: 'read',
  read_skill: 'read',
  grep: 'search',
  glob: 'search',
  web_fetch: 'web',
  web_search: 'web',
};

export function toolFamily(name: string): ToolFamily | null {
  return FAMILY[name] ?? null;
}

export type ToolRow =
  | { kind: 'call'; call: ToolCallState }
  | { kind: 'group'; id: string; calls: ToolCallState[] };

/** Llamadas que pueden ir en un grupo: exploratorias y ya terminadas bien. */
function groupable(call: ToolCallState): boolean {
  return call.status === 'completed' && toolFamily(call.name) !== null;
}

/**
 * Parte la lista en filas: las rachas de `minRun` o más llamadas agrupables
 * seguidas se vuelven un grupo; el resto queda como estaba, en su orden.
 */
export function groupToolCalls(calls: readonly ToolCallState[], minRun = 2): ToolRow[] {
  const rows: ToolRow[] = [];
  let run: ToolCallState[] = [];
  const flush = (): void => {
    if (run.length >= minRun) rows.push({ kind: 'group', id: `group-${run[0]!.id}`, calls: run });
    else for (const call of run) rows.push({ kind: 'call', call });
    run = [];
  };
  for (const call of calls) {
    if (groupable(call)) {
      run.push(call);
      continue;
    }
    flush();
    rows.push({ kind: 'call', call });
  }
  flush();
  return rows;
}

const NOUNS: Record<ToolFamily, [string, string]> = {
  read: ['lectura', 'lecturas'],
  search: ['búsqueda', 'búsquedas'],
  web: ['consulta web', 'consultas web'],
};

/** `3 lecturas · 2 búsquedas`, en el orden fijo leer → buscar → web. */
export function describeGroup(calls: readonly ToolCallState[]): string {
  const counts = new Map<ToolFamily, number>();
  for (const call of calls) {
    const family = toolFamily(call.name);
    if (family) counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return (['read', 'search', 'web'] as const)
    .filter((f) => counts.has(f))
    .map((f) => {
      const n = counts.get(f)!;
      return `${n} ${NOUNS[f][n === 1 ? 0 : 1]}`;
    })
    .join(' · ');
}

/**
 * Lo que tocó el grupo, por su argumento identificador. Las rutas se recortan
 * por la izquierda: lo que distingue un fichero es su nombre, no `src/`.
 */
export function groupTargets(calls: readonly ToolCallState[], maxChars: number): string {
  const labels = [...new Set(calls.map((c) => shortLabel(primaryArg(c.input))).filter(Boolean))];
  let out = '';
  for (let i = 0; i < labels.length; i++) {
    const next = out ? `${out}, ${labels[i]}` : labels[i]!;
    const rest = labels.length - i - 1;
    const suffix = rest > 0 ? `, +${rest}` : '';
    if (next.length + suffix.length > maxChars) {
      const left = labels.length - i;
      return out ? `${out}, +${left}` : `+${left}`;
    }
    out = next;
  }
  return out;
}

/** Ruta larga → `…/dir/fichero.ts`; el resto, cortado a 40 caracteres. */
export function shortLabel(label: string): string {
  if (label.length <= 40) return label;
  const parts = label.split(/[\\/]/);
  if (parts.length > 2) {
    const tail = parts.slice(-2).join('/');
    if (tail.length <= 38) return `…/${tail}`;
  }
  return `…${label.slice(-39)}`;
}

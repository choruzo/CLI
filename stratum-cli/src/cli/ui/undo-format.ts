/**
 * Textos de `/undo` y `/rewind` (UX-1). Puro: lo pintan el selector de turnos y
 * los mensajes de resultado, y lo prueban sus tests.
 */

/** Lo que de un `TurnRecord` (`snapshots/registry.ts`) enseña la UI. */
export interface UndoableTurnView {
  turn: number;
  endedAt: string;
  files: {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions?: number;
    deletions?: number;
  }[];
}

/** `hace 40 s`, `hace 3 min`, `hace 2 h`, `hace 3 d`. */
export function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/**
 * `+12 −3` sumando solo lo que git contó; un binario (sin líneas) no suma 0:
 * si ningún fichero tiene cuenta, no hay segmento.
 */
export function lineDelta(files: UndoableTurnView['files']): string {
  let add: number | undefined;
  let del: number | undefined;
  for (const f of files) {
    if (f.additions !== undefined) add = (add ?? 0) + f.additions;
    if (f.deletions !== undefined) del = (del ?? 0) + f.deletions;
  }
  if (add === undefined && del === undefined) return '';
  return `+${add ?? 0} −${del ?? 0}`;
}

/** Fila del selector de `/rewind`: `turno 5 · hace 3 min · 4 ficheros · +12 −3`. */
export function describeUndoableTurn(t: UndoableTurnView, now: number): string {
  const n = t.files.length;
  const delta = lineDelta(t.files);
  return [`turno ${t.turn}`, ago(t.endedAt, now), `${n} fichero${n === 1 ? '' : 's'}`, delta]
    .filter(Boolean)
    .join(' · ');
}

/** Lista corta de nombres para el hint del selector: `App.tsx, theme.ts, +2`. */
export function fileHint(t: UndoableTurnView, max = 3): string {
  const names = t.files.map((f) => f.path.split(/[\\/]/).at(-1) ?? f.path);
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, +${names.length - max}` : shown;
}

/** Por qué no se deshizo nada, en palabras del usuario. */
export function revertFailureText(reason: string, conflicts?: string[]): string {
  switch (reason) {
    case 'disabled':
      return 'Deshacer no está disponible en esta sesión (hace falta un repositorio git; mira el log para el motivo).';
    case 'turn-in-progress':
      return 'Hay un turno en curso: espera a que termine (o páralo) para deshacer.';
    case 'conflicts':
      return `No se deshizo nada: ${conflicts?.length ?? 0} fichero(s) cambiaron después del turno.`;
    case 'no-turns':
      return 'No hay turnos con cambios de ficheros que deshacer.';
    default:
      return 'No se pudo deshacer: fallo del almacén de snapshots (detalle en el log). Revisa /changes por si quedó a medias.';
  }
}

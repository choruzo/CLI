/**
 * Resúmenes de una línea para las tarjetas de tool call. Puro (sin React, sin
 * Node): interpreta la salida real de cada familia —el diff de `edit_file`, el
 * sobre `<exec_result>` de `exec`— para pintar `+1 −1`, `N líneas` o «en
 * segundo plano».
 */
import { toolFamily, shortLabel } from './tool-groups.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { formatInput, primaryArg } from './tool-arg-label.js';

export type ToolIntent = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'other';

/** Qué clase de salida produce la tool: decide cómo se resume. */
export function toolIntent(name: string): ToolIntent {
  if (name === 'exec' || name === 'ssh_exec') return 'terminal';
  if (name === 'edit_file' || name === 'write_file') return 'diff';
  return toolFamily(name) ?? 'other';
}

/** El diff de `edit_file`: desde `--- ` hasta la primera línea vacía; `end` apunta al resto (informe LSP). */
function diffSegment(output: string): { seg: string[]; end: number } | null {
  const lines = output.split('\n');
  const start = lines.findIndex((l) => l.startsWith('--- '));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== '') end++; // dentro del diff no hay líneas vacías (el contexto vacío es ' ')
  return { seg: lines.slice(start, end), end };
}

export type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'ctx'; text: string };

/** Clasifica el segmento ya recortado; las cabeceras `---`/`+++` no se devuelven. */
function classify(seg: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 1; // seg[0] es siempre la cabecera `--- `
  if (seg[1]?.startsWith('+++ ')) i = 2;
  for (; i < seg.length; i++) {
    const line = seg[i]!;
    if (line.startsWith('@@')) out.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1) });
    else out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  return out;
}

/** Líneas del diff (`@@…` → hunk, `+x` → add, `-x` → del, ` x` → ctx); `[]` si no hay diff. */
export function diffLines(output: string): DiffLine[] {
  const found = diffSegment(output);
  return found ? classify(found.seg) : [];
}

/** `+N −M` (`partial: true` si la salida vino truncada y la cifra se queda corta); null si no hay diff. */
export function diffStats(output: string): {
  added: number;
  removed: number;
  partial: boolean;
} | null {
  const found = diffSegment(output);
  if (!found) return null;
  const lines = classify(found.seg);
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
    partial: output.includes('[... output truncated ('),
  };
}

/** Texto posterior al diff (informe LSP), sin las líneas vacías del borde; '' si no hay. */
export function diffTrailer(output: string): string {
  const found = diffSegment(output);
  if (!found) return '';
  return output
    .split('\n')
    .slice(found.end)
    .join('\n')
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '');
}

/** Desescapado XML en orden seguro: `&amp;` el último (así `&amp;amp;` → `&amp;`). */
function unescapeXml(s: string): string {
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * Abre el sobre `<exec_result …>` de `exec`/`ssh_exec`: status, exitCode (null
 * si `unknown` o ausente) y body = stdout + stderr desescapados. Si el sobre
 * vino cortado por el truncado de salida (sin `</stdout>`), raspa lo que haya
 * tras la apertura, sin etiquetas. Sin sobre, la salida se devuelve tal cual.
 */
export function execSummary(output: string): {
  exitCode: number | null;
  status: string | null;
  body: string;
} {
  const open = /<exec_result\b[^>]*>/.exec(output);
  if (!open) return { exitCode: null, status: null, body: output };
  const attrs = open[0];
  const status = /\bstatus="([^"]*)"/.exec(attrs)?.[1] ?? null;
  const code = /\bexitCode="([^"]*)"/.exec(attrs)?.[1] ?? null;
  const exitCode = code !== null && /^-?\d+$/.test(code) ? Number(code) : null;
  const stdout = /<stdout>([\s\S]*?)<\/stdout>/.exec(output)?.[1];
  const stderr = /<stderr>([\s\S]*?)<\/stderr>/.exec(output)?.[1];
  let raw: string;
  if (stdout !== undefined || stderr !== undefined) {
    const parts = [stdout, stderr].filter((s): s is string => s !== undefined && s.length > 0);
    raw = parts.length > 0 ? parts.join('\n') : '';
  } else {
    raw = truncatedEnvelopeBody(output, open);
  }
  // El salto final de stdout no es contenido: pintaría una fila vacía y contaría de más.
  raw = raw.replace(/(?:\r?\n)+$/, '');
  return { exitCode, status, body: unescapeXml(raw) };
}

/** Sobre sin cierre: el texto posterior a la línea de apertura, sin etiquetas ni sangría. */
function truncatedEnvelopeBody(output: string, open: RegExpExecArray): string {
  const nl = output.indexOf('\n', open.index);
  if (nl < 0) return '';
  return output
    .slice(nl + 1)
    .replace(/^ {2}<(stdout|stderr)>/gm, '')
    .replaceAll(/<\/(stdout|stderr|exec_result)>/g, '')
    .replace(/(?:\r?\n)+$/, '');
}

/** Etiqueta de la tarjeta: ruta recortada para diff/read/search, el resto via `formatInput`. */
export function cardLabel(state: ToolCallState): string {
  const intent = toolIntent(state.name);
  if (intent === 'diff' || intent === 'read' || intent === 'search') {
    return shortLabel(primaryArg(state.input));
  }
  return formatInput(state);
}

/** Resumen de una línea (`+1 −1`, `3 líneas`, «en segundo plano»); null si no aporta nada. */
export function cardSummary(state: ToolCallState): string | null {
  if (state.status !== 'completed' || !state.output) return null;
  const intent = toolIntent(state.name);
  if (intent === 'diff') {
    const stats = diffStats(state.output);
    return stats ? `+${stats.added} −${stats.removed}${stats.partial ? '…' : ''}` : null;
  }
  if (intent === 'terminal') {
    // Un exec a segundo plano vuelve con el job vivo: su sobre es `<exec_job>`, no salida.
    if (state.output.trimStart().startsWith('<exec_job')) return 'en segundo plano';
    // Un exit ≠ 0, timeout o cancelado llega como `error` (lo pinta `errorHeadline`).
    const { body } = execSummary(state.output);
    const lines = body.split('\n').filter((l) => l.trim() !== '').length;
    if (lines === 0) return null;
    return lines === 1 ? '1 línea' : `${lines} líneas`;
  }
  if (state.name === 'read_file') {
    // Salida real: líneas `12: texto`; el pie `(File has more lines…)` no cuenta.
    const lines = state.output.split('\n').filter((l) => /^\d+: /.test(l));
    // El salto final genera una última numerada vacía (`4: `): no es contenido.
    const last = lines[lines.length - 1];
    if (last !== undefined && /^\d+: $/.test(last) && !state.output.includes('(File has more lines')) {
      lines.pop();
    }
    if (lines.length === 0) return null;
    return lines.length === 1 ? '1 línea' : `${lines.length} líneas`;
  }
  return null;
}

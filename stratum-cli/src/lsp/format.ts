/**
 * Texto de diagnósticos que se anexa al resultado de `edit_file`/`write_file`
 * (encargo UX-2b). Puro: recibe el informe que produce el `LspClient` y lo
 * convierte en algo que el modelo pueda leer de un vistazo.
 *
 * Los números que se pintan son los del servidor (0-based en LSP) pasados a
 * 1-based, que es como los cuenta un humano y como los espera el propio modelo
 * al leer un fichero con `read_file`.
 */

/** `DiagnosticSeverity` de LSP. */
export const LSP_SEVERITY = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
} as const;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error, 2 warning, 3 info, 4 hint. Ausente = error (lo más seguro). */
  severity?: number;
  /** `TS2322`, `E0308`… Tal como lo manda el servidor. */
  code?: string | number | { value: string | number };
  message: string;
  source?: string;
}

/** Última publicación de diagnósticos de un fichero. */
export interface DiagnosticsReport {
  /** Nombre del servidor que los publica (`typescript`, `pyright`…). */
  server: string;
  /** URI `file://…` del fichero diagnosticado. */
  uri: string;
  /** Versión del documento a la que corresponden, si el server la manda. */
  version?: number;
  diagnostics: LspDiagnostic[];
}

export interface FormatDiagnosticsOptions {
  maxDiagnostics: number;
  /** Umbral mínimo: `error` solo errores; `warning` errores y avisos. */
  severity: 'error' | 'warning';
  /** Ruta tal cual quiere verla el modelo (relativa al cwd). */
  displayPath: string;
}

const LABELS: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

function severityOf(diagnostic: LspDiagnostic): number {
  const severity = diagnostic.severity;
  return typeof severity === 'number' && LABELS[severity] !== undefined ? severity : 1;
}

function thresholdOf(severity: 'error' | 'warning'): number {
  return severity === 'warning' ? LSP_SEVERITY.warning : LSP_SEVERITY.error;
}

function codeText(code: LspDiagnostic['code']): string | null {
  if (typeof code === 'string') {
    const trimmed = code.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof code === 'number') return String(code);
  if (code !== null && code !== undefined && typeof code === 'object') {
    return codeText(code.value);
  }
  return null;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Una línea por diagnóstico: los mensajes del server traen saltos. */
function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

export function formatDiagnostics(
  report: DiagnosticsReport,
  options: FormatDiagnosticsOptions,
): string {
  const threshold = thresholdOf(options.severity);
  const kept = report.diagnostics.filter((d) => severityOf(d) <= threshold);
  const header = `Diagnostics (${report.server}) for ${options.displayPath}`;

  if (kept.length === 0) {
    return options.severity === 'warning'
      ? `${header}: no errors or warnings.`
      : `${header}: no errors.`;
  }

  const errors = kept.filter((d) => severityOf(d) === LSP_SEVERITY.error).length;
  const warnings = kept.filter((d) => severityOf(d) === LSP_SEVERITY.warning).length;
  const counts =
    options.severity === 'warning'
      ? [
          ...(errors > 0 ? [plural(errors, 'error')] : []),
          ...(warnings > 0 ? [plural(warnings, 'warning')] : []),
        ].join(', ')
      : plural(errors, 'error');

  const max = Math.max(1, Math.trunc(options.maxDiagnostics));
  const shown = kept.slice(0, max);
  const rows = shown.map((diagnostic) => {
    const { line, character } = diagnostic.range.start;
    const code = codeText(diagnostic.code);
    const parts = [`${line + 1}:${character + 1}`, LABELS[severityOf(diagnostic)]!];
    if (code !== null) parts.push(code);
    parts.push(oneLine(diagnostic.message));
    return `  ${parts.join('  ')}`;
  });
  const hidden = kept.length - shown.length;
  if (hidden > 0) rows.push(`  … +${hidden} more`);

  return [`${header} — ${counts}:`, ...rows].join('\n');
}

/**
 * Emisor YAML mínimo y determinista para valores JSON (M27): lo que la API de
 * Home Assistant devuelve de una automatización, para enseñarla legible. Solo
 * emite; no lee YAML. Las claves salen en el orden en que vienen.
 *
 * Una cadena va entre comillas (`JSON.stringify`) cuando un lector de YAML la
 * leería como otra cosa: vacía, con `: ` o `#`, con saltos de línea o
 * controles, con un indicador YAML al principio, con espacios en los bordes, o
 * que parezca un número, un booleano, un `null`, una fecha o una hora.
 */

const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
const BOOL_NULL = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
/** Números, fechas y horas (`12:30:00` es un sexagesimal en YAML 1.1). */
const NUMBERISH = /^[-+.]?\d/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (CONTROLS.test(s)) return true;
  if (s.includes(': ') || s.endsWith(':') || s.includes('#')) return true;
  if (INDICATOR_START.test(s)) return true;
  if (BOOL_NULL.test(s)) return true;
  if (NUMBERISH.test(s)) return true;
  return false;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return needsQuotes(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(String(v));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lo que cabe en una línea: escalares y contenedores vacíos. */
function inline(v: unknown): string | null {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : null;
  if (isObject(v))
    return Object.keys(v).filter((k) => v[k] !== undefined).length === 0 ? '{}' : null;
  return scalar(v);
}

function block(v: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      const one = inline(item);
      if (one !== null) {
        lines.push(`${pad}- ${one}`);
        continue;
      }
      const inner = block(item, indent + 2);
      // La primera línea del elemento comparte línea con el guion.
      inner[0] = `${pad}- ${inner[0]!.slice(indent + 2)}`;
      lines.push(...inner);
    }
    return lines;
  }
  if (isObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      const key = scalar(k);
      const one = inline(val);
      if (one !== null) {
        lines.push(`${pad}${key}: ${one}`);
      } else {
        lines.push(`${pad}${key}:`, ...block(val, indent + 2));
      }
    }
    return lines;
  }
  return [`${pad}${scalar(v)}`];
}

/** El valor como YAML, sin salto de línea final. */
export function toYaml(value: unknown): string {
  const one = inline(value);
  if (one !== null) return one;
  return block(value, 0).join('\n');
}

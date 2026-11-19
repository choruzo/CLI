/**
 * M22 — comprobaciones de un conector (`docs/PRD_STRATUM_DOT.md` §23.11, M22
 * parte 1). Sin I/O: valida los argumentos fijos de un vigilante contra la
 * comprobación que declara el manifiesto, y lee el resultado estructurado que
 * devuelve el conector.
 *
 * El resultado sale de la caja de conectores y trae datos de fuera (el nombre de
 * una entidad, el asunto de un correo): es **contenido no confiable**. Por eso se
 * neutraliza (sin controles, sin marcas de dirección, una sola línea) y se recorta
 * aquí, antes de que nadie lo compare, lo guarde o lo enseñe.
 */
import { z } from 'zod';
import { WATCH_LIMITS } from '../protocol/index.js';
import type { ConnectorCheck, ConnectorCheckArg } from './manifest.js';

/** Tope de `estado` tras neutralizar: lo que compara una condición. */
export const CHECK_STATE_MAX = WATCH_LIMITS.stateChars;
/** Tope de `detalle` tras neutralizar: lo que enseña un aviso. */
export const CHECK_DETAIL_MAX = 300;
/** Tope del motivo de un fallo de la comprobación. */
const CHECK_REASON_MAX = 300;

export type CheckArgValue = string | number | boolean;

/** Resultado de una comprobación, ya neutralizado. `valor` desconocido es `null`, nunca 0. */
export interface CheckResult {
  estado: string;
  valor: number | null;
  detalle: string;
}

export type CheckOutcome = { ok: true; result: CheckResult } | { ok: false; reason: string };

/**
 * Controles C0/C1, separadores de línea y párrafo, y las marcas de dirección e
 * invisibles (bidi, ZW*, BOM) que pueden disfrazar un texto.
 */
const UNSAFE_RANGES: Array<[number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
function isUnsafeCodePoint(cp: number): boolean {
  return UNSAFE_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

function hasUnsafe(text: string): boolean {
  for (const ch of text) if (isUnsafeCodePoint(ch.codePointAt(0)!)) return true;
  return false;
}

function stripUnsafe(text: string): string {
  let out = '';
  for (const ch of text) out += isUnsafeCodePoint(ch.codePointAt(0)!) ? ' ' : ch;
  return out;
}

/** Una línea, sin controles ni marcas invisibles, espacios colapsados y recortada. */
export function neutralizeCheckText(text: string, max: number): string {
  const flat = stripUnsafe(text).replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

const RawResultSchema = z.object({
  estado: z.string(),
  valor: z.number().finite().nullable().optional(),
  detalle: z.string().optional(),
});

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join(' ');
}

/**
 * Lee lo que devolvió `tools/call` de una comprobación. Un `isError`, un resultado
 * sin `structuredContent` o con otra forma es un **fallo** de la comprobación
 * (no puede mirar), nunca un estado.
 */
export function parseCheckResult(raw: unknown): CheckOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'the check returned nothing' };
  }
  const r = raw as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  if (r.isError === true) {
    const text = neutralizeCheckText(textOf(r.content), CHECK_REASON_MAX);
    return { ok: false, reason: text || 'the check failed' };
  }
  const parsed = RawResultSchema.safeParse(r.structuredContent);
  if (!parsed.success) {
    return { ok: false, reason: 'the check returned no structured result' };
  }
  const estado = neutralizeCheckText(parsed.data.estado, CHECK_STATE_MAX);
  if (!estado) return { ok: false, reason: 'the check returned an empty state' };
  return {
    ok: true,
    result: {
      estado,
      valor: parsed.data.valor ?? null,
      detalle: neutralizeCheckText(parsed.data.detalle ?? '', CHECK_DETAIL_MAX),
    },
  };
}

export type CheckArgsOutcome =
  | { ok: true; args: Record<string, CheckArgValue> }
  | { ok: false; error: string };

function argError(arg: ConnectorCheckArg, what: string): { ok: false; error: string } {
  return { ok: false, error: `Argument "${arg.name}" ${what}` };
}

function checkArg(
  arg: ConnectorCheckArg,
  value: unknown,
): { ok: true; value: CheckArgValue } | { ok: false; error: string } {
  switch (arg.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return argError(arg, 'must be true or false');
      return { ok: true, value };
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return argError(arg, 'must be a number');
      }
      if (arg.type === 'integer' && !Number.isInteger(value)) {
        return argError(arg, 'must be an integer');
      }
      if (arg.minimum !== undefined && value < arg.minimum) {
        return argError(arg, `must be at least ${arg.minimum}`);
      }
      if (arg.maximum !== undefined && value > arg.maximum) {
        return argError(arg, `must be at most ${arg.maximum}`);
      }
      return { ok: true, value };
    }
    case 'string': {
      if (typeof value !== 'string') return argError(arg, 'must be a string');
      if (value.length === 0) return argError(arg, 'must not be empty');
      if (hasUnsafe(value)) {
        return argError(arg, 'has control or invisible characters');
      }
      if (arg.maxLength !== undefined && [...value].length > arg.maxLength) {
        return argError(arg, `admits at most ${arg.maxLength} characters`);
      }
      if (arg.enum && !arg.enum.includes(value)) {
        return argError(arg, `must be one of: ${arg.enum.join(', ')}`);
      }
      if (arg.pattern !== undefined && !new RegExp(`^(?:${arg.pattern})$`, 'u').test(value)) {
        return argError(arg, 'does not have the expected format');
      }
      return { ok: true, value };
    }
  }
}

/**
 * Valida los argumentos fijos de un vigilante contra su comprobación: solo los
 * declarados, los obligatorios presentes y cada uno de su tipo. No convierte
 * nada (un `"5"` no es un número): lo que se guarda es lo que se validó.
 */
export function validateCheckArgs(check: ConnectorCheck, args: unknown): CheckArgsOutcome {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: 'Arguments must be an object' };
  }
  const given = args as Record<string, unknown>;
  const declared = new Map(check.args.map((a) => [a.name, a]));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) {
      return { ok: false, error: `Unknown argument "${key}" for check "${check.tool}"` };
    }
  }
  const out: Record<string, CheckArgValue> = {};
  for (const arg of check.args) {
    const value = given[arg.name];
    if (value === undefined) {
      if (arg.required) return argError(arg, 'is required');
      continue;
    }
    const r = checkArg(arg, value);
    if (!r.ok) return r;
    out[arg.name] = r.value;
  }
  return { ok: true, args: out };
}

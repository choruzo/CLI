/**
 * Redacción de secretos en los campos de log.
 *
 * Stratum es provider-agnostic y maneja API keys (`apiKey`, `Authorization`,
 * tokens de Tavily, etc.). Estos valores NUNCA deben acabar en un log que el
 * usuario pueda adjuntar a un bug report. La redacción se aplica a los campos
 * estructurados antes de que lleguen a cualquier sink.
 */

const REDACTED = '«redacted»';

/** Claves cuyo valor se redacta por completo (comparación case-insensitive). */
const SENSITIVE_KEYS = new Set(
  [
    'apikey',
    'api_key',
    'authorization',
    'password',
    'passwd',
    'secret',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'tavilyapikey',
    'cookie',
    'set-cookie',
  ].map((k) => k.toLowerCase()),
);

/** Patrones de secretos embebidos en strings (cabeceras, claves OpenAI…). */
const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /sk-[A-Za-z0-9]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g, // tokens estilo Slack
];

function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Devuelve una copia de `value` con los secretos redactados. No muta la
 * entrada. Acota la profundidad para no recursar sobre estructuras cíclicas o
 * gigantes.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Redacta un objeto de campos de log. `undefined` se propaga sin cambios. */
export function redactFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return fields;
  return redact(fields) as Record<string, unknown>;
}

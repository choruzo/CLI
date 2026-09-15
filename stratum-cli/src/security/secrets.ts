/**
 * Hito 16 — catálogo de secretos con estructura reconocible.
 *
 * Es el núcleo NO desactivable de la redacción de salidas de tool (§11.3 de
 * `CLI-DOC/Orientacion-Infraestructura.md`), y lo comparte `logging/redact.ts`.
 * Misma decisión que la capa 1 de las guardas: un secreto filtrado al historial
 * —que se persiste y se reenvía al provider en cada iteración— no puede
 * depender de un fichero JSON.
 *
 * El riesgo contrario es el falso positivo: tachar un hash de commit o un ID de
 * recurso deja al modelo ciego sin explicación. Por eso cada patrón exige un
 * prefijo o una forma que un identificador corriente no tiene, y los
 * identificadores sensibles pero no secretos (`AKIA…`) se quedan fuera.
 *
 * Todas las regex son lineales salvo la de PEM, que además solo se evalúa si
 * el texto contiene la cadena `PRIVATE KEY` (`hint`).
 */

export interface SecretPattern {
  id: string;
  /** Motivo legible que se deja en la marca `[redacted: <reason>]`. */
  reason: string;
  /** Subcadena que debe aparecer para que merezca la pena evaluar la regex. */
  hint?: string;
  /** Global. Si tiene grupo `keep`, ese prefijo se conserva delante de la marca. */
  re: RegExp;
}

/**
 * El orden importa: `Authorization: Bearer <token>` lo resuelve la regla de la
 * cabecera y la de `Bearer` ya no casa sobre la marca (`[` no está en su
 * alfabeto), así que sale una única marca.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private_key',
    reason: 'private key',
    hint: 'PRIVATE KEY',
    // Un bloque cortado por un límite de salida (sin END) se redacta hasta el final.
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    id: 'authorization_header',
    reason: 'authorization header',
    re: /(?<keep>\bAuthorization["']?\s*[:=]\s*["']?(?:[A-Za-z][\w-]*\s+)?)[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    id: 'bearer_token',
    reason: 'bearer token',
    re: /(?<keep>\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
  },
  {
    id: 'jwt',
    reason: 'JWT',
    hint: 'eyJ',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: 'openai_style_key',
    reason: 'API key',
    hint: 'sk-',
    // Exige al menos un dígito: descarta nombres tipo `sk-some-long-css-class-name`.
    re: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'slack_token',
    reason: 'Slack token',
    hint: 'xox',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'github_token',
    reason: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
];

export function redactionMarker(reason: string): string {
  return `[redacted: ${reason}]`;
}

/**
 * Hito 16 — ¿por qué un `reason` de `tools.redaction.extraPatterns` no es
 * seguro? `null` si lo es. Solo cuentan como marcas las que llevan un motivo
 * canónico, así que un motivo que contenga un valor protegido (el suyo o el de
 * otra entrada) o que tenga forma de secreto del núcleo convertiría
 * `[redacted: <secreto>]`, escrito por una tool, en una marca que lo esconde.
 */
export function unsafeReasonProblem(
  reason: string,
  protectedValues: readonly string[],
): string | null {
  if (/[[\]\r\n]/.test(reason)) return 'reason cannot contain brackets or line breaks';
  const leaked = protectedValues.find((value) => value && reason.includes(value));
  if (leaked !== undefined) return 'reason cannot contain a protected value';
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    const shaped = pattern.re.test(reason);
    pattern.re.lastIndex = 0;
    if (shaped) return `reason cannot look like a secret (${pattern.reason})`;
  }
  return null;
}

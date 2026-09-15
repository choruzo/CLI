/**
 * Hito 16 — redacción de secretos en la salida de las tools (§8.2 y §11.3 de
 * `CLI-DOC/Orientacion-Infraestructura.md`).
 *
 * El texto redactado se SUSTITUYE por `[redacted: <motivo>]`, nunca se elimina:
 * si el campo desaparece, el modelo asume que estaba vacío y razona sobre una
 * premisa falsa.
 *
 * Dos capas:
 *  - el núcleo (`SECRET_PATTERNS`), que no se puede desactivar;
 *  - `tools.redaction.extraPatterns`, que solo añade. Son literales, no regex:
 *    ninguna validación estática descarta un ReDoS, y una regex patológica
 *    aplicada a cada salida de tool bloquearía el event loop entero.
 *
 * Idempotencia: el texto pasa por varias fronteras (dispatcher, loop,
 * delegación), así que ninguna capa toca el interior de una marca ya puesta.
 * Pero la salida de una tool NO es de fiar, así que:
 *  - solo es marca la que lleva un motivo EFECTIVO de esta pasada;
 *  - un motivo efectivo nunca contiene un valor protegido: si el del núcleo, el
 *    de un extra o el genérico de respaldo lo contuviese, se sustituye por otro
 *    que no colisione. Si no, con el literal protegido `API key` una tool
 *    escondería contenido escribiendo `[redacted: API key]`.
 */
import type { StratumConfig } from '../config/schema.js';
import { SECRET_PATTERNS, redactionMarker, unsafeReasonProblem } from './secrets.js';

export interface ExtraRedaction {
  value: string;
  reason: string;
}

export interface RedactionHit {
  id: string;
  count: number;
}

export interface RedactionOutcome {
  text: string;
  hits: RedactionHit[];
}

const MARKER_RE = /\[redacted: ([^\]\r\n]*)\]/g;

/** Longitud mínima de un literal extra (coincide con `tools.redaction.extraPatterns` del schema). */
const MIN_EXTRA_VALUE_LENGTH = 4;

/**
 * Motivos efectivos de una pasada: ninguno contiene un valor protegido ni tiene
 * forma de secreto. `canonical` es el conjunto de marcas que se respetan.
 */
interface ReasonTable {
  core(reason: string): string;
  extra(reason: string): string;
  canonical: ReadonlySet<string>;
}

function buildReasonTable(extras: readonly ExtraRedaction[]): ReasonTable {
  const values = extras.map((e) => e.value).filter((v) => v.length > 0);
  const containsProtected = (reason: string): boolean => values.some((v) => reason.includes(v));

  // Respaldo que no colisiona: `custom secret` y, si un valor protegido cabe en
  // él, `#1`, `#2`… Termina siempre: los valores son finitos.
  let fallback = 'custom secret';
  for (let n = 1; unsafeReasonProblem(fallback, values) !== null; n++) fallback = `#${n}`;

  const core = (reason: string): string => (containsProtected(reason) ? fallback : reason);
  const extra = (reason: string): string =>
    unsafeReasonProblem(reason, values) === null ? reason : fallback;

  const canonical = new Set<string>([fallback]);
  for (const pattern of SECRET_PATTERNS) canonical.add(core(pattern.reason));
  for (const entry of extras) canonical.add(extra(entry.reason));
  return { core, extra, canonical };
}

/** Trocea el texto en tramos normales y marcas canónicas ya aplicadas. */
function splitAroundMarkers(
  text: string,
  canonical: ReadonlySet<string>,
): Array<{ text: string; marker: boolean }> {
  const parts: Array<{ text: string; marker: boolean }> = [];
  let last = 0;
  MARKER_RE.lastIndex = 0;
  for (let m = MARKER_RE.exec(text); m; m = MARKER_RE.exec(text)) {
    if (!canonical.has(m[1] ?? '')) continue; // marca falsa: texto normal
    if (m.index > last) parts.push({ text: text.slice(last, m.index), marker: false });
    parts.push({ text: m[0], marker: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), marker: false });
  return parts;
}

/** Aplica `replace` solo a los tramos que no son marcas canónicas. */
function outsideMarkers(
  text: string,
  canonical: ReadonlySet<string>,
  replace: (segment: string) => { text: string; count: number },
): { text: string; count: number } {
  let count = 0;
  const out = splitAroundMarkers(text, canonical)
    .map((part) => {
      if (part.marker) return part.text;
      const replaced = replace(part.text);
      count += replaced.count;
      return replaced.text;
    })
    .join('');
  return { text: out, count };
}

/** Aplica el núcleo y los literales extra. Idempotente: nada toca una marca canónica. */
export function redactSecrets(
  text: string,
  allExtras: readonly ExtraRedaction[] = [],
): RedactionOutcome {
  if (!text) return { text, hits: [] };
  // Mismo mínimo que el schema (4 caracteres), también para configs hechas a
  // mano: un literal de 1–3 caracteres taparía texto corriente y haría que
  // ningún respaldo (`#1`, `#2`…) pudiese evitar contenerlo.
  const extras = allExtras.filter((e) => e.value.length >= MIN_EXTRA_VALUE_LENGTH);
  const reasons = buildReasonTable(extras);
  let out = text;
  const hits: RedactionHit[] = [];

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.hint && !out.includes(pattern.hint)) continue;
    const marker = redactionMarker(reasons.core(pattern.reason));
    const result = outsideMarkers(out, reasons.canonical, (segment) => {
      let count = 0;
      pattern.re.lastIndex = 0;
      const replaced = segment.replace(pattern.re, (...args: unknown[]) => {
        count++;
        const groups = args[args.length - 1] as Record<string, string | undefined> | undefined;
        const keep = typeof groups === 'object' && groups ? (groups.keep ?? '') : '';
        return keep + marker;
      });
      pattern.re.lastIndex = 0;
      return { text: replaced, count };
    });
    out = result.text;
    if (result.count > 0) hits.push({ id: pattern.id, count: result.count });
  }

  for (const entry of extras) {
    if (!entry.value || !out.includes(entry.value)) continue;
    const marker = redactionMarker(reasons.extra(entry.reason));
    const result = outsideMarkers(out, reasons.canonical, (segment) => {
      if (!segment.includes(entry.value)) return { text: segment, count: 0 };
      const pieces = segment.split(entry.value);
      return { text: pieces.join(marker), count: pieces.length - 1 };
    });
    out = result.text;
    if (result.count > 0) hits.push({ id: 'extra', count: result.count });
  }

  return { text: out, hits };
}

/** Atajo con los extras de la config activa. */
export function redactText(text: string, config: StratumConfig): string {
  return redactSecrets(text, config.tools?.redaction?.extraPatterns ?? []).text;
}

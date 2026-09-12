/**
 * Hito 12 — Clasificación de riesgo del cambio (P2 de `gentle-pi`). Módulo
 * puro: ni I/O ni dependencias. Dos usos:
 *
 *  1. `classifyRisk` sobre estadísticas de diff (`git diff --numstat` o el
 *     write-log acumulado de la sesión) → tier + lentes de revisión (4R).
 *  2. `ChangeTracker`, que acumula lo que el agente escribe durante la sesión
 *     y dispara UNA sola vez el aviso de «reviewer protection»: nadie revisa
 *     bien un diff de 400+ líneas, así que el usuario merece saberlo antes de
 *     que la tarea llegue ahí, no después.
 *
 * La idea de `correctionBudget` es la más aguda del original: el arreglo de un
 * review no puede ser mayor que la mitad del cambio que revisa — si lo es, no
 * es una corrección, es un cambio nuevo disfrazado.
 *
 * Ver CLI-DOC/Investigacion/gentle-pi.md §2 (P2).
 */

/** Umbral a partir del cual un cambio es demasiado grande para revisarse bien. */
export const LARGE_AUTHORED_CHANGE_LINES = 400;

/** Tope absoluto del presupuesto de corrección de un review. */
export const MAX_CORRECTION_LINES = 200;

export type RiskTier = 'low' | 'medium' | 'high';

/** Las 4 lentes (4R) con las que se mira un cambio. */
export type ReviewLens = 'risk' | 'readability' | 'reliability' | 'resilience';

export interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
  /** `git diff --numstat` marca los binarios con `-`. No cuentan como líneas autoradas. */
  binary?: boolean;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** Líneas autoradas (añadidas + borradas) tras excluir binarios y generados. */
  authoredLines: number;
  /** Ficheros contados (los excluidos no entran). */
  files: number;
  /** Lentes aplicables, de mayor a menor prioridad. `readability` siempre está. */
  lenses: ReviewLens[];
  dominantLens: ReviewLens;
  /** Motivos legibles de la clasificación (para el warning y los tests). */
  reasons: string[];
  /** `true` cuando el cambio ya cruzó el umbral de «demasiado grande para revisar». */
  oversized: boolean;
}

// ---------------------------------------------------------------------------
// Patrones de ruta (adaptados del original; nombres de segmento, no substrings)
// ---------------------------------------------------------------------------

const HIGH_RISK_TOKEN =
  /^(?:auth|authentication|authorization|update|updater|security|payments?|permissions?|shell|process|processes|secrets?|credentials?|tokens?|ssh|guards?)$/i;

const RESILIENCE_PATH =
  /(?:^|\/)(?:update|deploy|infra|ops|migrations?|rollback|recovery|providers?)(?:\/|$)/i;

const RELIABILITY_PATH = /(?:^|\/)(?:tests?|specs?|runtime|api)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i;

/**
 * Ficheros que no son trabajo autoral: goldens generados y artefactos de build.
 * Los tests normales y los fixtures NO se excluyen — escribirlos es trabajo.
 */
const GENERATED_PATH = /(?:^|\/)(?:testdata\/golden|dist|build|coverage|node_modules)(?:\/|$)/i;

const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i;

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** `true` si el fichero no cuenta como trabajo autoral (binario, generado, lockfile). */
export function isExcludedFromCount(stat: DiffFileStat): boolean {
  const path = normalize(stat.path);
  if (stat.binary) return true;
  if (GENERATED_PATH.test(path)) return true;
  if (LOCKFILE.test(path)) return true;
  return false;
}

/** Lentes que aplican a una ruta concreta. `readability` aplica siempre. */
export function lensesForPath(path: string): ReviewLens[] {
  const normalized = normalize(path);
  const out = new Set<ReviewLens>(['readability']);
  if (normalized.split('/').some((seg) => HIGH_RISK_TOKEN.test(seg.replace(/\.[^.]+$/, '')))) {
    out.add('risk');
  }
  if (RESILIENCE_PATH.test(normalized)) out.add('resilience');
  if (RELIABILITY_PATH.test(normalized)) out.add('reliability');
  return [...out];
}

const LENS_PRIORITY: ReviewLens[] = ['risk', 'resilience', 'reliability', 'readability'];

/**
 * Presupuesto de corrección de un review: la mitad del cambio original, con
 * tope duro. Un arreglo mayor que esto no es una corrección.
 */
export function correctionBudget(originalLines: number): number {
  if (originalLines <= 0) return 0;
  return Math.min(MAX_CORRECTION_LINES, Math.ceil(originalLines / 2));
}

/**
 * Clasifica el riesgo de un conjunto de cambios. Los umbrales son deliberados
 * y explícitos para poder discutirlos: `high` cuando hay rutas sensibles, el
 * cambio ya es demasiado grande para revisarse, o toca demasiados ficheros.
 */
export function classifyRisk(stats: DiffFileStat[]): RiskAssessment {
  const counted = stats.filter((s) => !isExcludedFromCount(s));
  const authoredLines = counted.reduce((acc, s) => acc + s.added + s.deleted, 0);
  const files = counted.length;

  const lensSet = new Set<ReviewLens>();
  for (const stat of counted) {
    for (const lens of lensesForPath(stat.path)) lensSet.add(lens);
  }
  if (lensSet.size === 0) lensSet.add('readability');
  const lenses = LENS_PRIORITY.filter((l) => lensSet.has(l));

  const reasons: string[] = [];
  const oversized = authoredLines >= LARGE_AUTHORED_CHANGE_LINES;

  let tier: RiskTier = 'low';
  if (lensSet.has('risk')) {
    tier = 'high';
    reasons.push('toca rutas sensibles (auth, secretos, shell, permisos)');
  }
  if (oversized) {
    tier = 'high';
    reasons.push(`${authoredLines} líneas autoradas (umbral ${LARGE_AUTHORED_CHANGE_LINES})`);
  }
  if (files >= 15) {
    tier = 'high';
    reasons.push(`${files} ficheros tocados`);
  }
  if (tier === 'low' && (authoredLines >= 100 || files >= 5 || lensSet.has('resilience'))) {
    tier = 'medium';
    if (authoredLines >= 100) reasons.push(`${authoredLines} líneas autoradas`);
    if (files >= 5) reasons.push(`${files} ficheros tocados`);
    if (lensSet.has('resilience')) reasons.push('toca rutas de despliegue/migración/providers');
  }
  if (reasons.length === 0) reasons.push('cambio pequeño y acotado');

  return {
    tier,
    authoredLines,
    files,
    lenses,
    dominantLens: lenses[0] ?? 'readability',
    reasons,
    oversized,
  };
}

/**
 * Parsea la salida de `git diff --numstat`. Los binarios llegan como `-\t-\tpath`
 * y se marcan como tales en vez de contarse como 0 líneas silenciosamente.
 */
export function parseNumstat(text: string): DiffFileStat[] {
  const out: DiffFileStat[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...rest] = parts;
    const rawPath = rest.join('\t');
    // Renombrados: `old => new` o `dir/{old => new}/file`. Nos quedamos el destino.
    const path = rawPath.includes('=>') ? resolveRenamePath(rawPath) : rawPath;
    const binary = addedRaw === '-' || deletedRaw === '-';
    out.push({
      path,
      added: binary ? 0 : Number(addedRaw) || 0,
      deleted: binary ? 0 : Number(deletedRaw) || 0,
      binary,
    });
  }
  return out;
}

function resolveRenamePath(raw: string): string {
  const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    return `${braced[1] ?? ''}${braced[3] ?? ''}${braced[4] ?? ''}`.replace(/\/{2,}/g, '/');
  }
  const parts = raw.split(' => ');
  return (parts[parts.length - 1] ?? raw).trim();
}

// ---------------------------------------------------------------------------
// ChangeTracker — acumulador de sesión
// ---------------------------------------------------------------------------

/**
 * Acumula el write-log de la sesión (write_file / edit_file) y decide cuándo
 * avisar. Vive en `StratumAgent` y no en el `ReactLoop`: el loop dura un turno
 * y el cambio se acumula a lo largo de toda la sesión.
 */
export class ChangeTracker {
  private readonly byPath = new Map<string, { added: number; deleted: number }>();
  private warnedAt = 0;

  record(path: string, added: number, deleted: number): void {
    if (!path) return;
    const key = normalize(path);
    const current = this.byPath.get(key) ?? { added: 0, deleted: 0 };
    current.added += Math.max(0, added);
    current.deleted += Math.max(0, deleted);
    this.byPath.set(key, current);
  }

  get stats(): DiffFileStat[] {
    return [...this.byPath.entries()].map(([path, s]) => ({
      path,
      added: s.added,
      deleted: s.deleted,
    }));
  }

  get authoredLines(): number {
    return classifyRisk(this.stats).authoredLines;
  }

  assess(): RiskAssessment {
    return classifyRisk(this.stats);
  }

  /**
   * Devuelve el texto del aviso la primera vez que el cambio acumulado cruza el
   * umbral, y null el resto de las veces. Vuelve a armarse cada vez que el
   * cambio DUPLICA el umbral (400 → 800 → 1200): un aviso por sesión se ignora,
   * uno por cada línea escrita es ruido.
   */
  takeLargeChangeWarning(): string | null {
    const assessment = this.assess();
    if (!assessment.oversized) return null;
    const step = Math.floor(assessment.authoredLines / LARGE_AUTHORED_CHANGE_LINES);
    if (step <= this.warnedAt) return null;
    this.warnedAt = step;
    return formatLargeChangeWarning(assessment);
  }
}

/** Texto del `warning` de protección del revisor. */
export function formatLargeChangeWarning(assessment: RiskAssessment): string {
  const budget = correctionBudget(assessment.authoredLines);
  return (
    `large_change: ${assessment.authoredLines} líneas en ${assessment.files} fichero(s) ` +
    `desde el inicio de la sesión (riesgo ${assessment.tier}, lente ${assessment.dominantLens}). ` +
    `Un diff así ya es difícil de revisar: considera cerrar lo que hay antes de seguir. ` +
    `Presupuesto de corrección si lo revisas ahora: ${budget} líneas.`
  );
}

/**
 * Extrae (best-effort) las líneas escritas por una tool mutante. `edit_file`
 * devuelve un unified diff, que es la fuente exacta; `write_file` no devuelve
 * estadísticas, así que se cuentan las líneas del contenido escrito.
 */
export function changeFromToolCall(
  name: string,
  input: Record<string, unknown>,
  output: string,
): { path: string; added: number; deleted: number } | null {
  const path = typeof input.path === 'string' ? input.path : '';
  if (!path) return null;

  if (name === 'write_file') {
    const content = typeof input.content === 'string' ? input.content : '';
    return { path, added: countLines(content), deleted: 0 };
  }

  if (name === 'edit_file') {
    const fromDiff = countDiffLines(output);
    if (fromDiff) return { path, ...fromDiff };
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    return { path, added: countLines(newStr), deleted: countLines(oldStr) };
  }

  return null;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/** Cuenta `+`/`-` de un unified diff, ignorando las cabeceras `+++`/`---`. */
function countDiffLines(output: string): { added: number; deleted: number } | null {
  let added = 0;
  let deleted = 0;
  let sawHunk = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  if (!sawHunk) return null;
  return { added, deleted };
}

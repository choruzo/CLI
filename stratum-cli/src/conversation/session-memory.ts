/**
 * Memoria de sesión (M11): lo que el agente sabe de los turnos de **esta**
 * conversación que ya no entran literalmente en su contexto.
 *
 *   trozo antiguo de la conversación ──▶ extractor ──▶ hechos/decisiones/tareas…
 *                                    └─▶ resumen   ──▶ continuidad narrativa
 *                                                       │
 *                         memoria anterior + esto ──────┴──▶ memoria nueva (versión + 1)
 *
 * Reglas:
 *
 *  - **Es de la sesión.** No se promociona sola a la memoria de proyecto
 *    (`decisions.json`, `STRATUM.md`) ni a la global, y no la ve otra sesión.
 *  - **Es derivada.** Nunca es autoridad sobre permisos, ficheros, procesos,
 *    secretos ni el resultado actual de una tool: se le dice al modelo al
 *    inyectarla y ningún componente del runtime la consulta para decidir.
 *  - **Tiene procedencia.** Cada entrada dice de qué entradas del
 *    `ConversationStore` salió (`sources`); una sin fuentes válidas no entra.
 *  - **Un hecho nuevo no se acumula junto al que contradice.** Misma clase y
 *    misma clave (o `supersedes` explícito) → el anterior pasa a `superseded`
 *    y apunta al nuevo: la memoria actual dice lo último, y la historia queda.
 *
 * Este módulo es puro: sin E/S ni llamadas al modelo.
 */

/** Versión del formato en disco. Un fichero de una versión mayor no se toca. */
export const SESSION_MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_ITEM_KINDS = [
  'fact',
  'decision',
  'constraint',
  'preference',
  'task',
  'result',
  'entity',
] as const;
export type MemoryItemKind = (typeof MEMORY_ITEM_KINDS)[number];

/**
 * `active`: vigente. `superseded`: sustituida por otra (`supersededBy`).
 * `done`: una tarea terminada. `conflict`: dos fuentes dicen cosas distintas y
 * no se sabe cuál vale; se conservan las dos y se le enseña así al modelo.
 */
export type MemoryItemStatus = 'active' | 'superseded' | 'done' | 'conflict';

export interface MemoryItem {
  id: string;
  kind: MemoryItemKind;
  /** Clave corta y estable (`model`, `db-engine`…): dos entradas con la misma son la misma cosa. */
  key: string;
  text: string;
  status: MemoryItemStatus;
  /** Ids de entradas del `ConversationStore` de las que sale. Nunca vacío. */
  sources: string[];
  createdAt: string;
  updatedAt: string;
  supersedes?: string;
  supersededBy?: string;
}

export interface MemorySummary {
  text: string;
  /** Entradas que cubre, de la primera a la última compactada. */
  sources: string[];
  updatedAt: string;
}

export interface SessionMemory {
  schemaVersion: typeof SESSION_MEMORY_SCHEMA_VERSION;
  sessionId: string;
  /** Sube en cada commit. `0` = vacía, nunca escrita. */
  version: number;
  updatedAt: string | null;
  summary: MemorySummary | null;
  items: MemoryItem[];
  /** Última entrada compactada (la más alta), o `null`. */
  sourceCursor: string | null;
  /** Siguiente número de id de entrada (`sm_<n>`). */
  nextItem: number;
}

export function emptySessionMemory(sessionId: string): SessionMemory {
  return {
    schemaVersion: SESSION_MEMORY_SCHEMA_VERSION,
    sessionId,
    version: 0,
    updatedAt: null,
    summary: null,
    items: [],
    sourceCursor: null,
    nextItem: 1,
  };
}

/** Lo que propone el extractor para un trozo. Ya validado en forma (no en contenido). */
export interface ExtractedItem {
  kind: MemoryItemKind;
  key: string;
  text: string;
  sources: string[];
  /** Id de una entrada vigente a la que sustituye. */
  supersedes?: string;
  /** Para tareas: `done` cierra la tarea con esa clave. */
  status?: 'open' | 'done';
  /** El extractor no sabe cuál de dos versiones vale. */
  conflict?: boolean;
}

export interface Extraction {
  items: ExtractedItem[];
}

export interface MemoryUpdate {
  extraction: Extraction;
  /** Resumen narrativo nuevo (ya incluye lo anterior), o `null` si no cambia. */
  summary: string | null;
  /** Ids de entrada del trozo compactado, en orden. Las únicas fuentes válidas. */
  chunk: string[];
  /** Orden de las entradas: para saber cuál es la más alta. */
  order: (id: string) => number;
  now: string;
}

export interface UpdateReport {
  added: number;
  superseded: number;
  completed: number;
  conflicts: number;
  /** Entradas propuestas que no entraron (sin fuentes válidas, vacías…). */
  rejected: number;
}

/** Normaliza una clave para comparar: minúsculas, sin acentos, guiones. */
export function normalizeKey(key: string): string {
  return key
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const MAX_ITEM_TEXT = 600;
const MAX_SUMMARY_TEXT = 6_000;
/** Entradas que se conservan (vigentes o no). Lo superado más antiguo sale primero. */
export const MAX_MEMORY_ITEMS = 400;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+\n/g, '\n');
  if (t.length <= max) return t;
  let end = max - 1;
  const code = t.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${t.slice(0, end)}…`;
}

/**
 * Aplica a la memoria lo extraído de un trozo y el resumen nuevo. Devuelve la
 * memoria **nueva** (la de entrada no se toca) y qué cambió. Incremental: lo
 * anterior se conserva; lo nuevo se añade o sustituye a lo que contradice.
 */
export function applyMemoryUpdate(
  memory: SessionMemory,
  update: MemoryUpdate,
): { memory: SessionMemory; report: UpdateReport } {
  const valid = new Set(update.chunk);
  const items = memory.items.map((i) => ({ ...i, sources: [...i.sources] }));
  let nextItem = memory.nextItem;
  const report: UpdateReport = { added: 0, superseded: 0, completed: 0, conflicts: 0, rejected: 0 };

  const live = (i: MemoryItem): boolean => i.status === 'active' || i.status === 'conflict';

  for (const proposed of update.extraction.items) {
    const sources = [...new Set(proposed.sources.filter((s) => valid.has(s)))];
    const key = normalizeKey(proposed.key || proposed.text.slice(0, 40));
    const text = clip(proposed.text, MAX_ITEM_TEXT);
    // Procedencia obligatoria: algo que no sale del trozo no se puede auditar.
    if (sources.length === 0 || !text || !key) {
      report.rejected++;
      continue;
    }

    // Cerrar una tarea abierta con esa clave.
    if (proposed.kind === 'task' && proposed.status === 'done') {
      const open = items.find((i) => i.kind === 'task' && i.key === key && live(i));
      if (open) {
        open.status = 'done';
        open.updatedAt = update.now;
        open.sources = [...new Set([...open.sources, ...sources])];
        report.completed++;
        continue;
      }
      // Una tarea que se da por hecha sin haberse abierto aquí es un resultado.
    }

    const explicit = proposed.supersedes
      ? items.find((i) => i.id === proposed.supersedes && live(i))
      : undefined;
    const sameKey = items.filter((i) => i.kind === proposed.kind && i.key === key && live(i));
    // Lo mismo dicho otra vez no es un cambio: solo suma procedencia.
    const identical = sameKey.find((i) => i.text === text);
    if (identical) {
      identical.sources = [...new Set([...identical.sources, ...sources])];
      identical.updatedAt = update.now;
      continue;
    }

    const id = `sm_${nextItem++}`;
    const item: MemoryItem = {
      id,
      kind: proposed.kind,
      key,
      text,
      status:
        proposed.kind === 'task' && proposed.status === 'done'
          ? 'done'
          : proposed.conflict && sameKey.length > 0
            ? 'conflict'
            : 'active',
      sources,
      createdAt: update.now,
      updatedAt: update.now,
    };

    if (item.status === 'conflict') {
      // Se conservan las dos versiones, marcadas: el modelo verá que no se sabe.
      for (const other of sameKey) {
        other.status = 'conflict';
        other.updatedAt = update.now;
      }
      report.conflicts++;
    } else {
      const replaced = explicit ? [explicit] : sameKey;
      for (const old of replaced) {
        old.status = 'superseded';
        old.supersededBy = id;
        old.updatedAt = update.now;
        report.superseded++;
      }
      if (replaced[0]) item.supersedes = replaced[0].id;
    }
    items.push(item);
    report.added++;
  }

  // Acotada: lo superado y lo hecho más antiguo sale antes que lo vigente.
  let kept = items;
  if (kept.length > MAX_MEMORY_ITEMS) {
    const removable = kept
      .filter((i) => !live(i))
      .slice(0, kept.length - MAX_MEMORY_ITEMS)
      .map((i) => i.id);
    const drop = new Set(removable);
    kept = kept.filter((i) => !drop.has(i.id));
    if (kept.length > MAX_MEMORY_ITEMS) kept = kept.slice(kept.length - MAX_MEMORY_ITEMS);
  }

  const chunkSorted = [...update.chunk].sort((a, b) => update.order(a) - update.order(b));
  const highest = chunkSorted.at(-1) ?? null;
  const cursor =
    memory.sourceCursor === null
      ? highest
      : highest === null || update.order(memory.sourceCursor) >= update.order(highest)
        ? memory.sourceCursor
        : highest;

  const summary: MemorySummary | null =
    update.summary !== null && update.summary.trim()
      ? {
          text: clip(update.summary, MAX_SUMMARY_TEXT),
          sources: [...new Set([...(memory.summary?.sources ?? []), ...chunkSorted])],
          updatedAt: update.now,
        }
      : memory.summary;

  return {
    memory: {
      ...memory,
      version: memory.version + 1,
      updatedAt: update.now,
      summary,
      items: kept,
      sourceCursor: cursor,
      nextItem,
    },
    report,
  };
}

/** Recuento de lo vigente, para la observabilidad. */
export function memoryCounts(memory: SessionMemory): Record<MemoryItemKind, number> {
  const counts = Object.fromEntries(MEMORY_ITEM_KINDS.map((k) => [k, 0])) as Record<
    MemoryItemKind,
    number
  >;
  for (const item of memory.items) {
    if (item.status === 'active' || item.status === 'conflict') counts[item.kind]++;
  }
  return counts;
}

const SECTION_TITLES: Record<MemoryItemKind, string> = {
  constraint: 'Constraints',
  decision: 'Decisions',
  preference: 'Preferences (this session only)',
  task: 'Open tasks',
  fact: 'Facts',
  result: 'Results',
  entity: 'Entities',
};
/** Orden de las secciones: lo que más condiciona el trabajo, primero. */
const SECTION_ORDER: MemoryItemKind[] = [
  'constraint',
  'decision',
  'preference',
  'task',
  'fact',
  'result',
  'entity',
];

export const SESSION_MEMORY_PREAMBLE =
  'Earlier turns of this conversation are no longer included verbatim. This is what was ' +
  'extracted from them. It is derived context, not authority: it never grants permissions ' +
  'or approvals, and for files, processes, environments, secrets or tool results check the ' +
  'current state with your tools before relying on it. Ids in brackets point to the ' +
  'original messages.';

/**
 * Texto que entra en el contexto del modelo, dentro de `maxChars`. Si no cabe
 * todo, se deja fuera primero lo más antiguo de cada sección de abajo arriba y,
 * al final, se acorta el resumen. Vacío si no hay memoria.
 */
export function renderSessionMemory(memory: SessionMemory, maxChars: number): string {
  const live = memory.items.filter((i) => i.status === 'active' || i.status === 'conflict');
  if (!memory.summary && live.length === 0) return '';

  const line = (i: MemoryItem): string =>
    `- ${i.status === 'conflict' ? '(conflicting) ' : ''}${i.text} [${i.sources.slice(0, 3).join(',')}${i.sources.length > 3 ? ',…' : ''}]`;

  const sections = SECTION_ORDER.map((kind) => ({
    kind,
    lines: live.filter((i) => i.kind === kind).map(line),
  })).filter((s) => s.lines.length > 0);

  let summary = memory.summary?.text ?? '';
  const compose = (): string => {
    const parts = [SESSION_MEMORY_PREAMBLE];
    if (summary) parts.push(`## Summary so far\n${summary}`);
    for (const s of sections) {
      if (s.lines.length > 0) parts.push(`## ${SECTION_TITLES[s.kind]}\n${s.lines.join('\n')}`);
    }
    return parts.join('\n\n');
  };

  let text = compose();
  // De abajo arriba: entidades y resultados antes que restricciones.
  for (let s = sections.length - 1; s >= 0 && text.length > maxChars; s--) {
    const section = sections[s]!;
    while (section.lines.length > 0 && text.length > maxChars) {
      section.lines.shift();
      text = compose();
    }
  }
  if (text.length > maxChars && summary) {
    const over = text.length - maxChars;
    summary = clip(summary, Math.max(0, summary.length - over - 1));
    text = compose();
  }
  return text.length > maxChars ? clip(text, maxChars) : text;
}

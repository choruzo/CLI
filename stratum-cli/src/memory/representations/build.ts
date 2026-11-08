/**
 * M19 fase 4 — representaciones: páginas con enlaces **derivadas** de
 * `decisions.json`. Nunca son fuente de verdad (lo es `decisions.json`) ni
 * entran solas en el prompt: son una vista legible y navegable de lo que se
 * recuerda, regenerable en cualquier momento. Módulo puro, determinista y sin
 * modelo: mismas notas, mismas páginas (sin relojes ni azar).
 *
 * Solo para memorias con secciones (`assistant`, `companion`); `coding` no
 * tiene taxonomía de personas/proyectos/temas.
 *
 * Los enlaces salen de dos cosas comprobables, no de una inferencia:
 *  - una nota **menciona** a otra si el título de la otra (≥ 3 letras) aparece
 *    en su título o contenido;
 *  - dos notas **comparten** una etiqueta.
 */
import {
  MEMORY_SECTIONS,
  presentedType,
  summaryOf,
  type DecisionRecord,
  type MemorySection,
} from '../decisions.js';

/** Marca de toda página generada: solo se reescribe o se borra lo que la lleva. */
export const GENERATED_MARK =
  '<!-- stratum:generated — derived from decisions.json, do not edit -->';

export const INDEX_PAGE = 'index.md';
export const PROFILE_PAGE = 'profile.md';

const SECTION_LABELS: Record<MemorySection, string> = {
  profile: 'You',
  person: 'People',
  project: 'Projects',
  topic: 'Topics',
  area: 'Areas',
};

const MIN_MENTION_CHARS = 3;
const MAX_RELATED = 12;

export interface WikiPage {
  /** Nombre de fichero (`ana-lopez.md`). */
  file: string;
  content: string;
}

function slugOf(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'note';
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Una línea de texto plano apta para un enlace o un título de markdown. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function mentions(haystack: string, title: string): boolean {
  const t = oneLine(title);
  if (t.length < MIN_MENTION_CHARS) return false;
  // Límite de palabra con letras Unicode: «Ana» no casa dentro de «banana».
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

interface Entry {
  note: DecisionRecord;
  section: MemorySection;
  file: string;
}

/** Nombres de fichero estables: el orden de notas es por id, así que no dependen del orden de entrada. */
function assignFiles(notes: readonly DecisionRecord[]): Entry[] {
  const sorted = [...notes].sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>([INDEX_PAGE, PROFILE_PAGE]);
  return sorted.map((note) => {
    const section = presentedType(note.type, 'sections') as MemorySection;
    let slug = slugOf(note.title);
    let file = `${slug}.md`;
    if (used.has(file)) {
      slug = `${slug}-${
        note.id
          .replace(/[^a-z0-9]/gi, '')
          .slice(-6)
          .toLowerCase() || 'x'
      }`;
      file = `${slug}.md`;
    }
    used.add(file);
    return { note, section, file };
  });
}

function link(entry: Entry): string {
  return `[${oneLine(entry.note.title)}](${entry.file})`;
}

function noteBlock(entry: Entry): string[] {
  const { note } = entry;
  const lines = [`### ${oneLine(note.title)}`, '', summaryOf(note), ''];
  const body = note.content.trim();
  if (body && body !== summaryOf(note)) lines.push(body, '');
  return lines;
}

function relatedOf(entry: Entry, all: readonly Entry[]): { mentions: Entry[]; shared: Entry[] } {
  const text = `${entry.note.title}\n${entry.note.content}`;
  const out: Entry[] = [];
  const shared: Entry[] = [];
  for (const other of all) {
    if (other.note.id === entry.note.id) continue;
    if (mentions(text, other.note.title)) {
      out.push(other);
    } else if (entry.note.tags.some((tag) => other.note.tags.includes(tag))) {
      shared.push(other);
    }
  }
  return { mentions: out.slice(0, MAX_RELATED), shared: shared.slice(0, MAX_RELATED) };
}

function backlinksOf(entry: Entry, all: readonly Entry[]): Entry[] {
  return all
    .filter(
      (other) =>
        other.note.id !== entry.note.id &&
        mentions(`${other.note.title}\n${other.note.content}`, entry.note.title),
    )
    .slice(0, MAX_RELATED);
}

function list(label: string, entries: readonly Entry[]): string[] {
  if (entries.length === 0) return [];
  return [`## ${label}`, '', ...entries.map((e) => `- ${link(e)}`), ''];
}

/**
 * Las páginas de una memoria con secciones: `index.md`, `profile.md` (todo lo
 * de «Tú») y una página por persona, proyecto, tema o área.
 */
export function buildPages(notes: readonly DecisionRecord[]): WikiPage[] {
  const entries = assignFiles(notes);
  const pages: WikiPage[] = [];

  const profile = entries.filter((e) => e.section === 'profile');
  const entities = entries.filter((e) => e.section !== 'profile');

  for (const entry of entities) {
    const rel = relatedOf(entry, entities);
    const lines = [
      GENERATED_MARK,
      '',
      `# ${oneLine(entry.note.title)}`,
      '',
      `Section: ${SECTION_LABELS[entry.section]} · updated ${entry.note.updatedAt ?? entry.note.timestamp}`,
      '',
      summaryOf(entry.note),
      '',
    ];
    const body = entry.note.content.trim();
    if (body && body !== summaryOf(entry.note)) lines.push(body, '');
    if (entry.note.tags.length > 0) {
      lines.push(`Tags: ${entry.note.tags.map(oneLine).join(', ')}`, '');
    }
    lines.push(
      ...list('Mentions', rel.mentions),
      ...list('Mentioned by', backlinksOf(entry, entities)),
      ...list('Shares tags with', rel.shared),
      '[Index](index.md)',
      '',
    );
    pages.push({ file: entry.file, content: lines.join('\n') });
  }

  const profileLines = [GENERATED_MARK, '', '# You', ''];
  if (profile.length === 0) profileLines.push('Nothing remembered yet.', '');
  for (const entry of profile) profileLines.push(...noteBlock(entry));
  profileLines.push('[Index](index.md)', '');
  pages.push({ file: PROFILE_PAGE, content: profileLines.join('\n') });

  const index = [GENERATED_MARK, '', '# Memory', ''];
  index.push(`- [${SECTION_LABELS.profile}](${PROFILE_PAGE}) — ${profile.length}`, '');
  for (const section of MEMORY_SECTIONS) {
    if (section === 'profile') continue;
    const inSection = entities.filter((e) => e.section === section);
    if (inSection.length === 0) continue;
    index.push(`## ${SECTION_LABELS[section]}`, '');
    for (const entry of inSection)
      index.push(`- ${link(entry)} — ${oneLine(summaryOf(entry.note))}`);
    index.push('');
  }
  pages.push({ file: INDEX_PAGE, content: index.join('\n') });

  return pages.sort((a, b) => a.file.localeCompare(b.file));
}

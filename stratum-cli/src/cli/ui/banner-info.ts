/**
 * Textos de la pantalla de bienvenida de `chat`: en vez de consejos de uso
 * (`stratum chat` cuando ya estás dentro), lo que sirve para empezar: con qué
 * modelo, en qué carpeta y qué sesiones recientes se pueden reanudar. Puro.
 */

/** Lo que hace falta de una sesión guardada. */
export interface SavedSessionLike {
  id: string;
  updatedAt: string;
  summary?: string;
  messages?: ReadonlyArray<{ role: string; content?: unknown }>;
}

export interface RecentSessionRow {
  id: string;
  when: string;
  title: string;
}

/** `ahora`, `hace 5 min`, `hace 3 h`, `ayer`, `hace 4 días`, o la fecha. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d} días`;
  return new Date(t).toLocaleDateString();
}

function firstUserText(messages: SavedSessionLike['messages']): string {
  for (const m of messages ?? []) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p: unknown) =>
          p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
        )
        .join(' ');
      if (text.trim()) return text;
    }
  }
  return '';
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Las sesiones recientes que se pueden reanudar, sin la actual y sin las
 * vacías. Título: el resumen si lo hay; si no, el primer mensaje del usuario.
 */
export function recentSessionRows(
  sessions: readonly SavedSessionLike[],
  currentId: string | undefined,
  now: number,
  limit = 3,
): RecentSessionRow[] {
  const rows: RecentSessionRow[] = [];
  for (const s of sessions) {
    if (s.id === currentId) continue;
    const title = oneLine(s.summary || firstUserText(s.messages), 48);
    if (!title) continue;
    rows.push({ id: s.id, when: relativeTime(s.updatedAt, now), title });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** La carpeta acortada por la izquierda para que quepa: `…\Proyectos\CLI`. */
export function shortPath(path: string, max: number): string {
  if (path.length <= max) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep);
  let out = parts[parts.length - 1] ?? path;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}${sep}${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…${sep}${out}`;
}

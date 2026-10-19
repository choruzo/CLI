/**
 * La lista de sesiones, derivada de la foto de conjunto (estado operativo: sin
 * descargar la conversación de ninguna). Pura.
 *
 * Desktop ve **todas** las sesiones del daemon —las suyas, las de Dot, las de
 * la terminal—: es un cliente hermano. Verlas no da control: lo que se puede
 * hacer con cada una lo dice el daemon (capacidades) y quien la aloja.
 */
import type { ClientKind, ProtocolOverviewSnapshot, ProtocolSession } from '../protocol';

export interface SessionItem {
  id: string;
  title: string;
  state: ProtocolSession['state'];
  agent: string;
  model: string;
  cwd: string;
  /** Desde qué cliente se inició (solo procedencia). */
  origin: ClientKind | null;
  /** La aloja una terminal (par) y no el daemon. */
  peer: boolean;
  /** Algo de ella espera a una persona (aprobación, preguntas, plan). */
  waiting: number;
  running: boolean;
  updatedAt: number;
}

export const ORIGIN_LABEL: Record<ClientKind, string> = {
  cli: 'terminal',
  dot: 'Dot',
  desktop: 'Desktop',
  daemon: 'daemon',
  other: 'otro cliente',
};

export function sessionTitle(session: Pick<ProtocolSession, 'title'>): string {
  return session.title.trim() || 'Conversación nueva';
}

export function sessionItems(overview: ProtocolOverviewSnapshot): SessionItem[] {
  const waiting = new Map<string, number>();
  for (const req of [...overview.approvals, ...overview.questions, ...overview.plans]) {
    waiting.set(req.sessionId, (waiting.get(req.sessionId) ?? 0) + 1);
  }
  return overview.sessions
    .filter((s) => s.state !== 'closed')
    .map((s) => ({
      id: s.id,
      title: sessionTitle(s),
      state: s.state,
      agent: s.agent,
      model: s.model,
      cwd: s.cwd,
      origin: s.origin ?? null,
      peer: s.host.kind === 'peer',
      waiting: waiting.get(s.id) ?? 0,
      running: s.currentRunId !== null,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** «assistant · Desktop · terminal…»: qué es y de dónde vino, para la lista. */
export function describeSession(item: SessionItem): string {
  const parts: string[] = [];
  if (item.agent !== 'assistant') parts.push(item.agent === 'general' ? 'código' : item.agent);
  if (item.origin && item.origin !== 'desktop') parts.push(`desde ${ORIGIN_LABEL[item.origin]}`);
  if (item.peer) parts.push('en su terminal');
  if (item.state === 'paused') parts.push('en pausa');
  if (item.state === 'detached') parts.push('sin anfitrión');
  return parts.join(' · ');
}

export type DateGroup = 'Hoy' | 'Ayer' | 'Últimos 7 días' | 'Anteriores';

/** Grupo de fecha del sidebar (§7.1). Los vacíos no se pintan. */
export function dateGroup(at: number, now: Date): DateGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (at >= startOfToday) return 'Hoy';
  if (at >= startOfToday - day) return 'Ayer';
  if (at >= startOfToday - 6 * day) return 'Últimos 7 días';
  return 'Anteriores';
}

export function groupByDate<T extends { updatedAt: number }>(
  list: readonly T[],
  now: Date,
): { group: DateGroup; items: T[] }[] {
  const order: DateGroup[] = ['Hoy', 'Ayer', 'Últimos 7 días', 'Anteriores'];
  const groups = new Map<DateGroup, T[]>();
  for (const item of list) {
    const g = dateGroup(item.updatedAt, now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  return order.flatMap((group) => {
    const items = groups.get(group);
    return items?.length ? [{ group, items }] : [];
  });
}

/** Filtro de la búsqueda del sidebar: subcadena del título, sin mayúsculas ni tildes. */
export function matchesSearch(title: string, query: string): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  return norm(title).includes(norm(query.trim()));
}

/** «hace 5 min», «hace 2 h», «12 mar», «3 feb 2025» (§7.1). */
export function relativeDate(at: number, now: Date): string {
  const diff = now.getTime() - at;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24 && dateGroup(at, now) === 'Hoy') return `hace ${h} h`;
  const d = new Date(at);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('es', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

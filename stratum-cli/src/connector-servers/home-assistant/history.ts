/**
 * Historial de Home Assistant (`ha_historial`, M22 parte 4): lee
 * `/api/history/period` y lo resume para un agente en cambios de estado con su
 * hora, tiempo en cada estado y, en un sensor numérico, mínimo y máximo. Nunca
 * JSON crudo; lo desconocido es «sin dato», nunca 0.
 */
import { isRecord } from './client.js';
import { localTime, stateText } from './format.js';

/** Un punto del historial: el estado y desde cuándo (ms). */
export interface HistoryPoint {
  state: string;
  at: number;
}

export interface EntityHistory {
  entityId: string;
  name: string | null;
  unit: string | null;
  points: HistoryPoint[];
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
/** Estados que no son un valor: no entran en mínimo ni máximo. */
const NOT_A_VALUE = new Set(['unavailable', 'unknown', '']);

/**
 * Lee la respuesta de `/api/history/period` con `minimal_response`: una lista
 * por entidad; el primer elemento trae `entity_id` y atributos, los siguientes
 * solo `state` y `last_changed`. Lo que no tenga esa forma se ignora.
 */
export function parseHistory(data: unknown): Map<string, EntityHistory> {
  const out = new Map<string, EntityHistory>();
  if (!Array.isArray(data)) return out;
  for (const series of data) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const first: unknown = series[0];
    if (!isRecord(first) || typeof first.entity_id !== 'string') continue;
    const attrs = isRecord(first.attributes) ? first.attributes : {};
    const name =
      typeof attrs.friendly_name === 'string' && attrs.friendly_name !== ''
        ? attrs.friendly_name
        : null;
    const unit =
      typeof attrs.unit_of_measurement === 'string' && attrs.unit_of_measurement !== ''
        ? attrs.unit_of_measurement
        : null;
    const points: HistoryPoint[] = [];
    for (const p of series) {
      if (!isRecord(p)) continue;
      const when = typeof p.last_changed === 'string' ? Date.parse(p.last_changed) : NaN;
      if (!Number.isFinite(when)) continue;
      const state = typeof p.state === 'string' ? p.state : String(p.state ?? '');
      points.push({ state, at: when });
    }
    points.sort((a, b) => a.at - b.at);
    // Dos puntos seguidos con el mismo estado no son un cambio.
    const changes = points.filter((p, i) => i === 0 || p.state !== points[i - 1]!.state);
    const prev = out.get(first.entity_id);
    if (prev) prev.points.push(...changes);
    else out.set(first.entity_id, { entityId: first.entity_id, name, unit, points: changes });
  }
  return out;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** Minutos que la zona va por delante de UTC en ese instante. */
function offsetMinutes(tz: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const n = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? '0');
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  return Math.round((wall - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

function validZone(tz: string | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * `AAAA-MM-DD` o `AAAA-MM-DDTHH:MM` en la hora de la casa (la zona de Home
 * Assistant; sin zona válida, UTC, y así lo dicen las horas de la salida) → ms.
 * Una fecha sola es su 00:00, o la del día siguiente con `endOfDay` (el día
 * entero queda dentro). `null` si no es una fecha y hora reales.
 */
export function localToInstant(value: string, tz: string | null, endOfDay = false): number | null {
  const m = LOCAL_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  const [h, mi] = hasTime ? [Number(m[4]), Number(m[5])] : [0, 0];
  if (h > 23 || mi > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  const wall = Date.UTC(y, mo - 1, d + (!hasTime && endOfDay ? 1 : 0), h, mi);
  const zone = validZone(tz);
  if (!zone) return wall;
  // Dos pasadas: la segunda corrige si la primera cruzó un cambio de hora.
  let t = wall - offsetMinutes(zone, wall) * 60_000;
  t = wall - offsetMinutes(zone, t) * 60_000;
  return t;
}

/** `3 d 4 h`, `2 h 05 min`, `12 min`, `menos de 1 min`. */
export function durationText(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'menos de 1 min';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}

/** El estado como lo enseña el resto del conector (`no disponible`, `21.5 °C`). */
function show(state: string, unit: string | null): string {
  return stateText({
    entity_id: '',
    state,
    attributes: unit ? { unit_of_measurement: unit } : {},
    last_changed: null,
  });
}

/** Cambios que se enseñan como mucho de un sensor numérico: lo demás lo dicen mínimo y máximo. */
const MAX_NUMERIC_CHANGES = 10;
const HOUR = 3_600_000;

export interface DescribeOptions {
  start: number;
  end: number;
  /** «las últimas 24 h» o «entre 18 nov 12:00 y 19 nov 12:00». */
  label: string;
  /** El periodo acaba ahora: el último estado es el actual. */
  toNow: boolean;
  tz: string | null;
  /** Cuántos cambios se enseñan como mucho (los más recientes). */
  maxChanges: number;
}

/** El bloque de texto de una entidad. */
export function describeHistory(h: EntityHistory, o: DescribeOptions): string {
  const when = (ms: number): string => localTime(new Date(ms).toISOString(), o.tz);
  /** `15 nov`: el día local, sacado del mismo formato que las horas. */
  const dayOf = (ms: number): string => when(ms).split(' ').slice(0, 2).join(' ');
  const title = `${h.entityId} — ${h.name ?? h.entityId}`;
  // El estado de partida puede venir con la hora de inicio del periodo o con
  // una anterior; los cambios son los que caen dentro.
  const inside = h.points.filter((p) => p.at > o.start && p.at <= o.end);
  const before = h.points.filter((p) => p.at <= o.start);
  const initial = before.at(-1) ?? null;
  if (!initial && inside.length === 0) {
    return `${title}\nSin datos en ${o.label}.`;
  }

  // Tramos: [desde, hasta) con su estado, recortados al periodo.
  const timeline: HistoryPoint[] = [
    ...(initial ? [{ state: initial.state, at: o.start }] : []),
    ...inside,
  ];
  const segments = timeline.map((p, i) => ({
    state: p.state,
    from: p.at,
    to: timeline[i + 1]?.at ?? o.end,
  }));
  const perState = new Map<string, number>();
  for (const g of segments) {
    perState.set(g.state, (perState.get(g.state) ?? 0) + Math.max(0, g.to - g.from));
  }

  const lines = [title];
  const covered = initial ? o.label : `${o.label} (sin dato antes de ${when(timeline[0]!.at)})`;
  lines.push(
    `${inside.length === 0 ? 'Sin cambios' : `${inside.length} ${inside.length === 1 ? 'cambio' : 'cambios'}`} en ${covered}.`,
  );
  if (initial) lines.push(`Al empezar (${when(o.start)}): ${show(initial.state, h.unit)}`);

  const values = segments.filter((g) => !NOT_A_VALUE.has(g.state));
  const numeric = values.length > 0 && values.every((g) => NUMBER_RE.test(g.state));
  if (numeric) {
    let min = values[0]!;
    let max = values[0]!;
    for (const g of values) {
      if (Number(g.state) < Number(min.state)) min = g;
      if (Number(g.state) > Number(max.state)) max = g;
    }
    lines.push(
      `Mínimo: ${show(min.state, h.unit)} (${when(min.from)}) · máximo: ${show(max.state, h.unit)} (${when(max.from)})`,
    );
    if (o.end - o.start > 24 * HOUR) {
      // Mínimo y máximo de cada día local; un valor que viene del día anterior
      // también cuenta en los días que cubre.
      const days = new Map<string, { min: string; max: string }>();
      for (const g of values) {
        const keys = new Set<string>();
        for (let t = g.from; t < g.to; t += HOUR) keys.add(dayOf(t));
        keys.add(dayOf(Math.max(g.from, g.to - 1)));
        for (const k of keys) {
          const d = days.get(k);
          if (!d) days.set(k, { min: g.state, max: g.state });
          else {
            if (Number(g.state) < Number(d.min)) d.min = g.state;
            if (Number(g.state) > Number(d.max)) d.max = g.state;
          }
        }
      }
      lines.push('Por día (mínimo – máximo):');
      for (const [k, d] of days) {
        const range = d.min === d.max ? d.min : `${d.min} – ${d.max}`;
        lines.push(`· ${k}: ${h.unit ? `${range} ${h.unit}` : range}`);
      }
    }
    const gaps = [...perState.entries()].filter(([st]) => NOT_A_VALUE.has(st));
    for (const [st, ms] of gaps) lines.push(`${show(st, h.unit)} durante ${durationText(ms)}`);
  } else {
    const ranked = [...perState.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(
      `Tiempo en cada estado: ${ranked.map(([st, ms]) => `${show(st, h.unit)} ${durationText(ms)}`).join(' · ')}`,
    );
  }

  // Home Assistant da el estado de partida con la hora de inicio del periodo,
  // no con la suya: sin cambios dentro, solo se sabe que viene de antes.
  const last = timeline.at(-1)!;
  const since =
    inside.length > 0
      ? `desde ${when(last.at)}`
      : initial!.at < o.start
        ? `desde ${when(initial!.at)}`
        : `desde antes de ${when(o.start)}`;
  lines.push(
    o.toNow
      ? `Ahora: ${show(last.state, h.unit)} (${since})`
      : `Al acabar (${when(o.end)}): ${show(last.state, h.unit)} (${since})`,
  );

  if (inside.length > 0) {
    const cap = numeric ? Math.min(o.maxChanges, MAX_NUMERIC_CHANGES) : o.maxChanges;
    const shown = inside.slice(-cap);
    const hidden = inside.length - shown.length;
    lines.push(`Cambios${hidden > 0 ? ` (los ${shown.length} últimos)` : ''}:`);
    if (hidden > 0) {
      lines.push(
        `… ${hidden} anteriores omitidos: para verlos, pide un periodo más corto con desde y hasta.`,
      );
    }
    for (const p of shown) lines.push(`· ${when(p.at)} → ${show(p.state, h.unit)}`);
  }
  return lines.join('\n');
}

/**
 * Lógica pura de horarios, sin base de datos ni reloj propio: el servicio por
 * frecuencia (EMT, y Metro si vuelve a tener horario vigente) y los textos de
 * tiempo. Un servicio por frecuencia no tiene horas exactas: dice cada cuánto
 * pasa en una ventana, y nunca se inventa una hora de paso.
 */
import { hhmm } from '../renfe/time.js';
import type { FreqWindow } from './queries.js';

/** Una ventana ya en segundos de «hoy», en la parada consultada. */
export interface Win {
  start: number;
  end: number;
  headway: number;
  ride: number | null;
}

export interface FreqGroup {
  routeId: string;
  direction: number;
  headsign: string;
  windows: Win[];
}

export type FreqState =
  | { kind: 'now'; headway: number; until: number; ride: number | null }
  | { kind: 'later'; first: number; headway: number; ride: number | null }
  | { kind: 'over' };

/** Dos ventanas seguidas (`7:59:59` y `8:00:00`) cuentan como una si su frecuencia es la misma. */
const CONTIGUOUS_GAP = 60;

/**
 * Agrupa las ventanas por línea, sentido y destino. `shift` pasa cada tanda de
 * ventanas a segundos de «hoy» (0 para hoy, −86400 para las de ayer). Las
 * ventanas repetidas (la EMT trae una plantilla por autobús) cuentan una vez.
 */
export function groupWindows(
  batches: Array<{ shift: number; windows: FreqWindow[] }>,
): FreqGroup[] {
  const groups = new Map<string, FreqGroup>();
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const w of batch.windows) {
      const start = w.start + batch.shift;
      const end = w.end + batch.shift;
      if (end < 0) continue;
      const key = `${w.routeId}|${w.direction}|${w.headsign}`;
      const dedupe = `${key}|${start}|${end}|${w.headway}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      let g = groups.get(key);
      if (!g) {
        g = { routeId: w.routeId, direction: w.direction, headsign: w.headsign, windows: [] };
        groups.set(key, g);
      }
      g.windows.push({ start, end, headway: w.headway, ride: w.ride });
    }
  }
  for (const g of groups.values()) g.windows = mergeWindows(g.windows);
  return [...groups.values()];
}

export function mergeWindows(windows: Win[]): Win[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.headway - b.headway);
  const out: Win[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && last.headway === w.headway && w.start <= last.end + CONTIGUOUS_GAP) {
      last.end = Math.max(last.end, w.end);
      if (last.ride === null) last.ride = w.ride;
    } else out.push({ ...w });
  }
  return out;
}

/** Qué pasa con un grupo a las `now` segundos de hoy. */
export function freqState(windows: Win[], now: number): FreqState {
  const current = windows
    .filter((w) => w.start <= now && now <= w.end)
    .sort((a, b) => a.headway - b.headway)[0];
  if (current) {
    return { kind: 'now', headway: current.headway, until: current.end, ride: current.ride };
  }
  const next = windows.filter((w) => w.start > now).sort((a, b) => a.start - b.start)[0];
  if (next) return { kind: 'later', first: next.start, headway: next.headway, ride: next.ride };
  return { kind: 'over' };
}

/** `cada 8 min`, `cada 7,5 min`, `cada 45 s`. */
export function headwayText(headwaySecs: number): string {
  if (headwaySecs < 60) return `cada ${headwaySecs} s`;
  const m = Math.round((headwaySecs / 60) * 10) / 10;
  return `cada ${String(m).replace('.', ',')} min`;
}

/** `unos 12 min de viaje` (nunca 0: un viaje dura al menos 1 min). */
export function rideText(rideSecs: number): string {
  return `unos ${Math.max(1, Math.round(rideSecs / 60))} min de viaje`;
}

/** `en 6 min` / `ahora` / `null` si ya pasó. */
export function minutesUntil(targetSecs: number, nowSecs: number): string | null {
  const m = Math.round((targetSecs - nowSecs) / 60);
  if (m < 0) return null;
  return m === 0 ? 'ahora' : `en ${m} min`;
}

/** Hora al minuto más cercano (una ventana acaba en `7:59:59`: es hasta las 08:00). */
function nearestMinute(secs: number): string {
  return hhmm(Math.round(secs / 60) * 60);
}

/** ¿Cae esta hora del día de servicio en el día siguiente de calendario? (pasadas las 24:00) */
function isTomorrow(secs: number): boolean {
  return Math.round(secs / 60) * 60 >= 86400;
}

/** Texto de un estado de frecuencia, sin la línea ni el destino. */
export function freqStateText(state: FreqState): string {
  switch (state.kind) {
    case 'now':
      return `${headwayText(state.headway)} (hasta ${
        isTomorrow(state.until) ? 'mañana a las' : 'las'
      } ${nearestMinute(state.until)})`;
    case 'later':
      return `primera pasada ${
        isTomorrow(state.first) ? 'mañana ' : ''
      }hacia las ${nearestMinute(state.first)}, después ${headwayText(state.headway)}`;
    case 'over':
      return 'sin servicio hasta mañana';
  }
}

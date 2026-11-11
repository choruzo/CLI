/**
 * Hora de Renfe: todo en `Europe/Madrid`, calculado con `Intl` (nunca con la zona
 * del proceso: en la caja es UTC). Un «día de servicio» GTFS puede pasar de las
 * 24:00:00, así que las horas se manejan como segundos desde la medianoche de
 * ese día de servicio.
 */

const TZ = 'Europe/Madrid';

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface MadridParts {
  /** `YYYYMMDD`. */
  ymd: string;
  /** Segundos desde la medianoche local. */
  secs: number;
}

function wall(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

export function madridParts(date: Date): MadridParts {
  const w = wall(date.getTime());
  const ymd = `${w.y}${String(w.mo).padStart(2, '0')}${String(w.d).padStart(2, '0')}`;
  return { ymd, secs: w.h * 3600 + w.mi * 60 + w.s };
}

/** Desfase de Madrid respecto a UTC en el instante dado (ms). */
function offsetMs(instant: number): number {
  const w = wall(instant);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000;
}

function ymdParts(ymd: string): [number, number, number] {
  return [Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)), Number(ymd.slice(6, 8))];
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymdParts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 0 = lunes … 6 = domingo (el orden de las columnas de `calendar.txt`). */
export function weekdayIndex(ymd: string): number {
  const [y, m, d] = ymdParts(ymd);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Instante (ms epoch) de `secs` segundos tras la medianoche de Madrid del día `ymd`. */
export function madridEpochMs(ymd: string, secs: number): number {
  const [y, m, d] = ymdParts(ymd);
  const guess = Date.UTC(y, m - 1, d) + secs * 1000;
  return guess - offsetMs(guess - offsetMs(guess));
}

/** `HH:MM` de unos segundos de día de servicio (pasadas las 24:00 vuelve a empezar). */
export function hhmm(secs: number): string {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** `HH:MM` de Madrid de un instante en segundos epoch. */
export function hhmmOfEpoch(epochSec: number): string {
  return hhmm(madridParts(new Date(epochSec * 1000)).secs);
}

/** `11/11/2026` desde `20261111`. */
export function dateEs(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

/** `HH:MM` o `HH:MM:SS` → segundos, o `null` si no es una hora. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

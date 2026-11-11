/** Formato "masticado" en español: números con coma, fechas locales, rumbos. Un `null` es `sin dato`, nunca 0. */

export const NO_DATA = 'sin dato';

/** Decimal con coma y un decimal (temperatura, mm). */
export function dec1(n: number | null): string {
  return n === null ? NO_DATA : n.toFixed(1).replace('.', ',');
}

/** Entero redondeado (%, km/h, grados de rango diario). */
export function int(n: number | null): string {
  return n === null ? NO_DATA : String(Math.round(n));
}

/** `valor unidad`, o `sin dato` sin unidad cuando falta el valor. */
export function withUnit(text: string, unit: string): string {
  return text === NO_DATA ? NO_DATA : `${text} ${unit}`;
}

const DIRECTIONS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

/** Grados (de dónde sopla) → rumbo en 8 sectores. */
export function windDirection(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return DIRECTIONS[idx]!;
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Parte de una fecha local `YYYY-MM-DD…`; no depende de la zona horaria del proceso. */
function dateParts(iso: string): { wd: string; day: number; month: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { wd: WEEKDAYS[wd]!, day: d, month: MONTHS[mo - 1] ?? '' };
}

/** `mié 12 nov` */
export function dayLabel(iso: string): string {
  const p = dateParts(iso);
  return p ? `${p.wd} ${p.day} ${p.month}` : iso;
}

/** `mié 21:00` a partir de `YYYY-MM-DDTHH:MM`. */
export function hourLabel(iso: string): string {
  const p = dateParts(iso);
  const hm = iso.slice(11, 16);
  return p ? `${p.wd} ${hm}` : iso;
}

/** `HH:MM` de un `YYYY-MM-DDTHH:MM` (o `sin dato`). */
export function clock(iso: string | null): string {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : NO_DATA;
}

/** Quita acentos, pasa a minúsculas y colapsa espacios. */
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

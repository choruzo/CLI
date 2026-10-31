import { describe, expect, it } from 'vitest';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  nextFire,
  parseSchedule,
  type Schedule,
} from './schedule.js';

// Fechas en hora local para no depender de la zona.
const d = (y: number, m: number, day: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, day, h, min, s, ms);

function parse(text: string): Schedule {
  const r = parseSchedule(text);
  if (!r.ok) throw new Error(r.error);
  return r.schedule;
}

function next(text: string, from: Date, anchor = d(2020, 1, 1)): Date | null {
  return nextFire(parse(text), from, anchor);
}

describe('parseSchedule: intervalos', () => {
  it('acepta m, h y d y guarda el texto recortado', () => {
    expect(parse(' 30m ')).toEqual({ kind: 'interval', text: '30m', everyMs: 30 * 60_000 });
    expect(parse('2h')).toMatchObject({ everyMs: 2 * 3_600_000 });
    expect(parse('1d')).toMatchObject({ everyMs: 86_400_000 });
    expect(parse('1m')).toMatchObject({ everyMs: MIN_INTERVAL_MS });
    expect(parse('366d')).toMatchObject({ everyMs: MAX_INTERVAL_MS });
  });

  it.each(['0m', '59s', '400d', '1.5h', '', '   ', '-5m', 'abc'])('rechaza %j', (t) => {
    const r = parseSchedule(t);
    expect(r.ok).toBe(false);
  });

  it('el error de formato dice qué formatos valen', () => {
    const r = parseSchedule('59s');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/30m.*cron/s);
  });
});

describe('nextFire: intervalos', () => {
  const anchor = d(2026, 1, 1, 10, 0);

  it('si from < anchor, la primera es anchor + every', () => {
    const s = parse('1h');
    expect(nextFire(s, d(2025, 6, 1), anchor)).toEqual(d(2026, 1, 1, 11, 0));
  });

  it('estrictamente posterior: from en una ocurrencia da la siguiente', () => {
    const s = parse('1h');
    expect(nextFire(s, d(2026, 1, 1, 11, 0), anchor)).toEqual(d(2026, 1, 1, 12, 0));
    expect(nextFire(s, anchor, anchor)).toEqual(d(2026, 1, 1, 11, 0));
  });

  it('salta los vencimientos perdidos y queda alineado con el anchor', () => {
    const s = parse('1h');
    // 3 días y 20 minutos después: la siguiente alineada es a las :00, no from + 1h.
    const from = d(2026, 1, 4, 10, 20);
    expect(nextFire(s, from, anchor)).toEqual(d(2026, 1, 4, 11, 0));
  });

  it('un intervalo de 30m alineado con un anchor no redondo', () => {
    const s = parse('30m');
    const a = d(2026, 1, 1, 10, 7);
    // 10:07 + 30m = 10:37 y 11:07: desde 10:40 la siguiente es 11:07.
    expect(nextFire(s, d(2026, 1, 1, 10, 40), a)).toEqual(d(2026, 1, 1, 11, 7));
    expect(nextFire(s, d(2026, 1, 1, 10, 30), a)).toEqual(d(2026, 1, 1, 10, 37));
  });
});

describe('parseSchedule: cron', () => {
  it('normaliza listas, rangos, pasos y 7 → 0', () => {
    const s = parse('*/15 9-11 1,15,1 * 7');
    if (s.kind !== 'cron') throw new Error('esperaba cron');
    expect(s.minute).toEqual([0, 15, 30, 45]);
    expect(s.hour).toEqual([9, 10, 11]);
    expect(s.dayOfMonth).toEqual([1, 15]);
    expect(s.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.dayOfWeek).toEqual([0]);
    expect(s.domRestricted).toBe(true);
    expect(s.dowRestricted).toBe(true);
  });

  it('domRestricted/dowRestricted: `*` literal no, `*/n` sí', () => {
    const a = parse('0 0 * * *');
    const b = parse('0 0 */2 * *');
    if (a.kind !== 'cron' || b.kind !== 'cron') throw new Error('esperaba cron');
    expect(a.domRestricted).toBe(false);
    expect(a.dowRestricted).toBe(false);
    expect(b.domRestricted).toBe(true);
  });

  it('rango con paso y 5-7 en día de la semana', () => {
    const s = parse('10-30/10 * * * 5-7');
    if (s.kind !== 'cron') throw new Error('esperaba cron');
    expect(s.minute).toEqual([10, 20, 30]);
    expect(s.dayOfWeek).toEqual([0, 5, 6]);
  });

  it.each([
    ['60 * * * *', /minute/],
    ['* 24 * * *', /hour/],
    ['* * 0 * *', /day-of-month/],
    ['* * * 13 *', /month/],
    ['* * * * 8', /day-of-week/],
    ['30-10 * * * *', /minute.*inverted/],
    ['*/0 * * * *', /minute.*step/],
    ['* * * JAN *', /month/],
    ['* * * * MON', /day-of-week/],
    ['* * ? * *', /day-of-month/],
    ['* * L * *', /day-of-month/],
    ['@daily', /Unrecognized/],
    ['* * * *', /Unrecognized/],
    ['* * * * * *', /Unrecognized/],
    ['1,,2 * * * *', /minute/],
    ['5/2 * * * *', /minute/],
  ])('rechaza %j', (text, re) => {
    const r = parseSchedule(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe('nextFire: cron', () => {
  it('*/15 * * * *', () => {
    expect(next('*/15 * * * *', d(2026, 3, 10, 10, 7))).toEqual(d(2026, 3, 10, 10, 15));
    expect(next('*/15 * * * *', d(2026, 3, 10, 10, 50))).toEqual(d(2026, 3, 10, 11, 0));
  });

  it('estrictamente posterior: from en una ocurrencia da la siguiente', () => {
    expect(next('*/15 * * * *', d(2026, 3, 10, 10, 15))).toEqual(d(2026, 3, 10, 10, 30));
  });

  it('trunca los segundos de from', () => {
    // 10:14:59.999 → el siguiente minuto es 10:15, que casa.
    expect(next('*/15 * * * *', d(2026, 3, 10, 10, 14, 59, 999))).toEqual(d(2026, 3, 10, 10, 15));
    // 10:15:30 ya pasó la ocurrencia de las 10:15.
    expect(next('*/15 * * * *', d(2026, 3, 10, 10, 15, 30))).toEqual(d(2026, 3, 10, 10, 30));
  });

  it('0 9 * * 1-5: un viernes a las 10:00 da el lunes a las 9:00', () => {
    const friday = d(2026, 10, 30, 10, 0); // 2026-10-30 es viernes
    expect(friday.getDay()).toBe(5);
    expect(next('0 9 * * 1-5', friday)).toEqual(d(2026, 11, 2, 9, 0));
  });

  it('listas de horas y minutos', () => {
    expect(next('0,30 8,20 * * *', d(2026, 3, 10, 8, 30))).toEqual(d(2026, 3, 10, 20, 0));
    expect(next('0,30 8,20 * * *', d(2026, 3, 10, 20, 30))).toEqual(d(2026, 3, 11, 8, 0));
  });

  it('rango con paso', () => {
    expect(next('10-50/20 * * * *', d(2026, 3, 10, 10, 10))).toEqual(d(2026, 3, 10, 10, 30));
    expect(next('10-50/20 * * * *', d(2026, 3, 10, 10, 50))).toEqual(d(2026, 3, 10, 11, 10));
  });

  it('0 0 1 1 *: salta al año siguiente', () => {
    expect(next('0 0 1 1 *', d(2026, 3, 10))).toEqual(d(2027, 1, 1, 0, 0));
  });

  it('dom y dow restringidos: basta uno (OR)', () => {
    // El 13 de cada mes o cada viernes, a las 00:00.
    const s = '0 0 13 * 5';
    // Desde el viernes 2026-10-30 00:00 (ocurrencia) → el siguiente viernes, 2026-11-06.
    expect(next(s, d(2026, 10, 30, 0, 0))).toEqual(d(2026, 11, 6, 0, 0));
    // Desde el 2026-11-09 (lunes): viernes 13 también es día 13; antes llega el 13 (viernes).
    expect(next(s, d(2026, 11, 9))).toEqual(d(2026, 11, 13, 0, 0));
    // Desde el 2026-11-14: el viernes 20.
    expect(next(s, d(2026, 11, 14))).toEqual(d(2026, 11, 20, 0, 0));
    // Un día 13 que no es viernes también vale: 2026-12-13 es domingo.
    expect(next(s, d(2026, 12, 12))).toEqual(d(2026, 12, 13, 0, 0));
  });

  it('solo dom restringido: AND con dow comodín', () => {
    expect(next('0 0 13 * *', d(2026, 11, 14))).toEqual(d(2026, 12, 13, 0, 0));
  });

  it('día de la semana 7 equivale a 0 (domingo)', () => {
    const sunday = d(2026, 11, 1, 0, 0);
    expect(sunday.getDay()).toBe(0);
    expect(next('0 0 * * 7', d(2026, 10, 30))).toEqual(sunday);
    expect(next('0 0 * * 0', d(2026, 10, 30))).toEqual(sunday);
  });

  it('0 0 30 2 * no ocurre nunca: null', () => {
    expect(next('0 0 30 2 *', d(2026, 1, 1))).toBeNull();
  });

  it('29 de febrero: salta al siguiente bisiesto dentro del tope', () => {
    expect(next('0 0 29 2 *', d(2026, 3, 1))).toEqual(d(2028, 2, 29, 0, 0));
  });
});

/**
 * Horario de una rutina (M16): intervalo (`30m`, `2h`, `1d`) o cron de 5 campos
 * en hora LOCAL. Módulo puro: sin `fs` y sin reloj implícito (nunca llama a
 * `Date.now()`; el llamante pasa `from`).
 *
 * Un vencimiento perdido (daemon parado, máquina dormida) no se recupera: el
 * llamante pide `nextFire(schedule, ahora, anchor)` y se salta solo.
 *
 * DST: no se gestiona más allá de lo que da `Date` local. Una hora que no existe
 * (salto de primavera) no casa nunca, así que ese día la rutina no corre; una
 * que se repite (retroceso de otoño) dispara una sola vez.
 */

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 366 * 86_400_000;

/** Tope de búsqueda de `nextFire` en cron. */
const MAX_SEARCH_YEARS = 5;

export type Schedule =
  | { kind: 'interval'; text: string; everyMs: number }
  | {
      kind: 'cron';
      text: string;
      minute: number[];
      hour: number[];
      dayOfMonth: number[];
      month: number[];
      dayOfWeek: number[];
      /** El campo no era `*` literal (`*\/n` cuenta como restringido). */
      domRestricted: boolean;
      dowRestricted: boolean;
    };

export type ParseScheduleResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

const FORMATS_HINT =
  'Valid formats: an interval like "30m", "2h" or "1d", or a 5-field cron expression ' +
  '(minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5".';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function fail(error: string): ParseScheduleResult {
  return { ok: false, error };
}

export function parseSchedule(input: string): ParseScheduleResult {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return fail(`Schedule is empty. ${FORMATS_HINT}`);

  const interval = /^(\d+)(m|h|d)$/.exec(text);
  if (interval) {
    const everyMs = Number(interval[1]) * UNIT_MS[interval[2] as keyof typeof UNIT_MS];
    if (!Number.isSafeInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
      return fail(`Interval "${text}" is too short: the minimum is 1m.`);
    }
    if (everyMs > MAX_INTERVAL_MS) {
      return fail(`Interval "${text}" is too long: the maximum is 366d.`);
    }
    return { ok: true, schedule: { kind: 'interval', text, everyMs } };
  }

  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    return fail(`Unrecognized schedule "${text}". ${FORMATS_HINT}`);
  }
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseField(minF, 0, 59, 'minute');
  if (typeof minute === 'string') return fail(minute);
  const hour = parseField(hourF, 0, 23, 'hour');
  if (typeof hour === 'string') return fail(hour);
  const dayOfMonth = parseField(domF, 1, 31, 'day-of-month');
  if (typeof dayOfMonth === 'string') return fail(dayOfMonth);
  const month = parseField(monF, 1, 12, 'month');
  if (typeof month === 'string') return fail(month);
  const dowRaw = parseField(dowF, 0, 7, 'day-of-week');
  if (typeof dowRaw === 'string') return fail(dowRaw);
  // 7 = domingo = 0; tras normalizar, ordenado y sin duplicados.
  const dayOfWeek = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    ok: true,
    schedule: {
      kind: 'cron',
      text,
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
      domRestricted: domF !== '*',
      dowRestricted: dowF !== '*',
    },
  };
}

/** Parsea un campo cron. Devuelve la lista ordenada y sin duplicados, o un mensaje de error. */
function parseField(raw: string, min: number, max: number, name: string): number[] | string {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') return `Invalid ${name} field "${raw}": empty list item.`;
    const [rangePart, stepPart, ...extra] = part.split('/');
    if (extra.length > 0) return `Invalid ${name} field "${raw}": too many "/" in "${part}".`;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return `Invalid ${name} field "${raw}": bad step "${stepPart}".`;
      step = Number(stepPart);
      if (step === 0) return `Invalid ${name} field "${raw}": step cannot be 0.`;
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart)) {
      // Un número suelto no admite paso (`5/2`): ambiguo, se rechaza.
      if (stepPart !== undefined) {
        return `Invalid ${name} field "${raw}": a step needs "*" or a range ("${part}").`;
      }
      lo = hi = Number(rangePart);
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!range) {
        return (
          `Invalid ${name} field "${raw}": unsupported syntax "${part}" ` +
          '(names, "?", "L", "W", "#" and @macros are not supported).'
        );
      }
      lo = Number(range[1]);
      hi = Number(range[2]);
      if (lo > hi) return `Invalid ${name} field "${raw}": inverted range "${rangePart}".`;
    }

    if (lo < min || hi > max) {
      return `Invalid ${name} field "${raw}": value out of range ${min}-${max}.`;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Primera ocurrencia ESTRICTAMENTE posterior a `from`, o `null` si no hay en los
 * próximos 5 años. `anchor` solo cuenta en intervalos (cron lo ignora).
 */
export function nextFire(schedule: Schedule, from: Date, anchor: Date): Date | null {
  if (schedule.kind === 'interval') {
    const delta = from.getTime() - anchor.getTime();
    // Ocurrencias = anchor + k·every con k >= 1: si `from` es anterior al anchor, la primera.
    const k = delta < 0 ? 1 : Math.floor(delta / schedule.everyMs) + 1;
    return new Date(anchor.getTime() + k * schedule.everyMs);
  }
  return nextCronFire(schedule, from);
}

function nextCronFire(s: Extract<Schedule, { kind: 'cron' }>, from: Date): Date | null {
  const minuteSet = new Set(s.minute);
  const hourSet = new Set(s.hour);
  const domSet = new Set(s.dayOfMonth);
  const monthSet = new Set(s.month);
  const dowSet = new Set(s.dayOfWeek);

  // Minuto siguiente a `from` truncado a minuto.
  let t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);

  const limit = new Date(from.getTime());
  limit.setFullYear(limit.getFullYear() + MAX_SEARCH_YEARS);

  // Avanza por campos; `advance` garantiza progreso aunque `Date` local normalice hacia atrás.
  const advance = (next: Date): void => {
    t = next.getTime() > t.getTime() ? next : new Date(t.getTime() + 60_000);
  };

  while (t.getTime() <= limit.getTime()) {
    const y = t.getFullYear();
    const mo = t.getMonth();
    const d = t.getDate();
    const h = t.getHours();
    const mi = t.getMinutes();

    if (!monthSet.has(mo + 1)) {
      advance(new Date(y, mo + 1, 1, 0, 0));
      continue;
    }
    const domOk = domSet.has(d);
    const dowOk = dowSet.has(t.getDay());
    // Semántica Vixie: con los dos restringidos basta uno (OR); si no, AND.
    const dayOk = s.domRestricted && s.dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) {
      advance(new Date(y, mo, d + 1, 0, 0));
      continue;
    }
    if (!hourSet.has(h)) {
      advance(new Date(y, mo, d, h + 1, 0));
      continue;
    }
    if (!minuteSet.has(mi)) {
      advance(new Date(y, mo, d, h, mi + 1));
      continue;
    }
    return t;
  }
  return null;
}

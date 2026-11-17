/**
 * M21 — de lo que pide el agente («en 25 minutos», «mañana a las 9») al
 * instante exacto, siempre en hora local del equipo.
 */
import { describe, expect, it } from 'vitest';
import { REMINDER_LIMITS } from '../protocol/index.js';
import { describeWhen, resolveWhen, ReminderWhenError, type ReminderWhenInput } from './when.js';

const LOCAL_2026_11_17 = new Date(2026, 10, 17, 21, 5, 0, 0);
const NOW = LOCAL_2026_11_17.getTime();
const MIN = 60_000;
const DAY = 86_400_000;

const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m, 0, 0).getTime();

function errorOf(input: ReminderWhenInput, now = NOW): string {
  try {
    resolveWhen(input, now);
  } catch (err) {
    expect(err).toBeInstanceOf(ReminderWhenError);
    return (err as Error).message;
  }
  return 'OK';
}

describe('M21 — resolveWhen', () => {
  it('inMinutes: la hora exacta y un texto que se puede leer', () => {
    const when = resolveWhen({ inMinutes: 25 }, NOW);
    expect(when.dueAt).toBe(NOW + 25 * MIN);
    expect(when).toMatchObject({ day: 'today', dayLabel: '17/11', clock: '21:30' });
    expect(when.text).toBe('hoy a las 21:30 (en 25 min)');
  });

  it('time sin fecha: hoy; si la hora ya pasó, mañana (cambio de día)', () => {
    const today = resolveWhen({ time: '21:30' }, NOW);
    expect(today.dueAt).toBe(at(17, 21, 30));
    expect(today.day).toBe('today');

    // A las 22:00, «las 9» es mañana a las 9: otro día del calendario, no 11 horas.
    const tonight = new Date(2026, 10, 17, 22, 0, 0, 0).getTime();
    const tomorrow = resolveWhen({ time: '09:00' }, tonight);
    expect(tomorrow.dueAt).toBe(at(18, 9));
    expect(tomorrow).toMatchObject({ day: 'tomorrow', dayLabel: '18/11', clock: '09:00' });
    expect(tomorrow.text).toBe('mañana 18/11 a las 09:00');

    // Justo el mismo minuto ya cuenta como pasado: mañana, no «ahora».
    const same = resolveWhen({ time: '22:00' }, tonight);
    expect(same.dueAt).toBe(at(18, 22));
    // Y el cambio de día a las 23:50 con una hora de la madrugada.
    const late = new Date(2026, 10, 17, 23, 50, 0, 0).getTime();
    expect(resolveWhen({ time: '00:10' }, late).dueAt).toBe(at(18, 0, 10));
  });

  it('date + time se convierte a hora local del equipo', () => {
    const when = resolveWhen({ date: '2026-11-20', time: '09:00' }, NOW);
    expect(when.dueAt).toBe(at(20, 9));
    // La misma hora que en el reloj de casa del proceso, sea cual sea su zona.
    const d = new Date(when.dueAt);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 11, 20, 9, 0,
    ]);
    expect(when.text).toBe('el 20/11 a las 09:00');
    // Y con la fecha puesta, no se pasa sola al día siguiente.
    expect(resolveWhen({ date: '2026-11-18', time: '09:00' }, NOW).day).toBe('tomorrow');
  });

  it('fechas lejanas y cerca de la hora, la cuenta que se lee', () => {
    const soon = resolveWhen({ time: '21:10' }, NOW);
    expect(soon.text).toBe('hoy a las 21:10 (en 5 min)');
    const far = resolveWhen({ inMinutes: 3 * 24 * 60 }, NOW);
    expect(far.text).toBe('el 20/11 a las 21:05');
    // Más de una hora: no hace falta decir cuánto falta.
    expect(resolveWhen({ time: '23:30' }, NOW).text).toBe('hoy a las 23:30');
  });

  it.each([
    [{}, 'Say when'],
    [{ time: '25:00' }, 'hours go from 00 to 23'],
    [{ time: '9:60' }, 'minutes go from 00 to 59'],
    [{ time: 'nueve' }, 'not HH:MM'],
    [{ date: '2026-11-18', time: '09:00', inMinutes: 5 }, 'not both'],
    [{ date: '2026-11-18' }, 'Say when'],
    [{ date: '2026-02-30', time: '09:00' }, 'there is no such day'],
    [{ date: '18/11/2026', time: '09:00' }, 'YYYY-MM-DD'],
    [{ date: '2026-11-10', time: '09:00' }, 'in the past'],
    [{ inMinutes: 0 }, 'at least 1 minute'],
    [{ inMinutes: -5 }, 'at least 1 minute'],
    [{ inMinutes: 1.5 }, 'whole number'],
    [{ inMinutes: REMINDER_LIMITS.maxLeadMs / MIN + 1 }, 'more than a year'],
    [{ date: '2028-01-18', time: '09:00' }, 'more than a year'],
  ] as Array<[ReminderWhenInput, string]>)('entrada imposible %j → «%s»', (input, message) => {
    expect(errorOf(input)).toContain(message);
  });

  it('describeWhen no inventa: el borde de la hora justa', () => {
    expect(describeWhen(NOW + MIN, NOW).text).toBe('hoy a las 21:06 (en 1 min)');
    expect(describeWhen(NOW + DAY, NOW).day).toBe('tomorrow');
    expect(describeWhen(NOW + 0, NOW)).toMatchObject({ day: 'today', clock: '21:05' });
  });
});

/**
 * El cambio de hora se prueba con la zona del proceso. `process.env.TZ` surte
 * efecto en Linux/macOS y, en Windows, según la versión de Node; si no surte
 * efecto, se detectan las transiciones del año con `getTimezoneOffset()` y se
 * salta lo que no aplique, diciéndolo.
 */
const MADRID = ((): boolean => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Madrid';
  const summer = new Date(2026, 6, 1, 12).getTimezoneOffset();
  const winter = new Date(2026, 0, 1, 12).getTimezoneOffset();
  const applied = summer === -120 && winter === -60;
  if (!applied) {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  return applied;
})();

interface Transition {
  /** Fecha `YYYY-MM-DD`. */
  date: string;
  /** Hora local `HH:MM` que no existe o que existe dos veces. */
  time: string;
}

/** Busca en 2026, en la zona del proceso, una hora que no existe y otra que se repite. */
function transitions2026(): { skipped?: Transition; repeated?: Transition } {
  const out: { skipped?: Transition; repeated?: Transition } = {};
  const pad = (n: number): string => String(n).padStart(2, '0');
  const days = (Date.UTC(2026, 11, 31) - Date.UTC(2026, 0, 1)) / 86_400_000 + 1;
  for (let i = 0; i < days; i++) {
    const day = new Date(2026, 0, 1 + i, 12);
    const previous = new Date(day.getTime() - 86_400_000);
    if (day.getTimezoneOffset() === previous.getTimezoneOffset()) continue;
    const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    for (let hour = 0; hour < 24; hour++) {
      const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 30, 0, 0);
      const roundTrip = ts.getHours() === hour && ts.getMinutes() === 30;
      if (!roundTrip && !out.skipped) out.skipped = { date, time: `${pad(hour)}:30` };
      const again = ts.getTime() + 3_600_000;
      const repeated =
        roundTrip && new Date(again).getHours() === hour && new Date(again).getMinutes() === 30;
      if (repeated && !out.repeated) out.repeated = { date, time: `${pad(hour)}:30` };
    }
  }
  return out;
}

const TRANSITIONS = transitions2026();
/** Sin dos cambios ese año no hay nada que probar: se dice en el nombre del test, no se finge. */
const NO_DST =
  TRANSITIONS.skipped && TRANSITIONS.repeated
    ? ''
    : ` (se salta: la zona ${Intl.DateTimeFormat().resolvedOptions().timeZone} no tiene dos cambios de hora en 2026)`;

describe('M21 — el cambio de hora', () => {
  it.skipIf(!TRANSITIONS.skipped)(`una hora que no existe ese día es un error${NO_DST}`, () => {
    const skipped = TRANSITIONS.skipped!;
    const day = new Date(`${skipped.date}T12:00:00`).getTime() - 86_400_000;
    expect(() => resolveWhen({ date: skipped.date, time: skipped.time }, day)).toThrow(
      /does not exist/,
    );
    // Y sin fecha, si es la hora de hoy, tampoco se inventa otra.
    const midnight = new Date(`${skipped.date}T00:05:00`).getTime();
    expect(resolveWhen({ time: '00:10' }, midnight).dueAt).toBeGreaterThan(midnight);
  });

  it.skipIf(!TRANSITIONS.repeated)(
    `una hora que se repite se queda con la primera futura${NO_DST}`,
    () => {
      const repeated = TRANSITIONS.repeated!;
      const [h, m] = repeated.time.split(':').map(Number) as [number, number];
      const first = new Date(repeated.date);
      first.setHours(h, m, 0, 0);
      const firstTs = first.getTime();
      expect(new Date(firstTs).getHours()).toBe(h);

      // Antes de la primera: la primera ocurrencia.
      const before = firstTs - 10 * MIN;
      expect(resolveWhen({ date: repeated.date, time: repeated.time }, before).dueAt).toBe(firstTs);

      // Entre las dos (la primera ya pasó): la segunda.
      const between = firstTs + 10 * MIN;
      const second = resolveWhen({ date: repeated.date, time: repeated.time }, between).dueAt;
      expect(second).toBe(firstTs + 3_600_000);
      expect(new Date(second).getHours()).toBe(h);
    },
  );

  it.runIf(MADRID)('en Europe/Madrid: el 29 de marzo y el 25 de octubre de 2026', () => {
    expect(TRANSITIONS.skipped).toEqual({ date: '2026-03-29', time: '02:30' });
    expect(TRANSITIONS.repeated?.date).toBe('2026-10-25');
  });
});

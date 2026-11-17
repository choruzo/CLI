import { describe, expect, it } from 'vitest';
import type { FreqWindow } from './queries.js';
import {
  freqState,
  freqStateText,
  groupWindows,
  headwayText,
  mergeWindows,
  minutesUntil,
  rideText,
} from './schedule.js';

const H = 3600;
const win = (
  start: number,
  end: number,
  headway: number,
  extra: Partial<FreqWindow> = {},
): FreqWindow => ({
  routeId: '027',
  direction: 0,
  headsign: 'Plaza Castilla',
  start,
  end,
  headway,
  ride: null,
  ...extra,
});

describe('ventanas de frecuencia', () => {
  it('une las ventanas seguidas con la misma frecuencia y deja las de otra', () => {
    const merged = mergeWindows([
      { start: 7 * H, end: 8 * H - 1, headway: 480, ride: null },
      { start: 8 * H, end: 9 * H - 1, headway: 480, ride: null },
      { start: 9 * H, end: 10 * H - 1, headway: 600, ride: null },
    ]);
    expect(merged).toEqual([
      { start: 7 * H, end: 9 * H - 1, headway: 480, ride: null },
      { start: 9 * H, end: 10 * H - 1, headway: 600, ride: null },
    ]);
  });

  it('agrupa por línea y sentido, cuenta una vez las ventanas repetidas y pasa a «hoy» las de ayer', () => {
    const groups = groupWindows([
      {
        shift: 0,
        windows: [
          win(7 * H, 8 * H - 1, 480),
          win(7 * H, 8 * H - 1, 480),
          win(7 * H, 8 * H - 1, 480, { direction: 1, headsign: 'Embajadores' }),
        ],
      },
      // Una ventana de ayer que acaba pasadas las 24:00 sigue vigente a las 00:30 de hoy.
      { shift: -86400, windows: [win(23 * H, 25 * H, 900), win(5 * H, 6 * H, 900)] },
    ]);
    expect(groups).toHaveLength(2);
    const g0 = groups.find((g) => g.direction === 0)!;
    expect(g0.windows.map((w) => [w.start, w.end, w.headway])).toEqual([
      [-3600, 3600, 900],
      [7 * H, 8 * H - 1, 480],
    ]);
  });

  it('dentro de una ventana dice la frecuencia y hasta cuándo', () => {
    const w = mergeWindows([{ start: 7 * H, end: 9 * H - 1, headway: 480, ride: null }]);
    const s = freqState(w, 8 * H);
    expect(s).toMatchObject({ kind: 'now', headway: 480 });
    expect(freqStateText(s)).toBe('cada 8 min (hasta las 09:00)');
  });

  it('entre ventanas dice la primera pasada de la siguiente y después la frecuencia', () => {
    const w = mergeWindows([
      { start: 7 * H, end: 9 * H, headway: 480, ride: null },
      { start: 17 * H + 360, end: 20 * H, headway: 420, ride: null },
    ]);
    const s = freqState(w, 12 * H);
    expect(s).toMatchObject({ kind: 'later', first: 17 * H + 360 });
    expect(freqStateText(s)).toBe('primera pasada hacia las 17:06, después cada 7 min');
  });

  it('fuera de servicio dice que no hay hasta mañana', () => {
    const w = mergeWindows([{ start: 7 * H, end: 9 * H, headway: 480, ride: null }]);
    expect(freqStateText(freqState(w, 23 * H))).toBe('sin servicio hasta mañana');
    expect(freqStateText(freqState([], 0))).toBe('sin servicio hasta mañana');
  });

  it('si hay dos ventanas a la vez, gana la más frecuente', () => {
    const s = freqState(
      [
        { start: 0, end: 10 * H, headway: 900, ride: null },
        { start: 0, end: 10 * H, headway: 600, ride: null },
      ],
      H,
    );
    expect(s).toMatchObject({ kind: 'now', headway: 600 });
  });
});

describe('textos de tiempo', () => {
  it('frecuencia en minutos, con decimales o en segundos', () => {
    expect(headwayText(480)).toBe('cada 8 min');
    expect(headwayText(450)).toBe('cada 7,5 min');
    expect(headwayText(45)).toBe('cada 45 s');
  });

  it('un viaje nunca dura 0 min', () => {
    expect(rideText(20)).toBe('unos 1 min de viaje');
    expect(rideText(740)).toBe('unos 12 min de viaje');
  });

  it('minutos que faltan', () => {
    expect(minutesUntil(1000 + 360, 1000)).toBe('en 6 min');
    expect(minutesUntil(1000, 1000)).toBe('ahora');
    expect(minutesUntil(500, 1000)).toBeNull();
  });
});

describe('horas pasadas las 24:00 del día de servicio', () => {
  it('«hasta» una hora de mañana lo dice, no la confunde con una de hoy', () => {
    const w = mergeWindows([{ start: 23 * H, end: 24 * H + 120, headway: 1200, ride: null }]);
    expect(freqStateText(freqState(w, 23 * H + 1800))).toBe(
      'cada 20 min (hasta mañana a las 00:02)',
    );
  });

  it('la primera pasada de mañana lo dice; la de hoy, no', () => {
    const w = mergeWindows([{ start: 24 * H + 1800, end: 26 * H, headway: 1800, ride: null }]);
    expect(freqStateText(freqState(w, 8 * H))).toBe(
      'primera pasada mañana hacia las 00:30, después cada 30 min',
    );
    const today = mergeWindows([{ start: 6 * H, end: 9 * H, headway: 600, ride: null }]);
    expect(freqStateText(freqState(today, 3 * H))).toBe(
      'primera pasada hacia las 06:00, después cada 10 min',
    );
  });

  it('la duración del viaje es la de la ventana que se dice (vigente o próxima)', () => {
    const w = mergeWindows([
      { start: 6 * H, end: 9 * H, headway: 600, ride: 600 },
      { start: 17 * H, end: 20 * H, headway: 420, ride: 900 },
    ]);
    expect(freqState(w, 7 * H)).toMatchObject({ kind: 'now', ride: 600 });
    expect(freqState(w, 12 * H)).toMatchObject({ kind: 'later', ride: 900 });
  });
});

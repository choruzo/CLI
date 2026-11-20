import { describe, expect, it } from 'vitest';
import { durationText, localToInstant, parseHistory } from './history.js';

const MADRID = 'Europe/Madrid';
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

describe('localToInstant', () => {
  it('convierte la hora de la casa a UTC, en invierno y en verano', () => {
    expect(iso(localToInstant('2026-11-19T21:00', MADRID))).toBe('2026-11-19T20:00:00.000Z');
    expect(iso(localToInstant('2026-07-01T21:00', MADRID))).toBe('2026-07-01T19:00:00.000Z');
  });

  it('una fecha sola es su 00:00, o el día siguiente con endOfDay', () => {
    expect(iso(localToInstant('2026-11-19', MADRID))).toBe('2026-11-18T23:00:00.000Z');
    expect(iso(localToInstant('2026-11-19', MADRID, true))).toBe('2026-11-19T23:00:00.000Z');
    // Con hora, endOfDay no cambia nada.
    expect(iso(localToInstant('2026-11-19T10:00', MADRID, true))).toBe('2026-11-19T09:00:00.000Z');
  });

  it('cruza bien los cambios de hora', () => {
    // 29 mar 2026: de 02:00 se pasa a 03:00. Las 02:30 no existen y caen en 03:30.
    expect(iso(localToInstant('2026-03-29T01:30', MADRID))).toBe('2026-03-29T00:30:00.000Z');
    expect(iso(localToInstant('2026-03-29T03:30', MADRID))).toBe('2026-03-29T01:30:00.000Z');
    expect(iso(localToInstant('2026-03-29T02:30', MADRID))).toBe('2026-03-29T01:30:00.000Z');
    // 25 oct 2026: de 03:00 se vuelve a 02:00; el día entero dura 25 h.
    const day = localToInstant('2026-10-25', MADRID)!;
    expect(localToInstant('2026-10-25', MADRID, true)! - day).toBe(25 * 3_600_000);
  });

  it('sin zona válida usa UTC', () => {
    expect(iso(localToInstant('2026-11-19T21:00', null))).toBe('2026-11-19T21:00:00.000Z');
    expect(iso(localToInstant('2026-11-19T21:00', 'Nada/Nada'))).toBe('2026-11-19T21:00:00.000Z');
  });

  it('rechaza lo que no es una fecha y hora reales', () => {
    for (const v of [
      '',
      'ayer',
      '2026-11-19 21:00',
      '2026-02-29',
      '2026-13-01',
      '2026-11-19T24:00',
      '2026-11-19T21:60',
      '19/11/2026',
    ]) {
      expect(localToInstant(v, MADRID), v).toBeNull();
    }
  });
});

describe('parseHistory', () => {
  it('junta los puntos por entidad, ordenados y sin repetir estado', () => {
    const h = parseHistory([
      [
        {
          entity_id: 'light.a',
          state: 'on',
          attributes: { friendly_name: 'A' },
          last_changed: '2026-11-20T10:00:00Z',
        },
        { state: 'on', last_changed: '2026-11-20T10:05:00Z' },
        { state: 'off', last_changed: '2026-11-20T11:00:00Z' },
        { state: 'off', last_changed: 'no es una fecha' },
      ],
      'basura',
      [],
      [{ state: 'sin entity_id' }],
    ]);
    expect([...h.keys()]).toEqual(['light.a']);
    expect(h.get('light.a')!.name).toBe('A');
    expect(h.get('light.a')!.points.map((p) => p.state)).toEqual(['on', 'off']);
  });

  it('una respuesta que no es una lista no da nada', () => {
    expect(parseHistory({ message: 'x' }).size).toBe(0);
  });
});

describe('durationText', () => {
  it('días, horas y minutos', () => {
    expect(durationText(30_000)).toBe('menos de 1 min');
    expect(durationText(12 * 60_000)).toBe('12 min');
    expect(durationText(125 * 60_000)).toBe('2 h 05 min');
    expect(durationText(24 * 3_600_000)).toBe('1 d');
    expect(durationText(76 * 3_600_000)).toBe('3 d 4 h');
  });
});

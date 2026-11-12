import { describe, expect, it } from 'vitest';
import { NO_DATA, localTime, normalizeName, num, pct, stateText } from './format.js';

describe('format de Home Assistant', () => {
  it('normaliza acentos y mayúsculas', () => {
    expect(normalizeName('  Salón  PRINCIPAL ')).toBe('salon principal');
  });
  it('hora en la zona de HA', () => {
    expect(localTime('2026-11-12T20:03:00+00:00', 'Europe/Madrid')).toBe('12 nov 21:03');
    expect(localTime('2026-11-12T20:03:00+00:00', null)).toBe('12 nov 20:03 UTC');
    expect(localTime(null, 'Europe/Madrid')).toBe(NO_DATA);
    expect(localTime('basura', 'Europe/Madrid')).toBe(NO_DATA);
  });
  it('porcentajes y números sin dato, nunca 0', () => {
    expect(pct(128, 255)).toBe('50 %');
    expect(pct(0.3, 1)).toBe('30 %');
    expect(pct(undefined, 255)).toBe(NO_DATA);
    expect(num(21.54)).toBe('21,5');
    expect(num('x')).toBe(NO_DATA);
  });
  it('estado con unidad y estados especiales', () => {
    const base = { entity_id: 'sensor.t', last_changed: null };
    expect(stateText({ ...base, state: '21.5', attributes: { unit_of_measurement: '°C' } })).toBe(
      '21.5 °C',
    );
    expect(stateText({ ...base, state: 'unavailable', attributes: {} })).toBe('no disponible');
    expect(stateText({ ...base, state: 'unknown', attributes: {} })).toBe(NO_DATA);
  });
});

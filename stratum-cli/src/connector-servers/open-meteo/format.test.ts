import { describe, expect, it } from 'vitest';
import { clock, dayLabel, dec1, hourLabel, int, normalizeName, windDirection } from './format.js';
import { weatherText } from './weather-codes.js';

describe('format', () => {
  it('números con coma y null como «sin dato»', () => {
    expect(dec1(21.34)).toBe('21,3');
    expect(dec1(0)).toBe('0,0');
    expect(dec1(null)).toBe('sin dato');
    expect(int(12.6)).toBe('13');
    expect(int(null)).toBe('sin dato');
  });

  it('rumbos del viento', () => {
    expect(windDirection(0)).toBe('norte');
    expect(windDirection(225)).toBe('suroeste');
    expect(windDirection(350)).toBe('norte');
    expect(windDirection(360)).toBe('norte');
    expect(windDirection(90)).toBe('este');
  });

  it('fechas locales sin depender de la zona horaria', () => {
    expect(dayLabel('2026-11-11')).toBe('mié 11 nov');
    expect(dayLabel('2026-01-01')).toBe('jue 1 ene');
    expect(hourLabel('2026-11-11T21:00')).toBe('mié 21:00');
    expect(clock('2026-11-11T07:58')).toBe('07:58');
    expect(clock(null)).toBe('sin dato');
  });

  it('normaliza nombres', () => {
    expect(normalizeName('  Málaga   CITY ')).toBe('malaga city');
  });

  it('códigos WMO', () => {
    expect(weatherText(0)).toBe('despejado');
    expect(weatherText(99)).toBe('tormenta con granizo fuerte');
    expect(weatherText(42)).toBe('código meteorológico 42');
    expect(weatherText(null)).toBe('sin dato');
  });
});

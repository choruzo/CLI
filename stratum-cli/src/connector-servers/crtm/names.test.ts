import { describe, expect, it } from 'vitest';
import { lineTag, parseStationRef, stationRef, titleCase } from './names.js';

describe('titleCase', () => {
  it('pasa las MAYÚSCULAS a formato de título con los artículos en minúscula', () => {
    expect(titleCase('PLAZA DE CASTILLA')).toBe('Plaza de Castilla');
    expect(titleCase('PUERTA DEL SOL')).toBe('Puerta del Sol');
    expect(titleCase('LAS TABLAS')).toBe('Las Tablas');
    expect(titleCase('PALAS DE REY')).toBe('Palas de Rey');
  });

  it('el artículo del principio y el de después de un guion llevan mayúscula', () => {
    expect(titleCase('LA GAVIA')).toBe('La Gavia');
    expect(titleCase('GRAN VIA - LA PLAZA')).toBe('Gran Via - La Plaza');
  });

  it('en un nombre mixto solo arregla los artículos', () => {
    expect(titleCase('Blanca De Castilla')).toBe('Blanca de Castilla');
    expect(titleCase('Calle De Las Delicias')).toBe('Calle de las Delicias');
    expect(titleCase('Intercambiador de Plaza de Castilla')).toBe(
      'Intercambiador de Plaza de Castilla',
    );
    expect(titleCase("O'Donnell")).toBe("O'Donnell");
  });

  it('respeta apóstrofos y guiones en MAYÚSCULAS y colapsa espacios', () => {
    expect(titleCase("O'DONNELL")).toBe("O'Donnell");
    expect(titleCase('M-30   ')).toBe('M-30');
  });
});

describe('etiquetas e ids', () => {
  it('etiqueta de línea por modo', () => {
    expect(lineTag('metro', '1')).toBe('L1');
    expect(lineTag('metro', 'R')).toBe('R');
    expect(lineTag('ml', 'ML1')).toBe('ML1');
    expect(lineTag('emt', '27')).toBe('27');
  });

  it('ids estables de estación', () => {
    expect(stationRef('emt', '4514')).toBe('emt:4514');
    expect(parseStationRef('ml:est_10_1')).toEqual({ mode: 'ml', stationId: 'est_10_1' });
    expect(parseStationRef(' EMT:4514 ')).toEqual({ mode: 'emt', stationId: '4514' });
    expect(parseStationRef('plaza de castilla')).toBeNull();
    expect(parseStationRef('foo:1')).toBeNull();
  });
});

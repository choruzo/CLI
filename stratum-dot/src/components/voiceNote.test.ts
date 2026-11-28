import { describe, expect, it } from 'vitest';
import { insertNote, mmss, voiceMarker, withMarker } from './voiceNote';

describe('la marca de la nota', () => {
  it('los segundos, en M:SS: los minutos no se rellenan y los de menos de diez sí', () => {
    expect(mmss(7.4)).toBe('0:07');
    expect(mmss(102)).toBe('1:42');
    expect(mmss(0)).toBe('0:00');
    expect(mmss(59.9)).toBe('0:59');
    expect(mmss(600)).toBe('10:00');
    // Lo que no es un número no inventa tiempo.
    expect(mmss(Number.NaN)).toBe('0:00');
  });

  it('la marca, con el aviso de recortada cuando el audio llegó al tope', () => {
    expect(voiceMarker(7, false)).toBe('[nota de voz, 0:07] ');
    expect(voiceMarker(102, true)).toBe('[nota de voz, 1:42, recortada] ');
  });
});

describe('meter el texto en el campo', () => {
  it('detrás de lo que hubiera, con un espacio de por medio sin doblarlo', () => {
    expect(insertNote('', 'hola')).toBe('hola');
    expect(insertNote('recuérdame', 'la compra')).toBe('recuérdame la compra');
    expect(insertNote('recuérdame ', 'la compra')).toBe('recuérdame la compra');
    expect(insertNote('recuérdame\n', 'la compra')).toBe('recuérdame\nla compra');
  });
});

describe('al enviar', () => {
  const note = { inserted: 'hola', durationSec: 7, capped: false };

  it('campo vacío + «hola» → la marca y el texto', () => {
    expect(withMarker('hola', note)).toBe('[nota de voz, 0:07] hola');
  });

  it('«recuérdame» + «la compra» → la marca delante de todo', () => {
    expect(withMarker('recuérdame hola', note)).toBe('[nota de voz, 0:07] recuérdame hola');
  });

  it('tocado → sin marca: lo que se corrige ya es de la persona', () => {
    expect(withMarker('holi, qué tal', note)).toBe('holi, qué tal');
    expect(withMarker('adiós', note)).toBe('adiós');
  });

  it('es un «contiene»: si el texto dictado sigue dentro, la marca se queda', () => {
    expect(withMarker('hola, con una coma', note)).toBe('[nota de voz, 0:07] hola, con una coma');
    expect(withMarker('digo hola', note)).toBe('[nota de voz, 0:07] digo hola');
  });

  it('sin nota no hay marca, y una nota sin texto tampoco la pone', () => {
    expect(withMarker('hola', null)).toBe('hola');
    expect(withMarker('hola', { inserted: '', durationSec: 3, capped: false })).toBe('hola');
  });

  it('recortada: el aviso viaja en la marca', () => {
    expect(withMarker('hola', { inserted: 'hola', durationSec: 102, capped: true })).toBe(
      '[nota de voz, 1:42, recortada] hola',
    );
  });
});

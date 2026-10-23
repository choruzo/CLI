import { describe, expect, it } from 'vitest';
import { countWords, reasoningPreview } from './reasoning-preview.js';

describe('reasoningPreview', () => {
  it('abierto: enseña el último párrafo terminado, no el que está llegando', () => {
    const text = 'Primero leo el fichero.\n\nLuego busco el test que fal';
    expect(reasoningPreview(text, true).preview).toBe('Primero leo el fichero.');
  });

  it('abierto sin párrafo cerrado: la última frase terminada', () => {
    const text = 'Miro la config. Después compruebo el esquema y lue';
    expect(reasoningPreview(text, true).preview).toBe('Miro la config.');
  });

  it('abierto y sin nada terminado: vacío', () => {
    expect(reasoningPreview('Estoy pensando en', true).preview).toBe('');
  });

  it('abierto con salto de párrafo al final: el último párrafo ya vale', () => {
    expect(reasoningPreview('Uno.\n\nDos.\n\n', true).preview).toBe('Dos.');
  });

  it('cerrado: el último párrafo entero, aplanado a una línea', () => {
    const text = 'Uno.\n\nDos líneas\n  en un párrafo.';
    expect(reasoningPreview(text, false).preview).toBe('Dos líneas en un párrafo.');
  });

  it('cuenta palabras sin contar huecos', () => {
    expect(countWords('  a  b\n\nc ')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(reasoningPreview('a b c', false).words).toBe(3);
  });
});

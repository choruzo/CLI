import { describe, it, expect } from 'vitest';
import { resolveLayout, MAX_CONTENT_WIDTH, MIN_ROWS } from './layout.js';
import { getAsciiArt, ASCII_ART_FULL, ASCII_ART_SMALL, ASCII_TEXT_ONLY } from './ascii-art.js';

describe('resolveLayout — eje vertical (§9)', () => {
  it('con 24 filas o más muestra los tips del banner', () => {
    expect(resolveLayout(100, MIN_ROWS).showTips).toBe(true);
    expect(resolveLayout(100, 50).showTips).toBe(true);
  });

  it('por debajo de 24 filas el banner se reduce', () => {
    expect(resolveLayout(100, 23).showTips).toBe(false);
    expect(resolveLayout(100, 10).showTips).toBe(false);
  });
});

describe('resolveLayout — ancho de contenido (§9)', () => {
  it('en terminales estrechas usa el ancho disponible', () => {
    expect(resolveLayout(80, 30).contentWidth).toBe(80);
  });

  it('en terminales amplias limita el contenido a 100 columnas', () => {
    expect(resolveLayout(200, 30).contentWidth).toBe(MAX_CONTENT_WIDTH);
    expect(resolveLayout(121, 30).contentWidth).toBe(MAX_CONTENT_WIDTH);
  });

  it('tolera dimensiones ausentes o cero sin romper el layout', () => {
    expect(resolveLayout(0, 0)).toEqual({ showTips: true, contentWidth: 80 });
  });
});

describe('getAsciiArt — eje horizontal (§9)', () => {
  it('degrada el arte según el ancho del terminal', () => {
    expect(getAsciiArt(120)).toBe(ASCII_ART_FULL);
    expect(getAsciiArt(72)).toBe(ASCII_ART_FULL);
    expect(getAsciiArt(71)).toBe(ASCII_ART_SMALL);
    expect(getAsciiArt(60)).toBe(ASCII_ART_SMALL);
    expect(getAsciiArt(59)).toBe(ASCII_TEXT_ONLY);
  });
});

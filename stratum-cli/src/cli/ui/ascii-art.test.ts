import { describe, expect, it } from 'vitest';
import { ASCII_ART_FULL, ASCII_ART_SMALL, ASCII_TEXT_ONLY, getAsciiArtWidth } from './ascii-art.js';

describe('ASCII art geometry', () => {
  it('calculates the maximum row width used by the ANSI animator', () => {
    expect(getAsciiArtWidth(['ABCDEF', '1234', 'xy'].join('\n'))).toBe(6);
  });

  it('keeps every bundled logo within its terminal breakpoint', () => {
    expect(getAsciiArtWidth(ASCII_TEXT_ONLY)).toBeLessThanOrEqual(59);
    expect(getAsciiArtWidth(ASCII_ART_SMALL)).toBeLessThanOrEqual(71);
    expect(getAsciiArtWidth(ASCII_ART_FULL)).toBeLessThanOrEqual(80);
  });
});

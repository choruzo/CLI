/**
 * Tests de `decodeXml`: entidades predefinidas, numéricas y, sobre todo, las
 * numéricas **inválidas** (`&#9999999;`, sustitutos sueltos), que antes lanzaban
 * `RangeError` y tumbaban el parseo de todo el feed. Ahora dan «�».
 */
import { describe, expect, it } from 'vitest';
import { decodeXml } from './xml.js';

describe('decodeXml', () => {
  it('decodifica las entidades predefinidas y las numéricas válidas', () => {
    expect(decodeXml('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'A & B <c> "d" \'e\'',
    );
    expect(decodeXml('R&#237;o &#233; &#x1F600;')).toBe('Río é 😀');
    // `&amp;lt;` es el literal `&lt;`, no un `<`.
    expect(decodeXml('&amp;lt;')).toBe('&lt;');
  });

  it('una entidad numérica fuera de rango o un sustituto suelto dan «�», no RangeError', () => {
    expect(decodeXml('a&#9999999;b')).toBe('a\uFFFDb');
    expect(decodeXml('a&#x110000;b')).toBe('a\uFFFDb'); // > 0x10FFFF
    expect(decodeXml('a&#xD800;b')).toBe('a\uFFFDb'); // sustituto suelto
    expect(decodeXml('a&#1114112;b')).toBe('a\uFFFDb'); // 0x110000
    // El límite válido sí pasa.
    expect(decodeXml('&#1114111;')).toBe('\u{10FFFF}');
    expect(decodeXml('&#x10FFFF;')).toBe('\u{10FFFF}');
  });
});

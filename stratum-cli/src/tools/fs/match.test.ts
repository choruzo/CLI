import { describe, it, expect } from 'vitest';
import { MATCH_LEVELS, findSpans, locate, replaceSpans, type Span } from './match.js';

/** Lo que el tramo cubre en el original, para leer los asserts de un vistazo. */
const cut = (text: string, spans: Span[]) => spans.map((s) => text.slice(s.start, s.end));

describe('findSpans — nivel exact', () => {
  it('encuentra todas las apariciones sin solapes, de izquierda a derecha', () => {
    expect(cut('aaaa', findSpans('aaaa', 'aa', 'exact'))).toEqual(['aa', 'aa']);
    expect(cut('a-a-a', findSpans('a-a-a', 'a', 'exact'))).toEqual(['a', 'a', 'a']);
    expect(findSpans('abc', 'x', 'exact')).toEqual([]);
  });

  it('no solapa: avanza la longitud del needle', () => {
    // "aaa" con needle "aa": una sola coincidencia, no dos solapadas.
    expect(findSpans('aaa', 'aa', 'exact')).toEqual([{ start: 0, end: 2 }]);
  });

  it('un needle vacío no casa nada', () => {
    expect(findSpans('abc', '', 'exact')).toEqual([]);
    expect(findSpans('abc', '', 'unicode')).toEqual([]);
    expect(findSpans('abc', '', 'trailing-whitespace')).toEqual([]);
  });
});

describe('findSpans — nivel unicode', () => {
  it('comillas tipográficas en el texto y rectas en el needle', () => {
    const text = 'const a = ‘hello’; const b = “bye”;';
    expect(cut(text, findSpans(text, "const a = 'hello';", 'unicode'))).toEqual([
      'const a = ‘hello’;',
    ]);
    expect(cut(text, findSpans(text, 'const b = "bye";', 'unicode'))).toEqual(['const b = “bye”;']);
  });

  it('comillas rectas en el texto y tipográficas en el needle', () => {
    const text = 'say \'hi\' and "bye"';
    expect(cut(text, findSpans(text, 'say \u2018hi\u2019', 'unicode'))).toEqual(["say 'hi'"]);
    expect(cut(text, findSpans(text, 'and \u201cbye\u201d', 'unicode'))).toEqual(['and "bye"']);
  });

  it('guiones y rayas de todo el rango', () => {
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015']) {
      const text = `a ${dash} b`;
      expect(cut(text, findSpans(text, 'a - b', 'unicode')), dash).toEqual([text]);
    }
  });

  it('espacios raros: NBSP, U+2000–U+200A, U+202F, U+205F, U+3000', () => {
    const weird = ['\u00a0', '\u2000', '\u2005', '\u200a', '\u202f', '\u205f', '\u3000'];
    for (const space of weird) {
      const text = `foo${space}bar`;
      expect(cut(text, findSpans(text, 'foo bar', 'unicode')), JSON.stringify(space)).toEqual([
        text,
      ]);
    }
  });

  it('los puntos suspensivos generan tres caracteres que apuntan al mismo offset', () => {
    const text = 'espera\u2026 ya';
    const spans = findSpans(text, 'espera... ya', 'unicode');
    expect(spans).toHaveLength(1);
    expect(cut(text, spans)).toEqual(['espera\u2026 ya']);
    // El tramo es el del carácter original, no tres posiciones de más.
    expect(spans[0]).toEqual({ start: 0, end: text.length });
  });

  it('descarta tramos cortados a mitad de una expansión de …', () => {
    // `…` → `...`: los tres caracteres comparten offset de origen.
    expect(findSpans('a\u2026', 'a..', 'unicode')).toEqual([]);
    expect(findSpans('a\u2026b', '..b', 'unicode')).toEqual([]);
    expect(findSpans('a\u2026', 'a...', 'unicode')).toEqual([{ start: 0, end: 2 }]);
    expect(findSpans('a\u2026b', 'a...b', 'unicode')).toEqual([{ start: 0, end: 3 }]);
  });

  it('elimina zero-width del texto y del needle', () => {
    const text = 'foo\u200bbar\u200cbaz\ufeffqux';
    expect(cut(text, findSpans(text, 'foobarbazqux', 'unicode'))).toEqual([text]);
    expect(cut('foobar', findSpans('foobar', 'foo\u200bbar', 'unicode'))).toEqual(['foobar']);
  });

  it('conserva el BOM del principio del texto', () => {
    // Si se comiera el U+FEFF inicial, el tramo empezaría en el offset 1.
    const text = '\ufeffclass A {}';
    const spans = findSpans(text, 'class A', 'unicode');
    expect(spans).toEqual([{ start: 1, end: 8 }]);
    expect(cut(text, spans)).toEqual(['class A']);
  });

  it('los offsets siguen siendo válidos en el texto original', () => {
    const text = 'pre \u201cx\u201d mes \u2014 y\u2026 fin';
    const spans = findSpans(text, 'mes - y... fin', 'unicode');
    expect(spans).toHaveLength(1);
    expect(cut(text, spans)).toEqual(['mes \u2014 y\u2026 fin']);
  });

  it('encuentra varias apariciones sin solapes', () => {
    const text = '\u2018a\u2019 y \u2018a\u2019';
    expect(findSpans(text, "'a'", 'unicode')).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ]);
  });
});

describe('findSpans — nivel trailing-whitespace', () => {
  it('ignora espacios y tabs al final de la línea', () => {
    const text = 'const a = 1;   \nconst b = 2;\t\n';
    expect(cut(text, findSpans(text, 'const a = 1;', 'trailing-whitespace'))).toEqual([
      'const a = 1;   ',
    ]);
  });

  it('varias líneas: cubre de la primera a la última, sin el salto final', () => {
    const text = 'keep\none  \ntwo\t\nthree \nend\n';
    const spans = findSpans(text, 'one\ntwo\nthree', 'trailing-whitespace');
    expect(cut(text, spans)).toEqual(['one  \ntwo\t\nthree ']);
    expect(spans[0].start).toBe('keep\n'.length);
  });

  it('si el needle acaba en salto, el tramo incluye el salto de la última línea', () => {
    const text = 'one  \ntwo \nend\n';
    const withNewline = findSpans(text, 'one\ntwo\n', 'trailing-whitespace');
    const without = findSpans(text, 'one\ntwo', 'trailing-whitespace');
    expect(cut(text, withNewline)).toEqual(['one  \ntwo \n']);
    expect(cut(text, without)).toEqual(['one  \ntwo ']);
  });

  it('con CRLF, el nivel unicode ignora el \\r y casa un old_string con \\n', () => {
    const text = 'const a = \u2018x\u2019;\r\nconst b = 2;\r\n';
    const needle = "const a = 'x';\nconst b = 2;";
    const spans = findSpans(text, needle, 'unicode');
    expect(spans).toHaveLength(1);
    expect(cut(text, spans)).toEqual(['const a = \u2018x\u2019;\r\nconst b = 2;']);
  });

  it('funciona con CRLF sin tocar la comparación de líneas', () => {
    const text = 'one  \r\ntwo \r\nend\r\n';
    const spans = findSpans(text, 'one\ntwo', 'trailing-whitespace');
    expect(cut(text, spans)).toEqual(['one  \r\ntwo ']);
  });

  it('no solapa entre coincidencias consecutivas', () => {
    const text = 'a \na \nb\n';
    expect(findSpans(text, 'a', 'trailing-whitespace')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('un needle que solo son espacios no casa nada', () => {
    expect(findSpans('a  \n\nb\n', '   ', 'trailing-whitespace')).toEqual([]);
    expect(findSpans('a  \n\nb\n', '\n', 'trailing-whitespace')).toEqual([]);
  });
});

describe('locate', () => {
  it('prueba los niveles en orden y devuelve el primero con coincidencias', () => {
    expect(MATCH_LEVELS).toEqual(['exact', 'unicode', 'trailing-whitespace']);
    expect(locate("a 'b'", "a 'b'")?.level).toBe('exact');
    expect(locate('a ‘b’', "a 'b'")?.level).toBe('unicode');
    expect(locate('a  \nb\n', 'a\nb')?.level).toBe('trailing-whitespace');
  });

  it('devuelve null si no casa en ningún nivel', () => {
    expect(locate('hola', 'adios')).toBeNull();
  });

  it('el nivel exacto gana aunque el unicode diese más coincidencias', () => {
    // El needle exacto aparece una vez; normalizado, dos.
    const text = "const x = \u2018a\u2019;\nconst y = 'a';\n";
    expect(findSpans(text, "'a'", 'exact')).toHaveLength(1);
    expect(findSpans(text, "'a'", 'unicode')).toHaveLength(2);
    const found = locate(text, "'a'");
    expect(found?.level).toBe('exact');
    expect(cut(text, found!.spans)).toEqual(["'a'"]);
  });
});

describe('replaceSpans', () => {
  it('reemplaza de derecha a izquierda con offsets del original', () => {
    const text = 'a-b-c';
    expect(
      replaceSpans(
        text,
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
          { start: 4, end: 5 },
        ],
        'XY',
      ),
    ).toBe('XY-XY-XY');
  });

  it('un reemplazo con $&, $$ y $1 sale literal', () => {
    const text = 'echo X\n';
    expect(replaceSpans(text, [{ start: 5, end: 6 }], 'price=$$ m=$& g=$1')).toBe(
      'echo price=$$ m=$& g=$1\n',
    );
  });

  it('sin tramos devuelve el texto tal cual', () => {
    expect(replaceSpans('abc', [], 'X')).toBe('abc');
  });

  it('reescribe el tramo del original, no el texto normalizado', () => {
    const text = 'wait\u2026';
    const spans = findSpans(text, 'wait...', 'unicode');
    expect(replaceSpans(text, spans, 'stop')).toBe('stop');
  });
});

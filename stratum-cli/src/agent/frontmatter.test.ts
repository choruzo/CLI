import { describe, it, expect } from 'vitest';
import { splitFrontmatter, parseYamlBlock } from './frontmatter.js';

describe('splitFrontmatter', () => {
  it('separa frontmatter y cuerpo', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\nCuerpo\n');
    expect(frontmatter.name).toBe('x');
    expect(body.trim()).toBe('Cuerpo');
  });

  it('sin frontmatter, todo es cuerpo', () => {
    const { frontmatter, body } = splitFrontmatter('Solo cuerpo');
    expect(frontmatter).toEqual({});
    expect(body).toBe('Solo cuerpo');
  });
});

describe('parseYamlBlock — escalares de bloque', () => {
  it('`|` conserva los saltos de línea', () => {
    const fm = parseYamlBlock('description: |\n  línea 1\n  línea 2\n');
    expect(fm.description).toBe('línea 1\nlínea 2');
  });

  it('`>` pliega las líneas de un párrafo en una sola', () => {
    const fm = parseYamlBlock('description: >\n  usa esto cuando\n  haya que desplegar\n');
    expect(fm.description).toBe('usa esto cuando haya que desplegar');
  });

  it('`>` separa párrafos por línea en blanco', () => {
    const fm = parseYamlBlock('d: >\n  uno\n  dos\n\n  tres\n');
    expect(fm.d).toBe('uno dos\ntres');
  });

  it('el bloque termina donde vuelve la indentación', () => {
    const fm = parseYamlBlock('d: |\n  texto\nname: after\n');
    expect(fm.d).toBe('texto');
    expect(fm.name).toBe('after');
  });

  it('acepta indicadores de chomping (|- y >-)', () => {
    expect(parseYamlBlock('d: |-\n  x\n').d).toBe('x');
    expect(parseYamlBlock('d: >-\n  x\n  y\n').d).toBe('x y');
  });
});

describe('parseYamlBlock — formas ya usadas por los perfiles', () => {
  it('arrays y objetos inline', () => {
    const fm = parseYamlBlock('allowedTools: [read_file, grep]\nbudget: { maxIterations: 5 }');
    expect(fm.allowedTools).toEqual(['read_file', 'grep']);
    expect(fm.budget).toEqual({ maxIterations: 5 });
  });

  it('secuencias y mapas de bloque', () => {
    const fm = parseYamlBlock(
      'allowedTools:\n  - read_file\n  - grep\nbudget:\n  maxIterations: 5',
    );
    expect(fm.allowedTools).toEqual(['read_file', 'grep']);
    expect(fm.budget).toEqual({ maxIterations: 5 });
  });

  it('booleanos, números y comillas', () => {
    const fm = parseYamlBlock('a: true\nb: 12\nc: "12"\n# comentario\n');
    expect(fm.a).toBe(true);
    expect(fm.b).toBe(12);
    expect(fm.c).toBe('12');
  });
});

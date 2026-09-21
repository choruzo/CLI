import { describe, expect, it } from 'vitest';
import { EMPTY_SPLIT, isClosedFence, splitBlocks } from './blocks';

const DOC = '# Título\n\nUn párrafo.\n\n```ts\nconst a = 1;\n```\n\n- uno\n- dos\n';

describe('splitBlocks', () => {
  it('trocea en bloques de primer nivel sin perder texto', () => {
    const { blocks } = splitBlocks(DOC);
    expect(blocks.map((b) => b.raw.trim())).toEqual([
      '# Título',
      'Un párrafo.',
      '```ts\nconst a = 1;\n```',
      '- uno\n- dos',
    ]);
    expect(blocks.map((b) => b.raw).join('')).toBe(DOC);
    for (const b of blocks) expect(DOC.slice(b.offset, b.offset + b.raw.length)).toBe(b.raw);
  });

  it('streaming carácter a carácter da el mismo troceo que de una vez', () => {
    let state = EMPTY_SPLIT;
    for (let i = 1; i <= DOC.length; i++) state = splitBlocks(DOC.slice(0, i), state);
    expect(state.blocks).toEqual(splitBlocks(DOC).blocks);
  });

  it('conserva la identidad de los bloques estables al añadir un delta', () => {
    const a = splitBlocks('Primero.\n\nSegundo');
    const b = splitBlocks('Primero.\n\nSegundo y más', a);
    expect(b.blocks[0]).toBe(a.blocks[0]);
    expect(b.blocks[1].raw).toBe('Segundo y más');
  });

  it('un párrafo que pasa a encabezado setext se re-lexa', () => {
    const a = splitBlocks('Intro\n\nTítulo\n');
    const b = splitBlocks('Intro\n\nTítulo\n---\n', a);
    expect(b.blocks.map((x) => x.raw.trim())).toEqual(['Intro', 'Título\n---']);
  });

  it('un texto que no extiende al anterior se re-lexa entero', () => {
    const a = splitBlocks('uno\n\ndos');
    const b = splitBlocks('otro', a);
    expect(b.blocks).toEqual([{ raw: 'otro', offset: 0 }]);
  });
});

describe('isClosedFence', () => {
  it('distingue una valla cerrada de una abierta', () => {
    expect(isClosedFence('```ts\nconst a = 1;\n```\n\n')).toBe(true);
    expect(isClosedFence('~~~\nx\n~~~')).toBe(true);
    expect(isClosedFence('```ts\nconst a = 1;\n')).toBe(false);
    expect(isClosedFence('```ts')).toBe(false);
    expect(isClosedFence('texto normal')).toBe(false);
  });
});

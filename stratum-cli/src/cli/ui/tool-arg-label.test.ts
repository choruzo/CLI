import { describe, expect, it } from 'vitest';
import { labelOf, primaryArg, tailWindow } from './tool-arg-label.js';

describe('primaryArg', () => {
  it('prefiere el argumento que identifica la llamada al primero', () => {
    expect(primaryArg({ limit: 700, offset: 1, path: 'apuntes/ud1.md' })).toBe('apuntes/ud1.md');
    expect(primaryArg({ target: 'local', command: 'ls -la' })).toBe('ls -la');
  });

  it('sin argumento conocido usa el primero, y sin argumentos nada', () => {
    expect(primaryArg({ limit: 700 })).toBe('700');
    expect(primaryArg({})).toBe('');
    expect(primaryArg(undefined)).toBe('');
  });

  it('un array de objetos enseña su primer texto y cuántos más hay', () => {
    const questions = [{ question: '¿Formato?', options: [] }, { question: '¿Fechas?' }];
    expect(primaryArg({ questions })).toBe('¿Formato? (+1)');
    expect(labelOf([{ n: 1 }])).toBe('{"n":1}');
  });
});

describe('tailWindow', () => {
  it('conserva las últimas y cuenta las que oculta', () => {
    expect(tailWindow([1, 2, 3, 4, 5], 2)).toEqual({ hidden: 3, visible: [4, 5] });
    expect(tailWindow([1, 2], 4)).toEqual({ hidden: 0, visible: [1, 2] });
  });
});

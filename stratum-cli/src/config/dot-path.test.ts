import { describe, it, expect } from 'vitest';
import { getByDotPath, setByDotPath, formatConfigValue } from './dot-path.js';

describe('getByDotPath', () => {
  const cfg = {
    provider: { default: 'ollama', contextWindow: 32768 },
    tools: { webSearch: { backend: 'meta' } },
  };

  it('resuelve claves anidadas', () => {
    expect(getByDotPath(cfg, 'provider.default')).toBe('ollama');
    expect(getByDotPath(cfg, 'tools.webSearch.backend')).toBe('meta');
  });

  it('devuelve el objeto entero para una clave intermedia', () => {
    expect(getByDotPath(cfg, 'tools.webSearch')).toEqual({ backend: 'meta' });
  });

  it('devuelve undefined si algún tramo no existe', () => {
    expect(getByDotPath(cfg, 'provider.noExiste')).toBeUndefined();
    expect(getByDotPath(cfg, 'nada.de.nada')).toBeUndefined();
  });
});

describe('setByDotPath', () => {
  it('escribe una clave existente', () => {
    const obj: Record<string, unknown> = { provider: { default: 'ollama' } };
    setByDotPath(obj, 'provider.default', 'litellm');
    expect(obj).toEqual({ provider: { default: 'litellm' } });
  });

  it('crea los objetos intermedios que falten', () => {
    const obj: Record<string, unknown> = {};
    setByDotPath(obj, 'a.b.c', 'v');
    expect(obj).toEqual({ a: { b: { c: 'v' } } });
  });

  it('coerciona booleanos y números que llegan como string', () => {
    const obj: Record<string, unknown> = {};
    setByDotPath(obj, 'flag', 'true');
    setByDotPath(obj, 'off', 'false');
    setByDotPath(obj, 'n', '42');
    setByDotPath(obj, 'f', '1.5');
    expect(obj).toEqual({ flag: true, off: false, n: 42, f: 1.5 });
  });

  it('no coerciona una cadena no numérica ni la cadena vacía', () => {
    const obj: Record<string, unknown> = {};
    setByDotPath(obj, 'name', 'qwen2.5-coder');
    setByDotPath(obj, 'empty', '');
    expect(obj).toEqual({ name: 'qwen2.5-coder', empty: '' });
  });

  it('sustituye un tramo intermedio que no era objeto', () => {
    const obj: Record<string, unknown> = { a: 'escalar' };
    setByDotPath(obj, 'a.b', 'v');
    expect(obj).toEqual({ a: { b: 'v' } });
  });
});

describe('formatConfigValue', () => {
  it('serializa objetos como JSON indentado', () => {
    expect(formatConfigValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('convierte escalares a string', () => {
    expect(formatConfigValue('x')).toBe('x');
    expect(formatConfigValue(42)).toBe('42');
    expect(formatConfigValue(null)).toBe('null');
  });
});

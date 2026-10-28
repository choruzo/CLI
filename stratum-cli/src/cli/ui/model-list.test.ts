import { describe, expect, it } from 'vitest';
import { formatWindow, modelHint } from './model-list.js';

describe('model-list', () => {
  it('ventana legible', () => {
    expect(formatWindow(128_000)).toBe('128K');
    expect(formatWindow(32_768)).toBe('32.8K');
    expect(formatWindow(8_000)).toBe('8K');
    expect(formatWindow(1_000_000)).toBe('1M');
    expect(formatWindow(1_048_576)).toBe('1M');
    expect(formatWindow(1_500_000)).toBe('1.5M');
  });

  it('solo lo que el backend declara', () => {
    expect(modelHint(undefined, false)).toBeUndefined();
    expect(modelHint({ id: 'a' }, true)).toBe('actual');
    expect(modelHint({ id: 'a', contextWindow: 131_072, reasoning: true }, false)).toBe(
      '131K ctx · razona',
    );
    expect(modelHint({ id: 'a', reasoning: false }, false)).toBeUndefined();
  });
});

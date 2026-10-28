import { describe, expect, it } from 'vitest';
import { RepeatTracker, formatRepeatNotice } from './repeat.js';

describe('RepeatTracker', () => {
  it('el orden de las claves no cambia la llamada', () => {
    const t = new RepeatTracker();
    expect(t.observe('grep', { pattern: 'x', path: 'src' })).toBe(0);
    expect(t.observe('grep', { path: 'src', pattern: 'x' })).toBe(1);
  });

  it('las tools de jobs no cuentan ni cierran la ventana', () => {
    const t = new RepeatTracker();
    t.observe('read_file', { path: 'a' });
    expect(t.observe('get_job_output', { jobId: '1' })).toBe(0);
    expect(t.observe('get_job_output', { jobId: '1' })).toBe(0);
    expect(t.observe('read_file', { path: 'a' })).toBe(1);
  });

  it('reset cierra la ventana', () => {
    const t = new RepeatTracker();
    t.observe('read_file', { path: 'a' });
    t.reset();
    expect(t.observe('read_file', { path: 'a' })).toBe(0);
  });
});

describe('formatRepeatNotice', () => {
  it('nombra la tool, nunca los argumentos', () => {
    const text = formatRepeatNotice([{ tool: 'exec', count: 2 }]);
    expect(text).toMatch(/^<repeated_tool_call>\n/);
    expect(text).toContain('`exec`');
    expect(text).toContain('2 earlier calls');
    expect(text).toMatch(/<\/repeated_tool_call>$/);
  });
});

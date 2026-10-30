import { describe, expect, it } from 'vitest';
import { ScreenshotBuffer, SCREENSHOTS_IN_CONTEXT } from './screenshots.js';
import type { Message, ToolImage } from './types.js';

function image(n: number): ToolImage {
  return {
    mime: 'image/png',
    data: `data${n}`,
    width: 1280,
    height: 800,
    bytes: 10,
    sha256: String(n).repeat(64).slice(0, 64),
  };
}

const tool = (id: string): Message => ({ role: 'tool', tool_call_id: id, content: 'Screenshot' });

describe('ScreenshotBuffer', () => {
  it('solo conserva las últimas (2 por defecto)', () => {
    const buf = new ScreenshotBuffer();
    expect(SCREENSHOTS_IN_CONTEXT).toBe(2);
    for (const n of [1, 2, 3]) buf.add(`c${n}`, image(n));
    expect(buf.size).toBe(2);
    const sent = buf.forRequest([tool('c1'), tool('c2'), tool('c3')]);
    expect(sent.map((s) => s.toolCallId)).toEqual(['c2', 'c3']);
  });

  it('no manda una captura cuyo resultado ya no está en el historial (compactado)', () => {
    const buf = new ScreenshotBuffer();
    buf.add('c1', image(1));
    buf.add('c2', image(2));
    expect(buf.forRequest([tool('c2')]).map((s) => s.toolCallId)).toEqual(['c2']);
    expect(buf.forRequest([{ role: 'user', content: 'c1' }])).toEqual([]);
  });

  it('clear las suelta', () => {
    const buf = new ScreenshotBuffer(1);
    buf.add('c1', image(1));
    buf.clear();
    expect(buf.forRequest([tool('c1')])).toEqual([]);
  });
});

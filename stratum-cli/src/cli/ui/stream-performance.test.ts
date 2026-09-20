import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../agent/types.js';
import { limitLiveText } from './StreamingText.js';
import {
  appendTranscriptEvent,
  createTranscriptEventLog,
  transcriptEventsInOrder,
} from './SubagentView.js';

describe('stream performance primitives', () => {
  it('bounds live text by visual rows even when the stream contains many newlines', () => {
    const visible = limitLiveText(Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n'), 40, 5);
    expect(visible.split('\n')).toHaveLength(5);
    expect(visible).toContain('line-99');
    expect(visible).not.toContain('line-0\n');
  });

  it('appends a large subagent transcript in O(1) storage operations and preserves order', () => {
    const log = createTranscriptEventLog();
    for (let i = 0; i < 10_000; i++) {
      appendTranscriptEvent(log, { type: 'text_delta', delta: String(i) });
    }
    expect(log.length).toBe(10_000);
    const ordered = transcriptEventsInOrder(log);
    expect((ordered[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('0');
    expect((ordered.at(-1) as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('9999');
  });
});

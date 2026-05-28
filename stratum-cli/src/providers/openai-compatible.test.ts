import { describe, it, expect } from 'vitest';
import { StreamBuffer } from './openai-compatible.js';
import type { OpenAIStreamChunk } from './base.js';

function textChunk(content: string, finish: string | null = null): OpenAIStreamChunk {
  return { choices: [{ delta: { content }, finish_reason: finish, index: 0 }] };
}

function toolChunk(
  index: number,
  id?: string,
  name?: string,
  args?: string,
  finish: string | null = null,
): OpenAIStreamChunk {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index,
          ...(id ? { id } : {}),
          type: 'function',
          function: {
            ...(name ? { name } : {}),
            ...(args !== undefined ? { arguments: args } : {}),
          },
        }],
      },
      finish_reason: finish,
      index: 0,
    }],
  };
}

function finishToolChunk(): OpenAIStreamChunk {
  return { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] };
}

describe('StreamBuffer', () => {
  it('emits text_delta for text content', () => {
    const buf = new StreamBuffer();
    const events = buf.feed(textChunk('hello '));
    expect(events).toEqual([{ type: 'text_delta', delta: 'hello ' }]);
  });

  it('accumulates fragmented tool call arguments', () => {
    const buf = new StreamBuffer();

    const e1 = buf.feed(toolChunk(0, 'call1', 'read_file', '{"path":'));
    const e2 = buf.feed(toolChunk(0, undefined, undefined, '"/tmp/test"}'));
    const e3 = buf.feed(finishToolChunk());

    // First fragment: tool_call_start emitted twice (initial + update)
    const starts = e1.filter(e => e.type === 'tool_call_start');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts[0]).toMatchObject({ type: 'tool_call_start', id: 'call1', name: 'read_file' });

    // Second fragment: updated start
    expect(e2.some(e => e.type === 'tool_call_start')).toBe(true);

    // Finish: tool_call_ready with parsed input
    expect(e3).toEqual([{
      type: 'tool_call_ready',
      id: 'call1',
      name: 'read_file',
      input: { path: '/tmp/test' },
    }]);
  });

  it('handles two parallel tool calls (index 0 and 1)', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'read_file', '{"path":"/a"}'));
    buf.feed(toolChunk(1, 'c1', 'bash', '{"command":"ls"}'));
    const finish = buf.feed(finishToolChunk());

    const ready = finish.filter(e => e.type === 'tool_call_ready');
    expect(ready).toHaveLength(2);
    const names = ready.map(e => (e as { name: string }).name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
  });

  it('emits tool_error for invalid JSON arguments', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'bash', '{invalid json'));
    const finish = buf.feed(finishToolChunk());

    expect(finish).toEqual([{
      type: 'tool_error',
      id: 'c0',
      name: 'bash',
      error: expect.stringContaining('Invalid JSON'),
      recoverable: false,
    }]);
  });

  it('resets state after clear', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'bash', '{"command":"ls"}'));
    buf.reset();
    // After reset, finish_reason should not emit any ready calls
    const events = buf.feed(finishToolChunk());
    const ready = events.filter(e => e.type === 'tool_call_ready');
    expect(ready).toHaveLength(0);
  });
});

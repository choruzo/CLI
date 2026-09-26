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
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              ...(id ? { id } : {}),
              type: 'function',
              function: {
                ...(name ? { name } : {}),
                ...(args !== undefined ? { arguments: args } : {}),
              },
            },
          ],
        },
        finish_reason: finish,
        index: 0,
      },
    ],
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
    const starts = e1.filter((e) => e.type === 'tool_call_start');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts[0]).toMatchObject({ type: 'tool_call_start', id: 'call1', name: 'read_file' });

    // Second fragment: updated start
    expect(e2.some((e) => e.type === 'tool_call_start')).toBe(true);

    // Finish: tool_call_ready with parsed input
    expect(e3).toEqual([
      {
        type: 'tool_call_ready',
        id: 'call1',
        name: 'read_file',
        input: { path: '/tmp/test' },
      },
    ]);
  });

  it('handles two parallel tool calls (index 0 and 1)', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'read_file', '{"path":"/a"}'));
    buf.feed(toolChunk(1, 'c1', 'bash', '{"command":"ls"}'));
    const finish = buf.feed(finishToolChunk());

    const ready = finish.filter((e) => e.type === 'tool_call_ready');
    expect(ready).toHaveLength(2);
    const names = ready.map((e) => (e as { name: string }).name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
  });

  it('emits tool_error for invalid JSON arguments', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'bash', '{invalid json'));
    const finish = buf.feed(finishToolChunk());

    expect(finish).toEqual([
      {
        type: 'tool_error',
        id: 'c0',
        name: 'bash',
        error: expect.stringContaining('Invalid JSON'),
        recoverable: false,
      },
    ]);
  });

  it('resets state after clear', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'bash', '{"command":"ls"}'));
    buf.reset();
    // After reset, finish_reason should not emit any ready calls
    const events = buf.feed(finishToolChunk());
    const ready = events.filter((e) => e.type === 'tool_call_ready');
    expect(ready).toHaveLength(0);
  });
});

describe('StreamBuffer — razonamiento', () => {
  const delta = (d: Record<string, unknown>, finish: string | null = null) =>
    ({ choices: [{ delta: d, finish_reason: finish, index: 0 }] }) as never;

  function run(chunks: string[]) {
    const buf = new StreamBuffer();
    const events = chunks.flatMap((c) => buf.feed(delta({ content: c })));
    events.push(...buf.feed(delta({}, 'stop')));
    const join = (t: 'thinking' | 'text_delta') =>
      events
        .filter((e) => e.type === t)
        .map((e) => (e.type === 'thinking' ? e.text : e.type === 'text_delta' ? e.delta : ''))
        .join('');
    return { thinking: join('thinking'), text: join('text_delta') };
  }

  it('emite thinking desde reasoning_content y reasoning, sin tocar el texto', () => {
    const buf = new StreamBuffer();
    expect(buf.feed(delta({ reasoning_content: 'Primero ' }))).toEqual([
      { type: 'thinking', text: 'Primero ' },
    ]);
    expect(buf.feed(delta({ reasoning: 'luego' }))).toEqual([{ type: 'thinking', text: 'luego' }]);
    expect(buf.feed(delta({ content: '391' }))).toEqual([{ type: 'text_delta', delta: '391' }]);
  });

  it('separa un <think> inicial aunque los tags lleguen partidos', () => {
    expect(run(['<thi', 'nk>17*23', ' = 391</th', 'ink>\n\nSon 391.'])).toEqual({
      thinking: '17*23 = 391',
      text: 'Son 391.',
    });
  });

  it('admite espacio antes del tag de apertura', () => {
    expect(run(['\n', '  <think>a</think>b'])).toEqual({ thinking: 'a', text: 'b' });
  });

  it('un <think> que no está al principio es texto', () => {
    expect(run(['Usa ', '<think> en el prompt'])).toEqual({
      thinking: '',
      text: 'Usa <think> en el prompt',
    });
  });

  it('un < inicial que no acaba en tag se suelta como texto', () => {
    expect(run(['<', 'div>hola</div>'])).toEqual({ thinking: '', text: '<div>hola</div>' });
    expect(run(['<'])).toEqual({ thinking: '', text: '<' });
  });

  it('un bloque sin cerrar sale entero como razonamiento al terminar', () => {
    expect(run(['<think>sin cierre </th'])).toEqual({ thinking: 'sin cierre </th', text: '' });
  });

  it('tras el cierre, otro <think> es texto', () => {
    expect(run(['<think>x</think>y <think>z</think>'])).toEqual({
      thinking: 'x',
      text: 'y <think>z</think>',
    });
  });

  it('reset olvida el estado del intento anterior', () => {
    const buf = new StreamBuffer();
    buf.feed(delta({ content: '<think>a' }));
    buf.reset();
    expect(buf.feed(delta({ content: 'hola' }))).toEqual([{ type: 'text_delta', delta: 'hola' }]);
  });
});

describe('StreamBuffer — cierre de tool calls', () => {
  it('materializa las tool calls también con finish_reason "stop"', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'read_file', '{"path":"a.txt"}'));
    const events = buf.feed(textChunk('', 'stop'));
    expect(events).toContainEqual({
      type: 'tool_call_ready',
      id: 'c0',
      name: 'read_file',
      input: { path: 'a.txt' },
    });
  });

  it('con finish_reason "length" la llamada cortada es un error, no se pierde', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'write_file', '{"path":"a.txt","content":"mucho'));
    const events = buf.feed(textChunk('', 'length'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_error', id: 'c0', name: 'write_file' });
    expect((events[0] as { error: string }).error).toContain('output token limit');
  });

  it('finish() cierra las que ningún finish_reason cerró', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'glob', '{"pattern":"*.ts"}'));
    expect(buf.finish()).toEqual([
      { type: 'tool_call_ready', id: 'c0', name: 'glob', input: { pattern: '*.ts' } },
    ]);
    // Idempotente: ya no queda nada abierto.
    expect(buf.finish()).toEqual([]);
  });

  it('finish() con argumentos a medias (conexión cortada) da un error de parseo', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'glob', '{"pattern":"*.t'));
    const [ev] = buf.finish();
    expect(ev).toMatchObject({ type: 'tool_error', id: 'c0' });
  });

  it('finish() suelta el texto retenido por el splitter de <think>', () => {
    const buf = new StreamBuffer();
    expect(buf.feed(textChunk('<thi'))).toEqual([]);
    expect(buf.finish()).toEqual([{ type: 'text_delta', delta: '<thi' }]);
  });

  it('argumentos vacíos equivalen a {}', () => {
    const buf = new StreamBuffer();
    buf.feed(toolChunk(0, 'c0', 'todo', ''));
    expect(buf.feed(finishToolChunk())).toEqual([
      { type: 'tool_call_ready', id: 'c0', name: 'todo', input: {} },
    ]);
  });

  it.each(['null', '[1,2]', '42', '"texto"'])(
    'argumentos que no son un objeto (%s) son un error de parseo',
    (args) => {
      const buf = new StreamBuffer();
      buf.feed(toolChunk(0, 'c0', 'exec', args));
      const [ev] = buf.feed(finishToolChunk());
      expect(ev).toMatchObject({ type: 'tool_error', id: 'c0' });
      expect((ev as { error: string }).error).toContain('must be a JSON object');
    },
  );
});

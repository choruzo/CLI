import { describe, expect, it } from 'vitest';
import { errorHeadline, type ToolCallState } from './ToolCallBlock.js';

function failed(
  name: string,
  errorMsg: string,
  input: Record<string, unknown> = {},
): ToolCallState {
  return { id: 'c1', name, status: 'error', errorMsg, input };
}

describe('errorHeadline', () => {
  it('de un exec fallido enseña el código de salida y el comando, no el sobre', () => {
    const msg =
      '<exec_result target="local" status="exited" exitCode="3" duration="36ms" cwd="/home" maxBytes="1">\n  <stdout></stdout>';
    expect(errorHeadline(failed('exec', msg, { command: 'systemctl status x' }))).toBe(
      'exit 3 │ systemctl status x',
    );
  });

  it('distingue timeout y cancelado', () => {
    const msg = (status: string) =>
      `<exec_result target="local" status="${status}" exitCode="unknown" duration="1ms">`;
    expect(errorHeadline(failed('exec', msg('timeout'), { command: 'sleep 99' }))).toBe(
      'timeout │ sleep 99',
    );
    expect(errorHeadline(failed('exec', msg('cancelled')))).toBe('cancelado');
  });

  it('cualquier otro error: su primera línea', () => {
    expect(errorHeadline(failed('write', 'Tool "write" not found\nmás'))).toBe(
      'Tool "write" not found',
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { ToolCallState } from './ToolCallBlock.js';
import {
  describeActionTools,
  describeGroup,
  groupTargets,
  groupToolCalls,
  shortLabel,
  summarizeActions,
} from './tool-groups.js';

let n = 0;
function call(
  name: string,
  input: Record<string, unknown> = {},
  status: ToolCallState['status'] = 'completed',
): ToolCallState {
  n++;
  return { id: `c${n}`, name, status, input };
}

describe('groupToolCalls', () => {
  it('agrupa una racha de lecturas y búsquedas terminadas', () => {
    const calls = [
      call('read_file', { path: 'a.ts' }),
      call('grep', { pattern: 'x' }),
      call('read_file', { path: 'b.ts' }),
    ];
    const rows = groupToolCalls(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', calls });
  });

  it('una escritura, un comando o un error cortan la racha', () => {
    const rows = groupToolCalls([
      call('read_file'),
      call('read_file'),
      call('edit_file'),
      call('read_file'),
      call('read_file', {}, 'error'),
      call('glob'),
      call('exec'),
    ]);
    expect(rows.map((r) => (r.kind === 'group' ? `g${r.calls.length}` : r.call.name))).toEqual([
      'g2',
      'edit_file',
      'read_file',
      'read_file',
      'glob',
      'exec',
    ]);
  });

  it('una sola lectura no se agrupa', () => {
    expect(groupToolCalls([call('read_file')])[0]?.kind).toBe('call');
  });
});

describe('describeGroup', () => {
  it('cuenta por familia en orden fijo y con plural', () => {
    const calls = [
      call('grep'),
      call('read_file'),
      call('web_fetch'),
      call('list_directory'),
      call('glob'),
    ];
    expect(describeGroup(calls)).toBe('2 lecturas · 2 búsquedas · 1 consulta web');
  });
});

describe('groupTargets', () => {
  it('lista los objetivos sin repetir y resume lo que no cabe', () => {
    const calls = [
      call('read_file', { path: 'src/a.ts' }),
      call('read_file', { path: 'src/a.ts' }),
      call('read_file', { path: 'src/b.ts' }),
      call('grep', { pattern: 'TODO' }),
    ];
    expect(groupTargets(calls, 80)).toBe('src/a.ts, src/b.ts, TODO');
    expect(groupTargets(calls, 14)).toBe('src/a.ts, +2');
    expect(groupTargets(calls, 3)).toBe('+3');
  });

  it('recorta las rutas largas por la izquierda', () => {
    const long = 'stratum-cli/src/cli/ui/components/very/deep/folder/MaskedInput.tsx';
    expect(shortLabel(long)).toBe('…/folder/MaskedInput.tsx');
    expect(shortLabel('corto.ts')).toBe('corto.ts');
  });
});

describe('summarizeActions', () => {
  it('cuenta por tool, de la más usada a la menos, y los fallos', () => {
    const calls = [
      call('read_file'),
      call('exec'),
      call('exec', {}, 'error'),
      call('exec'),
      call('write_file'),
    ];
    const summary = summarizeActions(calls);
    expect(summary).toEqual({
      total: 5,
      failed: 1,
      byTool: [
        ['exec', 3],
        ['read_file', 1],
        ['write_file', 1],
      ],
    });
    expect(describeActionTools(summary)).toBe('3 exec · 1 read_file · 1 write_file');
    expect(describeActionTools(summary, 1)).toBe('3 exec · +2');
  });
});

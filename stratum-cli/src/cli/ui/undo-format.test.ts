import { describe, expect, it } from 'vitest';
import {
  ago,
  describeUndoableTurn,
  fileHint,
  lineDelta,
  revertFailureText,
  turnChangesText,
  type UndoableTurnView,
} from './undo-format.js';

const now = Date.parse('2026-10-23T10:00:00Z');
const turn: UndoableTurnView = {
  turn: 5,
  endedAt: '2026-10-23T09:57:00Z',
  files: [
    { path: 'src/cli/ui/App.tsx', status: 'modified', additions: 10, deletions: 3 },
    { path: 'src/theme.ts', status: 'added', additions: 2, deletions: 0 },
    { path: 'logo.png', status: 'modified' },
    { path: 'old.ts', status: 'deleted', additions: 0, deletions: 7 },
  ],
};

describe('undo-format', () => {
  it('tiempo relativo', () => {
    expect(ago('2026-10-23T09:59:20Z', now)).toBe('hace 40 s');
    expect(ago('2026-10-23T09:57:00Z', now)).toBe('hace 3 min');
    expect(ago('2026-10-23T07:00:00Z', now)).toBe('hace 3 h');
    expect(ago('2026-10-20T10:00:00Z', now)).toBe('hace 3 d');
  });

  it('suma de líneas sin contar binarios como 0', () => {
    expect(lineDelta(turn.files)).toBe('+12 −10');
    expect(lineDelta([{ path: 'a.png', status: 'modified' }])).toBe('');
  });

  it('fila del selector y pista de ficheros', () => {
    expect(describeUndoableTurn(turn, now)).toBe('turno 5 · hace 3 min · 4 ficheros · +12 −10');
    expect(fileHint(turn)).toBe('App.tsx, theme.ts, logo.png, +1');
  });

  it('cambios del turno al pie: sin ficheros no hay segmento', () => {
    expect(turnChangesText(turn.files)).toBe('✎ 4 ficheros · +12 −10');
    expect(turnChangesText([{ path: 'a.png', status: 'modified' }])).toBe('✎ 1 fichero');
    expect(turnChangesText([])).toBeNull();
  });

  it('motivos de fallo legibles', () => {
    expect(revertFailureText('conflicts', ['a', 'b'])).toMatch(/2 fichero/);
    expect(revertFailureText('turn-in-progress')).toMatch(/turno en curso/);
    expect(revertFailureText('raro')).toMatch(/\/changes/);
  });
});

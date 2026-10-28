import { describe, expect, it } from 'vitest';
import {
  createTranscriptEventLog,
  findSubagent,
  subagentViewWindow,
  type SubagentTranscript,
} from './SubagentView.js';

const t = (profile: string, n: number): SubagentTranscript => ({
  id: `${profile}-${n}`,
  profile,
  n,
  task: 'x',
  status: 'completed',
  events: createTranscriptEventLog(),
});

describe('ventana de subagente', () => {
  const list = [t('explorer', 1), t('general', 2), t('explorer', 3)];

  it('/subagents <consulta>: perfil#n, posición o el último del perfil', () => {
    expect(findSubagent(list, 'general#2')?.id).toBe('general-2');
    expect(findSubagent(list, 'EXPLORER#1')?.id).toBe('explorer-1');
    expect(findSubagent(list, '2')?.id).toBe('general-2');
    expect(findSubagent(list, '#3')?.id).toBe('explorer-3');
    expect(findSubagent(list, 'explorer')?.id).toBe('explorer-3');
    expect(findSubagent(list, 'nadie')).toBeUndefined();
    expect(findSubagent(list, '9')).toBeUndefined();
  });

  it('lo que se pinta cabe en la pantalla', () => {
    for (const rows of [16, 24, 40]) {
      for (const [actions, lines] of [
        [0, 0],
        [3, 2],
        [40, 200],
      ] as const) {
        const w = subagentViewWindow(rows, actions, lines);
        expect(w.actions).toBeLessThanOrEqual(actions);
        expect(w.textLines).toBeLessThanOrEqual(lines);
        // Fijas (11) + acciones + «… anteriores» + texto + «…».
        if (rows >= 24) expect(11 + w.actions + 1 + w.textLines + 1).toBeLessThanOrEqual(rows);
      }
    }
  });
});

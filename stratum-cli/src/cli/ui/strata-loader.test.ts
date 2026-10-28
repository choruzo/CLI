import { describe, expect, it } from 'vitest';
import {
  STRATA_FRAMES,
  liveAction,
  liveThinkingPhase,
  toolIcon,
  shimmerParts,
  strataFrameAt,
  strataIntervalMs,
} from './strata-loader.js';

describe('strata-loader', () => {
  it('cada frame ocupa dos celdas braille y la secuencia empieza vacía', () => {
    for (const f of STRATA_FRAMES) {
      expect([...f]).toHaveLength(2);
      for (const ch of f) expect(ch.charCodeAt(0) & 0xff00).toBe(0x2800);
    }
    expect(STRATA_FRAMES[0]).toBe('⠀⠀');
  });

  it('las tres capas llegan a posarse juntas', () => {
    expect(STRATA_FRAMES).toContain('⣶⣶');
  });

  it('el frame depende solo del reloj y la fase acelera con una tool', () => {
    expect(strataIntervalMs('tool')).toBeLessThan(strataIntervalMs('waiting'));
    expect(strataFrameAt(0, 'waiting')).toBe(STRATA_FRAMES[0]);
    expect(strataFrameAt(strataIntervalMs('waiting') * 4, 'waiting')).toBe(STRATA_FRAMES[4]);
    expect(strataFrameAt(strataIntervalMs('tool') * STRATA_FRAMES.length, 'tool')).toBe(
      STRATA_FRAMES[0],
    );
  });

  it('el brillo recorre la frase sin perder caracteres', () => {
    const text = 'Sedimentando…';
    let lit = 0;
    for (let t = 0; t < 5_000; t += 90) {
      const parts = shimmerParts(text, t);
      expect(parts.join('')).toBe(text);
      expect([...parts[1]].length).toBeLessThanOrEqual(3);
      if (parts[1]) lit++;
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('la acción en curso: la primera tool que corre, luego un subagente', () => {
    expect(liveAction(null)).toBeNull();
    expect(liveAction({ toolCalls: [{ status: 'completed', name: 'grep' }] })).toBeNull();
    const a = liveAction({
      toolCalls: [
        { status: 'completed', name: 'grep' },
        { status: 'running', name: 'exec', startedAt: 5 },
      ],
      subagents: [{ status: 'running', profile: 'explorer', n: 1 }],
    });
    expect(a).toMatchObject({ icon: '❯', name: 'exec', toolIndex: 1, startedAt: 5, others: 1 });
    expect(
      liveAction({
        subagents: [{ status: 'running', profile: 'explorer', n: 2, task: 'mira\nesto' }],
      }),
    ).toMatchObject({ icon: '⊳', name: 'explorer#2', detail: 'mira esto', others: 0 });
  });

  it('icono por familia de tool', () => {
    expect(toolIcon('read_file')).toBe('▤');
    expect(toolIcon('grep')).toBe('⌕');
    expect(toolIcon('web_search')).toBe('◍');
    expect(toolIcon('edit_file')).toBe('✎');
    expect(toolIcon('exec')).toBe('❯');
    expect(toolIcon('otra')).toBe('◆');
  });

  it('la fase sale del turno vivo', () => {
    expect(liveThinkingPhase(null)).toBe('waiting');
    expect(liveThinkingPhase({ toolCalls: [{ status: 'completed' }] })).toBe('waiting');
    expect(liveThinkingPhase({ toolCalls: [{ status: 'running' }] })).toBe('tool');
    expect(liveThinkingPhase({ subagents: [{ status: 'running' }] })).toBe('tool');
    expect(liveThinkingPhase({ thinkingOpen: true })).toBe('reasoning');
  });
});

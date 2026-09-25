import { describe, expect, it } from 'vitest';
import { reducer, type AgentConvItem, type AppAction, type AppState } from './App.js';

/** Estado mínimo con un turno del agente en marcha. */
function started(): AppState {
  return reducer({ completedItems: [], currentItem: null } as unknown as AppState, {
    type: 'AGENT_START',
    input: 'hola',
  });
}

const ev = (event: Extract<AppAction, { type: 'AGENT_EVENT' }>['event']): AppAction => ({
  type: 'AGENT_EVENT',
  event,
});

function agent(state: AppState): AgentConvItem {
  return state.currentItem as AgentConvItem;
}

describe('razonamiento en el reducer de la CLI (D7)', () => {
  it('agrupa fragmentos consecutivos y los guarda también sin /debug', () => {
    const s = [
      ev({ type: 'thinking', text: 'Primero ' }),
      ev({ type: 'thinking', text: 'esto' }),
      ev({ type: 'text_delta', delta: 'Hola' }),
      ev({ type: 'thinking', text: 'otra idea' }),
    ].reduce(reducer, started());
    expect(agent(s).thinkingBlocks).toEqual(['Primero esto', 'otra idea']);
    expect(agent(s).thinkingOpen).toBe(true);
    expect(agent(s).text).toBe('Hola');
  });

  it('una tool call también cierra el bloque', () => {
    const s = [
      ev({ type: 'thinking', text: 'busco' }),
      ev({ type: 'tool_call_start', id: 'c1', name: 'read_file', input_so_far: '' }),
      ev({ type: 'thinking', text: 'leo' }),
    ].reduce(reducer, started());
    expect(agent(s).thinkingBlocks).toEqual(['busco', 'leo']);
  });
});

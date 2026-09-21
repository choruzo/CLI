import { describe, expect, it } from 'vitest';
import {
  conversationReducer as reduce,
  initialConversationState,
  userTextOf,
  type AgentTurn,
  type ConversationAction,
  type ConversationState,
} from './conversation-reducer';
import type { AgentEvent } from '../../../stratum-cli/src/agent/events';

const T = 'turn-1';

function run(actions: ConversationAction[], state = initialConversationState): ConversationState {
  return actions.reduce(reduce, state);
}

const ev = (event: AgentEvent): ConversationAction => ({ type: 'agent_event', turnId: T, event });

function agentTurn(state: ConversationState): AgentTurn {
  const t = state.messages.find((m) => m.role === 'agent');
  if (!t || t.role !== 'agent') throw new Error('sin turno');
  return t;
}

const started = run([{ type: 'user_sent', turnId: T, text: 'hola' }]);

describe('conversationReducer', () => {
  it('un mensaje abre turno de usuario + turno del agente en streaming', () => {
    expect(started.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(started.activeTurnId).toBe(T);
    expect(agentTurn(started).status).toBe('streaming');
  });

  it('acumula texto y lo intercala con los tool calls en orden de llegada', () => {
    const s = run(
      [
        ev({ type: 'text_delta', delta: 'Busco' }),
        ev({ type: 'text_delta', delta: ' eso.' }),
        ev({ type: 'tool_call_start', id: 'c1', name: 'web_search', input_so_far: '{"q' }),
        ev({ type: 'text_delta', delta: 'Listo.' }),
      ],
      started,
    );
    expect(agentTurn(s).parts).toEqual([
      { kind: 'text', text: 'Busco eso.' },
      { kind: 'tool', id: 'c1' },
      { kind: 'text', text: 'Listo.' },
    ]);
  });

  it('tool_call_start repetido actualiza el mismo tool call, nunca duplica', () => {
    const s = run(
      [
        ev({ type: 'tool_call_start', id: 'c1', name: 'web_search', input_so_far: '{"q' }),
        ev({ type: 'tool_call_start', id: 'c1', name: 'web_search', input_so_far: '{"query":"x' }),
        ev({ type: 'tool_call_start', id: 'c1', name: 'web_search', input_so_far: '{"query":"x"}' }),
      ],
      started,
    );
    const turn = agentTurn(s);
    expect(turn.parts.filter((p) => p.kind === 'tool')).toHaveLength(1);
    expect(Object.keys(turn.toolCalls)).toEqual(['c1']);
    expect(turn.toolCalls.c1.input).toBe('{"query":"x"}');
    expect(turn.toolCalls.c1.state).toBe('pending');
  });

  it('recorre los 4 estados: pending → running → completed | error', () => {
    const s = run(
      [
        ev({ type: 'tool_call_start', id: 'c1', name: 'web_fetch', input_so_far: '' }),
        ev({ type: 'tool_call_ready', id: 'c1', name: 'web_fetch', input: { url: 'https://a' } }),
      ],
      started,
    );
    expect(agentTurn(s).toolCalls.c1.state).toBe('running');
    const ok = reduce(s, ev({ type: 'tool_result', id: 'c1', name: 'web_fetch', result: 'x', durationMs: 5 }));
    expect(agentTurn(ok).toolCalls.c1).toMatchObject({ state: 'completed', output: 'x', durationMs: 5 });
    const ko = reduce(
      s,
      ev({ type: 'tool_error', id: 'c1', name: 'web_fetch', error: 'timeout', recoverable: true }),
    );
    expect(agentTurn(ko).toolCalls.c1).toMatchObject({ state: 'error', error: 'timeout' });
  });

  it('done + turn_ended cierran el turno y liberan preguntas y confirmaciones', () => {
    const s = run(
      [
        { type: 'questions_request', requestId: 'q1', questions: [{ question: '¿?' }] },
        { type: 'confirm_request', callId: 'c9', tool: 'x', description: 'd' },
        ev({ type: 'done', stopReason: 'cancelled' }),
        { type: 'turn_ended', turnId: T, stopReason: 'cancelled' },
      ],
      started,
    );
    expect(agentTurn(s).status).toBe('cancelled');
    expect(s.activeTurnId).toBeNull();
    expect(s.pendingQuestions).toBeNull();
    expect(s.pendingConfirm).toBeNull();
  });

  it('turn_ended sin done (excepción en el sidecar) no deja tools girando', () => {
    const s = run(
      [
        ev({ type: 'tool_call_ready', id: 'c1', name: 'web_fetch', input: {} }),
        { type: 'turn_ended', turnId: T, stopReason: 'error' },
      ],
      started,
    );
    expect(agentTurn(s).toolCalls.c1.state).toBe('error');
    expect(s.activeTurnId).toBeNull();
  });

  it('questions_answered cierra la tanda pendiente', () => {
    const s = run(
      [
        { type: 'questions_request', requestId: 'q1', questions: [{ question: '¿?' }] },
        ev({ type: 'questions_answered', answers: null }),
      ],
      started,
    );
    expect(s.pendingQuestions).toBeNull();
  });

  it('todo_updated refleja la lista de tareas', () => {
    const items = [{ id: 't1', title: 'Buscar', status: 'in_progress' as const }];
    const s = reduce(started, ev({ type: 'todo_updated', items, stale: 0 }));
    expect(s.todos).toEqual(items);
  });

  it('una caída del sidecar deja el turno interrumpido y recuperable', () => {
    const s = run(
      [
        { type: 'opened' },
        ev({ type: 'tool_call_ready', id: 'c1', name: 'web_fetch', input: {} }),
        { type: 'confirm_request', callId: 'c1', tool: 'x', description: 'd' },
        { type: 'connection_lost' },
      ],
      started,
    );
    expect(agentTurn(s).status).toBe('interrupted');
    expect(agentTurn(s).toolCalls.c1.state).toBe('error');
    expect(s.activeTurnId).toBeNull();
    expect(s.pendingConfirm).toBeNull();
    expect(s.opened).toBe(false);
    expect(userTextOf(s, T)).toBe('hola');
  });

  it('chat_rejected marca el turno como error con el motivo', () => {
    const s = reduce(started, { type: 'chat_rejected', turnId: T, message: 'Ocupado' });
    expect(agentTurn(s).status).toBe('error');
    expect(agentTurn(s).parts).toContainEqual({ kind: 'notice', tone: 'error', text: 'Ocupado' });
    expect(s.activeTurnId).toBeNull();
  });

  it('ignora eventos de turnos que no existen', () => {
    expect(reduce(started, { type: 'agent_event', turnId: 'otro', event: { type: 'text_delta', delta: 'x' } })).toBe(
      started,
    );
  });
});

describe('revisión final de Codex (D1)', () => {
  it('turn_ended con error deja el turno en error, no completado', () => {
    const s = run([{ type: 'turn_ended', turnId: T, stopReason: 'error' }], started);
    expect(agentTurn(s).status).toBe('error');
    const ok = run([{ type: 'turn_ended', turnId: T, stopReason: 'max_iterations' }], started);
    expect(agentTurn(ok).status).toBe('done');
  });
});

describe('prueba con provider real (D1)', () => {
  it('questions_answered completa el tool call de question (el loop no emite tool_result)', () => {
    const s = run(
      [
        ev({ type: 'tool_call_ready', id: 'q1', name: 'question', input: {} }),
        ev({ type: 'questions_answered', answers: [{ question: '¿Género?', answer: 'Fantasía', optionId: 'opt_a' }] }),
        { type: 'turn_ended', turnId: T, stopReason: 'stop' },
      ],
      started,
    );
    expect(agentTurn(s).toolCalls.q1).toMatchObject({ state: 'completed', output: '¿Género? → Fantasía' });
  });
});

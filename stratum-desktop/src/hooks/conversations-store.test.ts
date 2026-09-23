import { describe, expect, it } from 'vitest';
import type { ConversationSummary, SidecarFrame } from '../ipc/types';
import {
  conversationsReducer,
  dateGroup,
  groupByDate,
  idleBackground,
  initialConversationsState,
  isBusy,
  matchesSearch,
  relativeDate,
} from './conversations-store';
import { conversationReducer, initialConversationState } from './conversation-reducer';
import { frameToAction } from './useAgentStream';
import { conversationSummary, transcriptTurn, workspaceStatus } from '../ipc/validate';

const A = '6f1c1c0e-3d2a-4b8e-9c1d-00000000000a';
const B = '6f1c1c0e-3d2a-4b8e-9c1d-00000000000b';
const frame = (f: Record<string, unknown>) => f as unknown as SidecarFrame;

function summary(id: string, updatedAt: string, title = 'x'): ConversationSummary {
  return {
    conversationId: id,
    title,
    titleEdited: false,
    createdAt: updatedAt,
    updatedAt,
    provider: 'local',
    model: 'gemma',
    turnCount: 1,
    workspace: null,
  };
}

const TURN = {
  turnId: 't1',
  user: { text: 'hola', attachments: [{ path: 'inputs/a.csv', name: 'a.csv', size: 3 }] },
  parts: [
    { kind: 'text', text: 'Leo ' },
    { kind: 'tool', id: 'c1' },
  ],
  toolCalls: { c1: { id: 'c1', name: 'read_file', state: 'completed', input: '{}', output: 'ok' } },
  status: 'streaming',
  startedAt: '2026-09-22T10:00:00.000Z',
};

describe('estado de una conversación (D4)', () => {
  it('conversation_opened con transcript hidrata los mensajes y el turno en marcha', () => {
    const action = frameToAction(
      frame({
        type: 'conversation_opened',
        conversationId: A,
        resumed: true,
        messageCount: 2,
        transcript: [TURN],
        activeTurnId: 't1',
        title: 'Hola',
        todos: [],
        stats: {
          provider: 'local',
          model: 'gemma',
          context: { used: 1200, max: 32768, pct: 4, estimated: true },
        },
      }),
      A,
    );
    expect(action?.type).toBe('opened');
    const state = conversationReducer(initialConversationState, action!);
    expect(state.opened).toBe(true);
    expect(state.activeTurnId).toBe('t1');
    expect(state.title).toBe('Hola');
    expect(state.stats?.model).toBe('gemma');
    expect(state.messages).toMatchObject([
      { role: 'user', text: 'hola', attachments: [{ name: 'a.csv' }] },
      { role: 'agent', status: 'streaming', toolCalls: { c1: { state: 'completed' } } },
    ]);
    // Los eventos que siguen llegando continúan ese mismo turno.
    const next = conversationReducer(state, {
      type: 'agent_event',
      turnId: 't1',
      event: { type: 'text_delta', delta: 'más' },
    });
    const agent = next.messages[1];
    expect(agent.role === 'agent' && agent.parts.at(-1)).toEqual({ kind: 'text', text: 'más' });
  });

  it('cola de generación: queued → streaming → done', () => {
    let s = conversationReducer(initialConversationState, { type: 'opened' });
    s = conversationReducer(s, { type: 'user_sent', turnId: 't1', text: 'x' });
    s = conversationReducer(s, { type: 'turn_queued', turnId: 't1', position: 2 });
    expect(s.messages[1]).toMatchObject({ status: 'queued', queuePosition: 2 });
    s = conversationReducer(s, { type: 'turn_started', turnId: 't1' });
    expect(s.messages[1]).toMatchObject({ status: 'streaming' });
    s = conversationReducer(s, { type: 'turn_ended', turnId: 't1', stopReason: 'stop' });
    expect(s.messages[1]).toMatchObject({ status: 'done' });
    expect(s.activeTurnId).toBeNull();
  });

  it('un turno cancelado en cola termina como cancelado', () => {
    let s = conversationReducer(initialConversationState, { type: 'opened' });
    s = conversationReducer(s, { type: 'user_sent', turnId: 't1', text: 'x' });
    s = conversationReducer(s, { type: 'turn_queued', turnId: 't1', position: 1 });
    s = conversationReducer(s, { type: 'turn_ended', turnId: 't1', stopReason: 'cancelled' });
    expect(s.messages[1]).toMatchObject({ status: 'cancelled' });
  });

  it('/clear vacía mensajes, tareas y avisos', () => {
    let s = conversationReducer(initialConversationState, { type: 'opened' });
    s = conversationReducer(s, { type: 'user_sent', turnId: 't1', text: 'x' });
    s = conversationReducer(s, { type: 'turn_ended', turnId: 't1', stopReason: 'stop' });
    s = conversationReducer(s, { type: 'info', message: 'hecho' });
    const cleared = conversationReducer(s, frameToAction(frame({ type: 'conversation_cleared', conversationId: A }), A)!);
    expect(cleared.messages).toEqual([]);
    expect(cleared.info).toBeNull();
  });

  it('conversation_notice: info a `info`, warning a `notice`', () => {
    expect(
      frameToAction(frame({ type: 'conversation_notice', conversationId: A, tone: 'info', message: 'ok' }), A),
    ).toEqual({ type: 'info', message: 'ok' });
    expect(
      frameToAction(frame({ type: 'conversation_notice', conversationId: A, tone: 'warning', message: 'no' }), A),
    ).toEqual({ type: 'conversation_error', message: 'no' });
  });
});

describe('validación de tramas D4', () => {
  it('un turno mal formado se descarta; uno bueno conserva solo los campos conocidos', () => {
    expect(transcriptTurn({ ...TURN, status: 'raro' })).toBeNull();
    expect(transcriptTurn({ ...TURN, toolCalls: { c1: { id: 'otro', name: 'x', state: 'completed', input: '' } } })).toBeNull();
    const ok = transcriptTurn({ ...TURN, extra: 'x', files: [{ path: '../fuera', name: 'f', size: 1, mime: 'x' }] });
    expect(ok).not.toBeNull();
    expect(ok).not.toHaveProperty('extra');
    // Una tarjeta de fichero fuera de outputs/ no pasa.
    expect(ok?.files).toBeUndefined();
  });

  it('resumen y estado del workspace (sizeBytes opcional para sidecars antiguos)', () => {
    expect(conversationSummary({ ...summary(A, '2026-09-22T10:00:00Z'), turnCount: 'x' })).toBeNull();
    expect(
      workspaceStatus({ state: 'active', pinned: false, lastUsedAt: '2026-09-22T10:00:00Z', purgeAt: null, filesExpiredAt: null }),
    ).toMatchObject({ sizeBytes: 0 });
  });
});

describe('store de conversaciones', () => {
  it('reparte las acciones por conversación sin mezclarlas', () => {
    let s = initialConversationsState(A);
    s = conversationsReducer(s, { type: 'conv', id: A, action: { type: 'opened' } });
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'opened' } });
    s = conversationsReducer(s, { type: 'conv', id: A, action: { type: 'user_sent', turnId: 'ta', text: 'a' } });
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'user_sent', turnId: 'tb', text: 'b' } });
    s = conversationsReducer(s, {
      type: 'conv',
      id: B,
      action: { type: 'agent_event', turnId: 'tb', event: { type: 'text_delta', delta: 'B' } },
    });
    const a = s.byId[A]!.messages[1];
    const b = s.byId[B]!.messages[1];
    expect(a.role === 'agent' && a.parts).toEqual([]);
    expect(b.role === 'agent' && b.parts).toEqual([{ kind: 'text', text: 'B' }]);
  });

  it('listado ordenado por fecha; actualizar y eliminar', () => {
    let s = initialConversationsState(A);
    s = conversationsReducer(s, {
      type: 'list',
      items: [summary(A, '2026-09-20T10:00:00Z'), summary(B, '2026-09-21T10:00:00Z')],
    });
    expect(s.list.map((c) => c.conversationId)).toEqual([B, A]);
    s = conversationsReducer(s, { type: 'summary', summary: summary(A, '2026-09-22T10:00:00Z', 'nuevo') });
    expect(s.list.map((c) => [c.conversationId, c.title])).toEqual([
      [A, 'nuevo'],
      [B, 'x'],
    ]);
    s = conversationsReducer(s, { type: 'deleted', id: A });
    expect(s.list.map((c) => c.conversationId)).toEqual([B]);
  });

  it('solo se cierran las de fondo abiertas y sin nada en marcha', () => {
    let s = initialConversationsState(A);
    for (const id of [A, B]) {
      s = conversationsReducer(s, { type: 'mark_open', id, open: true });
      s = conversationsReducer(s, { type: 'conv', id, action: { type: 'opened' } });
    }
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'user_sent', turnId: 't', text: 'x' } });
    // B genera en segundo plano: no se cierra; A es la activa.
    expect(idleBackground(s)).toEqual([]);
    expect(isBusy(s.byId[B])).toBe(true);
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'turn_ended', turnId: 't', stopReason: 'stop' } });
    expect(idleBackground(s)).toEqual([B]);
  });

  it('al perder la conexión, los turnos de todas quedan interrumpidos', () => {
    let s = initialConversationsState(A);
    s = conversationsReducer(s, { type: 'mark_open', id: B, open: true });
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'opened' } });
    s = conversationsReducer(s, { type: 'conv', id: B, action: { type: 'user_sent', turnId: 't', text: 'x' } });
    s = conversationsReducer(s, { type: 'connection_lost' });
    expect(s.open).toEqual({});
    expect(s.byId[B]!.messages[1]).toMatchObject({ status: 'interrupted' });
  });
});

describe('agrupación y búsqueda del sidebar (§7.1)', () => {
  const now = new Date(2026, 8, 22, 12, 0);
  it('grupos por fecha, sin los vacíos', () => {
    expect(dateGroup(new Date(2026, 8, 22, 1).toISOString(), now)).toBe('Hoy');
    expect(dateGroup(new Date(2026, 8, 21, 23).toISOString(), now)).toBe('Ayer');
    expect(dateGroup(new Date(2026, 8, 17).toISOString(), now)).toBe('Últimos 7 días');
    expect(dateGroup(new Date(2026, 7, 1).toISOString(), now)).toBe('Anteriores');
    const groups = groupByDate(
      [summary(A, new Date(2026, 8, 22, 9).toISOString()), summary(B, new Date(2026, 5, 1).toISOString())],
      now,
    );
    expect(groups.map((g) => g.group)).toEqual(['Hoy', 'Anteriores']);
  });

  it('búsqueda sin mayúsculas ni tildes', () => {
    expect(matchesSearch('Análisis de logs', 'analisis')).toBe(true);
    expect(matchesSearch('Receta de pan', 'LOGS')).toBe(false);
  });

  it('fecha relativa', () => {
    expect(relativeDate(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('hace 5 min');
    expect(relativeDate(new Date(now.getTime() - 2 * 3_600_000).toISOString(), now)).toBe('hace 2 h');
    expect(relativeDate(new Date(2025, 1, 3).toISOString(), now)).toMatch(/2025/);
  });
});

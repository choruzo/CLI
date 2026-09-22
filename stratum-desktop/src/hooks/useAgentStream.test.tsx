import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { frameToAction } from './useAgentStream';
import { ReconnectBanner } from '../components/chat/ReconnectBanner';
import { InputArea } from '../components/chat/InputArea';
import type { SidecarFrame } from '../ipc/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const ID = '6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e';
const frame = (f: Record<string, unknown>) => f as unknown as SidecarFrame;

describe('frameToAction', () => {
  it('traduce las tramas de esta conversación', () => {
    expect(frameToAction(frame({ type: 'conversation_opened', conversationId: ID }), ID)).toEqual({
      type: 'opened',
    });
    expect(
      frameToAction(
        frame({
          type: 'agent_event',
          conversationId: ID,
          turnId: 't1',
          event: { type: 'text_delta', delta: 'x' },
        }),
        ID,
      ),
    ).toEqual({ type: 'agent_event', turnId: 't1', event: { type: 'text_delta', delta: 'x' } });
    expect(
      frameToAction(frame({ type: 'prompt_resolved', conversationId: ID, kind: 'confirm', id: 'c1' }), ID),
    ).toEqual({ type: 'confirm_resolved', callId: 'c1' });
  });

  it('descarta tramas de otra conversación y las que no son de conversación', () => {
    expect(frameToAction(frame({ type: 'conversation_opened', conversationId: 'otra' }), ID)).toBeNull();
    expect(frameToAction(frame({ type: 'pong', ts: 1 }), ID)).toBeNull();
  });

  it('descarta tramas mal formadas en vez de meterlas en el estado', () => {
    expect(frameToAction(frame({ type: 'agent_event', conversationId: ID, turnId: 't1' }), ID)).toBeNull();
    expect(
      frameToAction(frame({ type: 'agent_event', conversationId: ID, turnId: 't1', event: 'x' }), ID),
    ).toBeNull();
    expect(
      frameToAction(frame({ type: 'questions_request', conversationId: ID, requestId: 'q', questions: 'x' }), ID),
    ).toBeNull();
    expect(frameToAction(frame({ type: 'confirm_request', conversationId: ID, callId: 'c' }), ID)).toBeNull();
  });
});

describe('ReconnectBanner', () => {
  it('muestra el intento en curso', () => {
    render(
      <ReconnectBanner
        status={{ state: 'reconnecting', attempt: 2, maxAttempts: 4, delayMs: 2000, reason: 'x' }}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('(2/4)');
  });

  it('agotados los intentos ofrece Reintentar', () => {
    const onRestart = vi.fn();
    render(<ReconnectBanner status={{ state: 'failed', message: 'murió' }} onRestart={onRestart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRestart).toHaveBeenCalled();
  });

  it('conectado no pinta nada', () => {
    const { container } = render(
      <ReconnectBanner status={{ state: 'starting' }} onRestart={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('InputArea', () => {
  it('Enter envía y Shift+Enter no', () => {
    const onSend = vi.fn();
    render(<InputArea disabled={false} generating={false} onSend={onSend} onCancel={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hola' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hola', []);
  });

  it('mientras genera ofrece Detener, y Escape también cancela', () => {
    const onCancel = vi.fn();
    render(<InputArea disabled={false} generating onSend={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe('frameToAction — validación estructural', () => {
  const ev = (event: unknown) =>
    frameToAction(frame({ type: 'agent_event', conversationId: ID, turnId: 't1', event }), ID);

  it('descarta un todo_updated cuyo items no es una lista válida', () => {
    expect(ev({ type: 'todo_updated', items: 'x', stale: 0 })).toBeNull();
    expect(ev({ type: 'todo_updated', items: [{ id: 1, title: 'a', status: 'done' }], stale: 0 })).toBeNull();
    expect(ev({ type: 'todo_updated', items: [{ id: 't', title: 'a', status: 'raro' }], stale: 0 })).toBeNull();
    expect(ev({ type: 'todo_updated', items: [{ id: 't', title: 'a', status: 'done' }], stale: 0 })).not.toBeNull();
  });

  it('valida cada variante campo a campo y copia solo los campos conocidos', () => {
    expect(ev({ type: 'tool_result', id: 'c', name: 'n', result: 'r' })).toBeNull();
    expect(ev({ type: 'done', stopReason: 'inventado' })).toBeNull();
    expect(ev({ type: 'subagent_started', subagentId: 's' })).toBeNull();
    expect(ev({ type: 'text_delta', delta: 'x', extra: '<script>' })).toEqual({
      type: 'agent_event',
      turnId: 't1',
      event: { type: 'text_delta', delta: 'x' },
    });
  });

  it('descarta preguntas con opciones mal formadas y un turn_ended con motivo desconocido', () => {
    expect(
      frameToAction(
        frame({
          type: 'questions_request',
          conversationId: ID,
          requestId: 'q',
          questions: [{ question: '¿?', options: ['a'] }],
        }),
        ID,
      ),
    ).toBeNull();
    expect(
      frameToAction(frame({ type: 'turn_ended', conversationId: ID, turnId: 't', stopReason: 'x' }), ID),
    ).toBeNull();
  });
});

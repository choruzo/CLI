import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import {
  LONG_WAIT_MS,
  PHRASES,
  PHRASE_ROTATE_MS,
  formatElapsed,
  thinkingPhrase,
} from './thinking-phrases';
import { ReasoningBlock, countWords } from './ReasoningBlock';
import { AgentMessage, turnPhase } from './AgentMessage';
import { ToolCallBlock } from './ToolCallBlock';
import {
  conversationReducer as reduce,
  initialConversationState,
  type AgentTurn,
  type ConversationAction,
  type ConversationState,
} from '../../hooks/conversation-reducer';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Sidebar } from '../layout/Sidebar';
import { TitleBar } from '../layout/TitleBar';
import type { AgentEvent } from '../../../../stratum-cli/src/agent/events';
import { agentEvent, transcriptTurn } from '../../ipc/validate';

const win = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

describe('frases de espera (D7)', () => {
  it('son deterministas por turno y rotan con el tiempo', () => {
    const a = thinkingPhrase('turno-a', 'waiting', 0);
    expect(thinkingPhrase('turno-a', 'waiting', 0)).toBe(a);
    expect(thinkingPhrase('turno-a', 'waiting', PHRASE_ROTATE_MS - 1)).toBe(a);
    expect(thinkingPhrase('turno-a', 'waiting', PHRASE_ROTATE_MS)).not.toBe(a);
    expect(a.endsWith('…')).toBe(true);
  });

  it('cada fase sale de su propia lista y la espera larga tiene la suya', () => {
    const strip = (p: string) => p.slice(0, -1);
    expect(PHRASES.reasoning).toContain(strip(thinkingPhrase('x', 'reasoning', 1_000)));
    expect(PHRASES.tool).toContain(strip(thinkingPhrase('x', 'tool', 1_000)));
    expect(PHRASES.long).toContain(strip(thinkingPhrase('x', 'waiting', LONG_WAIT_MS)));
    // Una tool larga sigue diciendo que excava: sabe qué está haciendo.
    expect(PHRASES.tool).toContain(strip(thinkingPhrase('x', 'tool', LONG_WAIT_MS * 2)));
  });

  it('ninguna frase es la de otras herramientas: son de estratos', () => {
    const all = Object.values(PHRASES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((p) => /pensando|thinking/i.test(p))).toBe(false);
  });

  it('formatElapsed', () => {
    expect(formatElapsed(4_200)).toBe('4 s');
    expect(formatElapsed(65_000)).toBe('1 min 05 s');
    expect(formatElapsed(-5)).toBe('0 s');
  });
});

const T = 't1';
const ev = (event: AgentEvent, now?: number): ConversationAction => ({
  type: 'agent_event',
  turnId: T,
  event,
  now,
});
function turnOf(state: ConversationState): AgentTurn {
  const t = state.messages.find((m) => m.role === 'agent');
  if (!t || t.role !== 'agent') throw new Error('sin turno');
  return t;
}

describe('razonamiento en el reducer (D7)', () => {
  const start = reduce(initialConversationState, { type: 'user_sent', turnId: T, text: 'hola' });

  it('agrupa fragmentos, mide el bloque y lo cierra al llegar texto', () => {
    const s = [
      ev({ type: 'thinking', text: 'Primero ' }, 1_000),
      ev({ type: 'thinking', text: 'esto' }, 1_500),
      ev({ type: 'text_delta', delta: 'Hola' }, 4_000),
      ev({ type: 'thinking', text: 'otra vez' }, 5_000),
    ].reduce(reduce, start);
    expect(turnOf(s).parts).toEqual([
      { kind: 'reasoning', text: 'Primero esto', startedAt: 1_000, endedAt: 4_000 },
      { kind: 'text', text: 'Hola' },
      { kind: 'reasoning', text: 'otra vez', startedAt: 5_000 },
    ]);
  });

  it('una tool call también cierra el bloque, y el fin del turno cierra el último', () => {
    let s = [
      ev({ type: 'thinking', text: 'busco' }, 1_000),
      ev({ type: 'tool_call_start', id: 'c', name: 'web_search', input_so_far: '' }, 2_000),
      ev({ type: 'thinking', text: 'leo' }, 3_000),
    ].reduce(reduce, start);
    const parts = turnOf(s).parts;
    expect(parts[0]).toMatchObject({ kind: 'reasoning', endedAt: 2_000 });
    expect(parts[2]).toMatchObject({ kind: 'reasoning', text: 'leo' });
    s = reduce(s, { type: 'turn_ended', turnId: T, stopReason: 'stop' });
    const last = turnOf(s).parts[2];
    expect(last.kind === 'reasoning' && last.endedAt).toBeTypeOf('number');
  });

  it('turnPhase: esperando, razonando, en una tool o con el texto llegando', () => {
    expect(turnPhase({ parts: [], toolCalls: {} })).toBe('waiting');
    expect(turnPhase({ parts: [{ kind: 'reasoning', text: 'x', startedAt: 1 }], toolCalls: {} })).toBe(
      'reasoning',
    );
    expect(
      turnPhase({
        parts: [{ kind: 'tool', id: 'c' }],
        toolCalls: { c: { id: 'c', name: 'exec', state: 'running', input: '' } },
      }),
    ).toBe('tool');
    expect(
      turnPhase({
        parts: [{ kind: 'tool', id: 'c' }],
        toolCalls: { c: { id: 'c', name: 'exec', state: 'completed', input: '' } },
      }),
    ).toBe('waiting');
    expect(turnPhase({ parts: [{ kind: 'text', text: 'hola' }], toolCalls: {} })).toBeNull();
  });
});

describe('ReasoningBlock (D7)', () => {
  it('en vivo enseña la cola y cuánto lleva; plegado, un resumen que se despliega', () => {
    const { rerender } = render(
      <ReasoningBlock text="uno dos tres" live startedAt={0} now={12_000} />,
    );
    expect(screen.getByRole('button', { name: /Razonando · 12 s/ })).toBeTruthy();
    expect(document.querySelector('.reasoning__tail')?.textContent).toBe('uno dos tres');

    rerender(<ReasoningBlock text="uno dos tres" live={false} startedAt={0} endedAt={7_000} now={20_000} />);
    const header = screen.getByRole('button', { name: /Razonó 7 s/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.reasoning__tail')).toBeNull();
    // Plegado, el cuerpo es inerte: ni Tab ni el lector de pantalla llegan.
    expect(document.querySelector('.collapse')?.hasAttribute('inert')).toBe(true);
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.collapse')?.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('region', { name: 'Razonamiento del modelo' }).textContent).toBe(
      'uno dos tres',
    );
  });

  it('por debajo del segundo dice «un instante», no «0 s»', () => {
    const { rerender } = render(<ReasoningBlock text="a" live startedAt={0} now={400} />);
    expect(screen.getByRole('button', { name: /Razonando…/ })).toBeTruthy();
    rerender(<ReasoningBlock text="a" live={false} startedAt={0} endedAt={400} now={900} />);
    expect(screen.getByRole('button', { name: /Razonó un instante/ })).toBeTruthy();
  });

  it('un bloque reabierto (sin tiempos) se llama «Razonamiento» y cuenta palabras', () => {
    render(<ReasoningBlock text={'a b\nc'} live={false} now={0} />);
    expect(screen.getByRole('button', { name: /Razonamiento\s*3 palabras/ })).toBeTruthy();
    expect(countWords(' a  b\nc ')).toBe(3);
  });
});

describe('AgentMessage (D7)', () => {
  const turn = (patch: Partial<AgentTurn>): AgentTurn => ({
    role: 'agent',
    turnId: 'turno-x',
    parts: [],
    toolCalls: {},
    status: 'streaming',
    ...patch,
  });

  it('esperando: indicador de capas con una frase de estratos', () => {
    render(<AgentMessage turn={turn({})} />);
    const phrase = document.querySelector('.thinking__phrase')?.textContent ?? '';
    expect(PHRASES.waiting.map((p) => `${p}…`)).toContain(phrase);
    expect(document.querySelector('.thinking')?.getAttribute('data-phase')).toBe('waiting');
  });

  it('con el texto llegando no hay indicador (el cursor ya lo dice), y al terminar tampoco', () => {
    const { rerender } = render(<AgentMessage turn={turn({ parts: [{ kind: 'text', text: 'Hola' }] })} />);
    expect(document.querySelector('.thinking')).toBeNull();
    rerender(<AgentMessage turn={turn({ status: 'done', parts: [] })} />);
    expect(document.querySelector('.thinking')).toBeNull();
  });

  it('pinta el razonamiento antes de la respuesta', () => {
    render(
      <AgentMessage
        turn={turn({
          status: 'done',
          parts: [
            { kind: 'reasoning', text: 'pienso', startedAt: 0, endedAt: 2_000 },
            { kind: 'text', text: 'Respuesta' },
          ],
        })}
      />,
    );
    const blocks = Array.from(document.querySelectorAll('.message--agent > *')).map((n) => n.className);
    expect(blocks[0]).toBe('reasoning');
    expect(screen.getByRole('button', { name: /Razonó 2 s/ })).toBeTruthy();
  });
});

describe('ToolCallBlock (D7)', () => {
  it('monta el cuerpo al abrirlo por primera vez y lo deja inerte al plegar', () => {
    render(
      <ToolCallBlock call={{ id: 'c', name: 'read_file', state: 'completed', input: '{}', output: 'HOLA' }} />,
    );
    expect(screen.queryByText('HOLA')).toBeNull();
    const header = screen.getByRole('button', { name: /read_file/ });
    fireEvent.click(header);
    expect(screen.getByText('HOLA')).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText('HOLA').closest('[inert]')).not.toBeNull();
  });
});

describe('TitleBar (D7)', () => {
  beforeEach(() => {
    for (const fn of Object.values(win)) fn.mockClear();
  });

  it('controles con nombre accesible que mueven la ventana', async () => {
    render(<TitleBar title="Mi conversación" />);
    expect(screen.getByText('Mi conversación')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximizar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(win.minimize).toHaveBeenCalledOnce();
    expect(win.toggleMaximize).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();
    expect(document.querySelector('.titlebar')?.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('maximizada, el botón pasa a «Restaurar»', async () => {
    win.isMaximized.mockResolvedValueOnce(true);
    render(<TitleBar />);
    expect(await screen.findByRole('button', { name: 'Restaurar' })).toBeTruthy();
  });
});

function TrapHarness({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} role="dialog">
      <button type="button">primero</button>
      <button type="button" onClick={onClose}>
        último
      </button>
    </div>
  );
}

describe('useFocusTrap (D7)', () => {
  it('Tab da la vuelta dentro del diálogo y el foco vuelve al cerrarlo', () => {
    const outside = document.createElement('button');
    outside.textContent = 'fuera';
    document.body.appendChild(outside);
    try {
      outside.focus();
      const { unmount } = render(<TrapHarness />);
      const [first, last] = screen.getAllByRole('button', { name: /primero|último/ });
      last.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
      unmount();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe('Sidebar (D7)', () => {
  it('las flechas recorren el raíl y el panel se desmonta tras la transición', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Sidebar state={{ open: true, panel: 'conversations' }} onToggle={vi.fn()} onSettings={vi.fn()}>
          <p>contenido</p>
        </Sidebar>,
      );
      const rail = screen.getAllByRole('button');
      rail[0].focus();
      fireEvent.keyDown(rail[0], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(rail[1]);
      fireEvent.keyDown(rail[1], { key: 'End' });
      expect(document.activeElement).toBe(rail[rail.length - 1]);

      rerender(
        <Sidebar state={{ open: false, panel: 'conversations' }} onToggle={vi.fn()} onSettings={vi.fn()}>
          <p>contenido</p>
        </Sidebar>,
      );
      // Cerrándose: sigue montado (para animar) pero inerte.
      expect(screen.getByText('contenido').closest('[inert]')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByText('contenido')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('validación del canal (D7)', () => {
  it('acepta el evento thinking y la parte reasoning del transcript', () => {
    expect(agentEvent({ type: 'thinking', text: 'hmm' })).toEqual({ type: 'thinking', text: 'hmm' });
    expect(agentEvent({ type: 'thinking' })).toBeNull();
    const turn = transcriptTurn({
      turnId: 't',
      user: { text: 'hola' },
      parts: [
        { kind: 'reasoning', text: 'pienso' },
        { kind: 'text', text: 'Hola' },
      ],
      toolCalls: {},
      status: 'done',
      startedAt: '2026-09-25T10:00:00Z',
    });
    expect(turn?.parts.map((p) => p.kind)).toEqual(['reasoning', 'text']);
  });
});

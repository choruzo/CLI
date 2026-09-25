import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentTurn } from '../../hooks/conversation-reducer';
import { AgentMessage, turnMarkdown } from './AgentMessage';
import { ToolCallBlock, toolIcon } from './ToolCallBlock';
import { ICON } from './icons';
import { MarkdownRenderer } from './markdown/MarkdownRenderer';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

function turn(parts: AgentTurn['parts'], status: AgentTurn['status'] = 'done'): AgentTurn {
  return { role: 'agent', turnId: 't1', parts, toolCalls: {}, status };
}

describe('bloques de código (mejora 1)', () => {
  it('cabecera con el lenguaje y «Copiar» que copia el código sin el salto final', async () => {
    render(<MarkdownRenderer text={'```ts\nconst a = 1;\n```\n'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }));
    });
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
    expect(screen.getByRole('button', { name: 'Copiado' })).toBeTruthy();
  });

  it('sin lenguaje dice «código»', () => {
    render(<MarkdownRenderer text={'```\nx\n```\n'} />);
    expect(screen.getByText('código')).toBeTruthy();
  });

  it('un portapapeles que falla no marca como copiado', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<MarkdownRenderer text={'```\nx\n```\n'} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }));
    });
    expect(screen.queryByRole('button', { name: 'Copiado' })).toBeNull();
  });
});

describe('iconos por tipo de tool (mejora 4)', () => {
  it('asigna icono por familia y uno genérico a lo desconocido', () => {
    expect(toolIcon('read_file')).toBe(ICON.file);
    expect(toolIcon('grep')).toBe(ICON.search);
    expect(toolIcon('web_fetch')).toBe(ICON.globe);
    expect(toolIcon('recall_decisions')).toBe(ICON.brain);
    expect(toolIcon('mcp__github__search')).toBe(ICON.plug);
    expect(toolIcon('otra')).toBe(ICON.tool);
  });

  it('el icono es decorativo: el nombre accesible del bloque no cambia', () => {
    render(<ToolCallBlock call={{ id: 'c1', name: 'web_fetch', input: '', state: 'completed' }} />);
    const header = screen.getByRole('button', { name: /web_fetch/ });
    expect(header.querySelector('.tool-call__kind svg')).not.toBeNull();
  });
});

describe('acciones por mensaje (mejora 6)', () => {
  it('turnMarkdown junta solo las partes de texto', () => {
    expect(
      turnMarkdown(
        turn([
          { kind: 'reasoning', text: 'pienso' },
          { kind: 'text', text: '**Hola**' },
          { kind: 'tool', id: 'x' },
          { kind: 'text', text: 'adiós\n' },
        ]),
      ),
    ).toBe('**Hola**\n\nadiós');
  });

  it('«Copiar como markdown» copia el texto crudo', async () => {
    render(<AgentMessage turn={turn([{ kind: 'text', text: '# Título' }])} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar como markdown' }));
    });
    expect(writeText).toHaveBeenCalledWith('# Título');
  });

  it('reintentar solo se ofrece si no hay otro turno en marcha', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AgentMessage turn={turn([{ kind: 'text', text: 'hola' }])} onRetry={onRetry} canRetry={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Reintentar respuesta' })).toBeNull();
    rerender(<AgentMessage turn={turn([{ kind: 'text', text: 'hola' }])} onRetry={onRetry} canRetry />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar respuesta' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('un turno en streaming no muestra acciones', () => {
    render(<AgentMessage turn={turn([{ kind: 'text', text: 'hola' }], 'streaming')} canRetry />);
    expect(screen.queryByRole('toolbar', { name: 'Acciones de la respuesta' })).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolCallBlock } from './ToolCallBlock';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

describe('ToolCallBlock', () => {
  it.each([
    ['pending', 'preparando'],
    ['running', 'ejecutando'],
    ['completed', 'completado'],
    ['error', 'error'],
  ] as const)('pinta el estado %s', (state, label) => {
    const { container } = render(
      <ToolCallBlock call={{ id: 'c', name: 'web_search', state, input: '{}' }} />,
    );
    expect(container.querySelector('.tool-call')?.getAttribute('data-state')).toBe(state);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('se expande para ver el resultado', () => {
    render(
      <ToolCallBlock
        call={{ id: 'c', name: 'web_fetch', state: 'completed', input: '{"url":1}', output: 'HOLA' }}
      />,
    );
    expect(screen.queryByText('HOLA')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('HOLA')).toBeTruthy();
  });
});

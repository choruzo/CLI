// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch } from './ModeSwitch';

afterEach(cleanup);

describe('ModeSwitch', () => {
  it('es un grupo de radio con el modo actual elegido', () => {
    render(<ModeSwitch mode="chat" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'Modo' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Código' }).getAttribute('aria-checked')).toBe('false');
    // Solo la opción elegida entra en el orden de tabulación.
    expect(screen.getByRole('radio', { name: 'Chat' }).tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Código' }).tabIndex).toBe(-1);
  });

  it('pulsar el otro modo lo pide; pulsar el actual, no', () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="chat" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Chat' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Código' }));
    expect(onChange).toHaveBeenCalledWith('code');
  });

  it('las flechas cambian de modo', () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="code" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('chat');
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('chat');
  });

  it('avisa de que el otro modo tiene una sesión esperando', () => {
    render(<ModeSwitch mode="chat" onChange={() => undefined} badges={{ code: true, chat: true }} />);
    // Solo en el modo que no se mira: el propio ya lo enseña su lista.
    expect(screen.getAllByRole('img', { name: 'hay una sesión esperando respuesta' })).toHaveLength(1);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle, useStoredWidth } from './ResizeHandle';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

/** jsdom no maqueta: el panel vecino mide lo que se le diga. */
function withPanel(edge: 'left' | 'right', panelWidth: number, props: Partial<Parameters<typeof ResizeHandle>[0]> = {}) {
  const onResize = vi.fn();
  const onReset = vi.fn();
  const handle = (
    <ResizeHandle
      edge={edge}
      label="Ancho"
      min={200}
      max={600}
      width={null}
      onResize={onResize}
      onReset={onReset}
      {...props}
    />
  );
  render(
    <div>
      {edge === 'left' && handle}
      <aside data-testid="panel" />
      {edge === 'right' && handle}
    </div>,
  );
  screen.getByTestId('panel').getBoundingClientRect = () => ({ width: panelWidth }) as DOMRect;
  return { onResize, onReset, separator: screen.getByRole('separator', { name: 'Ancho' }) };
}

describe('ResizeHandle', () => {
  it('arrastrar el borde derecho hacia la derecha ensancha el panel', () => {
    const { onResize, separator } = withPanel('right', 280);
    fireEvent.pointerDown(separator, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 360, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(340);
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 500, pointerId: 1 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('arrastrar el borde izquierdo hacia la izquierda ensancha el panel', () => {
    const { onResize, separator } = withPanel('left', 400);
    fireEvent.pointerDown(separator, { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 850, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(450);
  });

  it('no pasa del mínimo ni del tope del momento', () => {
    const { onResize, separator } = withPanel('right', 280, { max: () => 320 });
    fireEvent.pointerDown(separator, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(320);
    fireEvent.pointerMove(separator, { clientX: 0, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(200);
  });

  it('un tope por debajo del mínimo deja el mínimo', () => {
    const { onResize, separator } = withPanel('right', 280, { max: () => 120 });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(200);
  });

  it('con el teclado: flechas, Inicio/Fin e Intro', () => {
    const { onResize, onReset, separator } = withPanel('left', 400);
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(416);
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(384);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(200);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(onResize).toHaveBeenLastCalledWith(600);
    fireEvent.keyDown(separator, { key: 'Enter' });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('doble clic vuelve al ancho por defecto', () => {
    const { onReset, separator } = withPanel('right', 280);
    fireEvent.doubleClick(separator);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('useStoredWidth', () => {
  it('recuerda el ancho y lo olvida al restablecer', () => {
    const first = renderHook(() => useStoredWidth('w', 200, 600));
    expect(first.result.current[0]).toBeNull();
    act(() => first.result.current[1](340));
    expect(first.result.current[0]).toBe(340);
    expect(renderHook(() => useStoredWidth('w', 200, 600)).result.current[0]).toBe(340);
    act(() => first.result.current[1](null));
    expect(localStorage.getItem('w')).toBeNull();
  });

  it('ignora un valor guardado corrupto o fuera de rango', () => {
    localStorage.setItem('w', 'ancho');
    expect(renderHook(() => useStoredWidth('w', 200, 600)).result.current[0]).toBeNull();
    localStorage.setItem('w', '9000');
    expect(renderHook(() => useStoredWidth('w', 200, 600)).result.current[0]).toBeNull();
  });
});

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Paso de las flechas del teclado sobre el tirador. */
const KEY_STEP = 16;

/** Ancho mínimo que se le deja siempre a la conversación al estirar un panel. */
export const MIN_CONVERSATION_WIDTH = 360;

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/**
 * Ancho de un panel elegido por el usuario, recordado en `localStorage`
 * (comodidad de la interfaz, como el panel abierto). `null` = el ancho por
 * defecto del CSS. Un valor guardado fuera de rango o corrupto se ignora.
 */
export function useStoredWidth(key: string, min: number, max: number): [number | null, (width: number | null) => void] {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      const stored = Number(raw);
      return Number.isFinite(stored) && stored >= min && stored <= max ? Math.round(stored) : null;
    } catch {
      return null;
    }
  });
  const update = useCallback(
    (next: number | null) => {
      setWidth(next);
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {
        /* no crítico: se pierde al cerrar */
      }
    },
    [key],
  );
  return [width, update];
}

/**
 * Tirador vertical para cambiar el ancho del panel vecino. No ocupa sitio en
 * la fila (ancho 0, zona de agarre superpuesta al borde del panel).
 *
 * `edge` dice en qué borde del panel está: `right` (el panel queda a su
 * izquierda: arrastrar a la derecha lo ensancha) o `left` (el panel queda a
 * su derecha: arrastrar a la izquierda lo ensancha). El ancho de partida se
 * mide del propio panel, así vale también cuando aún manda el CSS.
 *
 * Teclado (patrón *window splitter*): ← → mueven el borde, Inicio/Fin van al
 * mínimo y al máximo, Intro o doble clic vuelven al ancho por defecto.
 */
export function ResizeHandle({
  edge,
  label,
  min,
  max,
  width,
  onResize,
  onReset,
}: {
  edge: 'left' | 'right';
  label: string;
  min: number;
  /** Tope actual: depende de la ventana y de los otros paneles. */
  max: number | (() => number);
  /** El ancho elegido, si lo hay (solo para `aria-valuenow`). */
  width: number | null;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sign = edge === 'right' ? 1 : -1;

  const limit = () => (typeof max === 'function' ? max() : max);
  const panelWidth = () => {
    const el = ref.current;
    const panel = edge === 'right' ? el?.previousElementSibling : el?.nextElementSibling;
    return panel ? panel.getBoundingClientRect().width : (width ?? min);
  };

  // Mientras se arrastra: cursor de columna en toda la ventana, sin selección
  // de texto y sin la transición de anchura del sidebar (iría por detrás).
  useEffect(() => {
    if (!dragging) return;
    document.body.dataset.resizing = '1';
    return () => {
      delete document.body.dataset.resizing;
    };
  }, [dragging]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, width: panelWidth() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    onResize(clamp(start.width + (e.clientX - start.x) * sign, min, limit()));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (delta: number) => onResize(clamp(panelWidth() + delta * sign, min, limit()));
    switch (e.key) {
      case 'ArrowRight':
        move(KEY_STEP);
        break;
      case 'ArrowLeft':
        move(-KEY_STEP);
        break;
      case 'Home':
        onResize(min);
        break;
      case 'End':
        onResize(clamp(limit(), min, limit()));
        break;
      case 'Enter':
        onReset();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className="resize-handle"
      data-edge={edge}
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuenow={width ?? undefined}
      title="Arrastra para cambiar el ancho · doble clic: ancho por defecto"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

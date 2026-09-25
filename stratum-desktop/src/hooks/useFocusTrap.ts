import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elementos a los que llega el Tab dentro de `root`, en orden de documento. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && !el.hidden && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Foco atrapado en un diálogo modal (D7): Tab y Mayús+Tab dan la vuelta dentro
 * de `ref` en vez de escaparse a la conversación que queda detrás, y al
 * cerrarse el foco vuelve a donde estaba al abrirse.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Solo si el foco se quedó en el diálogo o se perdió: no se le quita a
      // quien lo haya tomado después (p. ej. el input al cerrar Ajustes).
      const now = document.activeElement;
      if (previous?.isConnected && (!now || now === document.body || root.contains(now))) {
        previous.focus();
      }
    };
  }, [ref, active]);
}

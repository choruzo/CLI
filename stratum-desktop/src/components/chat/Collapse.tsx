import type { ReactNode } from 'react';

/**
 * Contenido desplegable con transición de altura (D7): `grid-template-rows`
 * de `0fr` a `1fr`, sin medir el DOM. Plegado queda `inert`, así que ni el
 * teclado ni un lector de pantalla llegan a lo que no se ve.
 */
export function Collapse({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return (
    <div className="collapse" data-open={open || undefined} id={id} {...inertProps(!open)}>
      <div className="collapse__inner">{children}</div>
    </div>
  );
}

/** React 18 no conoce `inert`: se pasa como atributo de cadena. */
export function inertProps(inert: boolean): Record<string, string> {
  return inert ? { inert: '' } : {};
}

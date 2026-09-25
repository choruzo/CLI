import { useEffect, useId, useRef, useState } from 'react';
import { Collapse } from './Collapse';
import { formatElapsed } from './thinking-phrases';

/** Palabras aproximadas de un bloque, para el resumen plegado. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Razonamiento del modelo (D7). Mientras llega se ve la cola en una ventana de
 * pocas líneas; al terminar se pliega a una línea («Razonó 12 s»). Siempre se
 * puede desplegar entero. No es markdown: es el borrador del modelo, se pinta
 * tal cual y atenuado para que no se confunda con la respuesta.
 */
export function ReasoningBlock({
  text,
  live,
  startedAt,
  endedAt,
  now,
}: {
  text: string;
  /** Sigue llegando razonamiento a este bloque. */
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const tailRef = useRef<HTMLDivElement>(null);

  // La ventana en vivo sigue a lo último que llega.
  useEffect(() => {
    const el = tailRef.current;
    if (el && live && !open) el.scrollTop = el.scrollHeight;
  }, [text, live, open]);

  const ms = startedAt !== undefined ? (endedAt ?? now) - startedAt : null;
  // «Razonó 0 s» suena a error: por debajo del segundo, «un instante».
  const duration = ms === null ? null : ms < 1_000 ? 'un instante' : formatElapsed(ms);
  const words = countWords(text);
  const label = live
    ? `Razonando${ms !== null && ms >= 1_000 ? ` · ${duration}` : '…'}`
    : duration
      ? `Razonó ${duration}`
      : 'Razonamiento';

  return (
    <div className="reasoning" data-live={live || undefined} data-open={open || undefined}>
      <button
        type="button"
        className="reasoning__header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="reasoning__chevron" aria-hidden="true">
          ›
        </span>
        <span className="reasoning__label">{label}</span>
        <span className="reasoning__words">{words} palabras</span>
      </button>
      <Collapse open={open} id={bodyId}>
        <div className="reasoning__body" role="region" aria-label="Razonamiento del modelo">
          {text}
        </div>
      </Collapse>
      {live && !open && (
        <div ref={tailRef} className="reasoning__tail" aria-hidden="true">
          {text}
        </div>
      )}
    </div>
  );
}

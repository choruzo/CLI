import { useState, useEffect } from 'react';

/** Frames del spinner de "en curso" (§5.1). Cadencia: 150 ms. */
export const SPINNER_FRAMES = ['◌', '◎', '●', '◉', '○'] as const;

export const SPINNER_INTERVAL_MS = 150;

/**
 * Un único reloj para toda la conversación viva. Los componentes de acciones
 * reciben `now` como prop y derivan de él spinner y duración, evitando crear
 * dos intervalos por tool/subagente.
 */
export function useLiveClock(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [active, intervalMs]);

  return now;
}

export function spinnerFrameAt(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
}

/**
 * Frame actual del spinner. Devuelve el primer frame y no arranca ningún
 * intervalo cuando `active` es false, para no repintar Ink sin necesidad.
 *
 * Compartido por `<ToolCallBlock>`, `<InitProgressBlock>` y `<MCPStartup>`.
 */
export function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(iv);
  }, [active]);

  return SPINNER_FRAMES[active ? frame : 0]!;
}

import { useState, useEffect } from 'react';

/** Frames del spinner de "en curso" (§5.1). Cadencia: 150 ms. */
export const SPINNER_FRAMES = ['◌', '◎', '●', '◉', '○'] as const;

export const SPINNER_INTERVAL_MS = 150;

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

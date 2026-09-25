import { useEffect, useState } from 'react';

/**
 * Reloj para lo que muestra tiempo transcurrido (D7). Solo late mientras
 * `active`: un turno terminado no deja intervalos vivos.
 */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

import { useCallback, useEffect, useRef, useState } from 'react';

/** Cuánto dura el «✓ Copiado» antes de volver al estado normal. */
export const COPIED_MS = 1_500;

/**
 * Copia al portapapeles y recuerda durante `COPIED_MS` qué se copió (`key`),
 * para que el botón pueda confirmarlo. Un fallo del portapapeles (permiso
 * denegado, ventana sin foco) no lanza: simplemente no se marca como copiado.
 */
export function useCopy(): [copied: string | null, copy: (text: string, key?: string) => Promise<void>] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string, key = 'default') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    clearTimeout(timer.current);
    setCopied(key);
    timer.current = setTimeout(() => setCopied(null), COPIED_MS);
  }, []);

  return [copied, copy];
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadChanges, type Changes, type Loaded } from '../client/code-actions';
import type { NativeBridge } from '../ipc/native';

export interface ChangesState {
  /** `null`: aún no se han leído (o no hay sesión de la que leerlos). */
  changes: Loaded<Changes> | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Los cambios del árbol de trabajo de una sesión de código (`git.changes`).
 * Se leen al mirar la sesión y cada vez que cambia `refreshKey` (al acabar un
 * turno), además de a mano; no hay sondeo. Una respuesta que llega cuando ya
 * se mira otra cosa se descarta.
 */
export function useChanges(native: NativeBridge, sessionId: string | null, refreshKey: string): ChangesState {
  const [changes, setChanges] = useState<Loaded<Changes> | null>(null);
  const [loading, setLoading] = useState(false);
  const round = useRef(0);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    const mine = ++round.current;
    setLoading(true);
    void loadChanges(native, sessionId).then((result) => {
      if (mine !== round.current) return;
      setLoading(false);
      setChanges(result);
    });
  }, [native, sessionId]);

  // Otra sesión: lo que se tenía no es suyo.
  useEffect(() => {
    setChanges(null);
    setLoading(false);
    return () => {
      round.current++;
    };
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  return { changes, loading, refresh };
}

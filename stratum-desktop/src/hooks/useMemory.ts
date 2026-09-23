import { useCallback, useEffect, useState } from 'react';
import { subscribeSidecarFrames } from '../ipc/bridge';
import type { DecisionSummary, SidecarFrame } from '../ipc/types';
import { decisionSummaries, isNullableNumber, isRecord } from '../ipc/validate';
import { post } from './useAgentStream';

/**
 * Memoria global del asistente en el sidebar (D4, §7.3): el `STRATUM.md`
 * global y las decisiones. Editar es concurrencia optimista: se guarda sobre
 * el `mtime` leído y, si el fichero cambió en disco entretanto, el sidecar
 * responde `memory_conflict` sin pisarlo.
 */

export interface GlobalMemory {
  path: string;
  exists: boolean;
  content: string;
  mtimeMs: number | null;
}

export interface Memory {
  global: GlobalMemory | null;
  decisions: DecisionSummary[];
  /** Versión en disco distinta de la que se estaba editando. */
  conflict: { content: string; mtimeMs: number | null } | null;
  error: string | null;
  saving: boolean;
  /** Se acaba de guardar (para cerrar el editor). Cambia en cada guardado. */
  savedAt: number | null;
  refresh: () => void;
  save: (content: string, baseMtimeMs: number | null) => void;
  forget: (id: string) => void;
  dismissConflict: () => void;
}

export function useMemory(enabled: boolean): Memory {
  const [global, setGlobal] = useState<GlobalMemory | null>(null);
  const [decisions, setDecisions] = useState<DecisionSummary[]>([]);
  const [conflict, setConflict] = useState<Memory['conflict']>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const onFrame = (frame: SidecarFrame) => {
      if (disposed) return;
      const f = frame as unknown as Record<string, unknown>;
      if (!isRecord(f)) return;
      switch (f.type) {
        case 'memory_state': {
          const g = f.global;
          if (
            isRecord(g) &&
            typeof g.path === 'string' &&
            typeof g.exists === 'boolean' &&
            typeof g.content === 'string' &&
            isNullableNumber(g.mtimeMs)
          ) {
            setGlobal({ path: g.path, exists: g.exists, content: g.content, mtimeMs: g.mtimeMs });
          }
          setDecisions(decisionSummaries(f.decisions) ?? []);
          setError(null);
          return;
        }
        case 'memory_saved':
          setSaving(false);
          setConflict(null);
          setSavedAt(Date.now());
          post({ type: 'memory_get' });
          return;
        case 'memory_conflict':
          setSaving(false);
          if (typeof f.content === 'string' && isNullableNumber(f.mtimeMs)) {
            setConflict({ content: f.content, mtimeMs: f.mtimeMs });
          }
          return;
        case 'memory_error':
          setSaving(false);
          if (typeof f.message === 'string') setError(f.message);
          return;
      }
    };
    void subscribeSidecarFrames(onFrame).then((u) => {
      if (disposed) u();
      else unsubscribe = u;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const refresh = useCallback(() => post({ type: 'memory_get' }, setError), []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  const save = useCallback((content: string, baseMtimeMs: number | null) => {
    setSaving(true);
    setError(null);
    post({ type: 'memory_save', content, baseMtimeMs }, (m) => {
      setSaving(false);
      setError(m);
    });
  }, []);

  const forget = useCallback((id: string) => post({ type: 'memory_forget', id }, setError), []);
  const dismissConflict = useCallback(() => setConflict(null), []);

  return {
    global,
    decisions,
    conflict,
    error,
    saving,
    savedAt,
    refresh,
    save,
    forget,
    dismissConflict,
  };
}

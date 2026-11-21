import { useCallback, useEffect, useReducer, useState } from 'react';
import { useNative } from '../bridge/context';
import type { UpdateInfo, UpdateProgress } from '../bridge/native';
import { readDismissedUpdate, writeDismissedUpdate } from '../stores/uiStore';

/**
 * Estado del auto-update de Dot (M23), como el de Desktop (D7). Reducer puro:
 * los tests lo ejercitan sin Tauri.
 *
 * - La comprobación automática (al arrancar y luego cada 12 h: Dot vive días en
 *   la bandeja) es silenciosa: un fallo (sin red, sin manifiesto) no molesta. La
 *   manual, desde el pie, sí dice qué pasó.
 * - «Later» aparca **esa** versión: una más nueva vuelve a avisar.
 * - Nunca se instala sin que la persona lo pida.
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'none'; checkedAt: number; manual: boolean }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; downloaded: number; total: number | null }
  | { kind: 'installing'; info: UpdateInfo }
  /** `info`: falló la descarga o la instalación de esa versión (el banner lo dice). */
  | { kind: 'error'; message: string; manual: boolean; info?: UpdateInfo };

export type UpdateAction =
  | { type: 'check'; manual: boolean }
  | { type: 'checked'; info: UpdateInfo | null; at: number }
  | { type: 'failed'; message: string }
  | { type: 'progress'; progress: UpdateProgress };

function infoOf(state: UpdatePhase): UpdateInfo | undefined {
  return state.kind === 'available' || state.kind === 'downloading' || state.kind === 'installing'
    ? state.info
    : undefined;
}

export function updateReducer(state: UpdatePhase, action: UpdateAction): UpdatePhase {
  switch (action.type) {
    case 'check':
      // Una descarga en marcha no se interrumpe con otra comprobación.
      if (state.kind === 'downloading' || state.kind === 'installing') return state;
      return { kind: 'checking', manual: action.manual };
    case 'checked':
      if (state.kind !== 'checking') return state;
      return action.info
        ? { kind: 'available', info: action.info }
        : { kind: 'none', checkedAt: action.at, manual: state.manual };
    case 'failed': {
      const info = infoOf(state);
      return {
        kind: 'error',
        message: action.message,
        manual: state.kind === 'checking' ? state.manual : true,
        ...(info ? { info } : {}),
      };
    }
    case 'progress': {
      const info = infoOf(state);
      if (!info) return state;
      return action.progress.event === 'installing'
        ? { kind: 'installing', info }
        : { kind: 'downloading', info, downloaded: action.progress.downloaded, total: action.progress.total };
    }
  }
}

/** Retraso de la primera comprobación: que no compita con el arranque. */
export const AUTO_CHECK_DELAY_MS = 5_000;
/** Entre comprobaciones automáticas. */
export const AUTO_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

function errorText(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}

export interface Updates {
  phase: UpdatePhase;
  /** Versión que ofrecer en el banner (`null` si no hay, o si la persona la aparcó). */
  offer: UpdateInfo | null;
  check: () => void;
  install: () => void;
  dismiss: () => void;
}

export function useUpdates(): Updates {
  const native = useNative();
  const [phase, dispatch] = useReducer(updateReducer, { kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(readDismissedUpdate);

  const run = useCallback(
    (manual: boolean) => {
      dispatch({ type: 'check', manual });
      native
        .checkForUpdate()
        .then((info) => dispatch({ type: 'checked', info, at: Date.now() }))
        .catch((err) => dispatch({ type: 'failed', message: errorText(err) }));
    },
    [native],
  );

  useEffect(() => {
    const first = window.setTimeout(() => run(false), AUTO_CHECK_DELAY_MS);
    const every = window.setInterval(() => run(false), AUTO_CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [run]);

  const install = useCallback(() => {
    dispatch({ type: 'progress', progress: { event: 'progress', downloaded: 0, total: null } });
    native
      .installUpdate((progress) => dispatch({ type: 'progress', progress }))
      .catch((err) => dispatch({ type: 'failed', message: errorText(err) }));
  }, [native]);

  const offerInfo = infoOf(phase) ?? (phase.kind === 'error' ? (phase.info ?? null) : null);
  // Una versión aparcada no se ofrece, salvo si ya se está instalando.
  const installing = phase.kind === 'downloading' || phase.kind === 'installing';
  const offer = offerInfo && (installing || offerInfo.version !== dismissed) ? offerInfo : null;

  const dismiss = useCallback(() => {
    if (!offerInfo) return;
    writeDismissedUpdate(offerInfo.version);
    setDismissed(offerInfo.version);
  }, [offerInfo]);

  const check = useCallback(() => run(true), [run]);
  return { phase, offer, check, install, dismiss };
}

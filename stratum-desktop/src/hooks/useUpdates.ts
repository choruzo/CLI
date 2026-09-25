import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { checkForUpdate, installUpdate, type UpdateInfo, type UpdateProgress } from '../ipc/updates';

/**
 * Estado del auto-update (D7). Reducer puro: los tests lo ejercitan sin Tauri.
 *
 * - La comprobación automática (al conectar, si `desktop.updates.autoCheck`)
 *   es silenciosa: un fallo (sin red, sin manifiesto) no molesta. La manual,
 *   desde Ajustes, sí dice qué pasó.
 * - «Más tarde» aparca **esa** versión: una más nueva vuelve a avisar.
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'none'; checkedAt: number }
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

export function updateReducer(state: UpdatePhase, action: UpdateAction): UpdatePhase {
  switch (action.type) {
    case 'check':
      // Una descarga en marcha no se interrumpe con otra comprobación.
      if (state.kind === 'downloading' || state.kind === 'installing') return state;
      return { kind: 'checking', manual: action.manual };
    case 'checked':
      return action.info
        ? { kind: 'available', info: action.info }
        : { kind: 'none', checkedAt: action.at };
    case 'failed': {
      const info =
        state.kind === 'available' || state.kind === 'downloading' || state.kind === 'installing'
          ? state.info
          : undefined;
      return {
        kind: 'error',
        message: action.message,
        manual: state.kind === 'checking' ? state.manual : true,
        ...(info ? { info } : {}),
      };
    }
    case 'progress': {
      const info =
        state.kind === 'available' || state.kind === 'downloading' || state.kind === 'installing'
          ? state.info
          : null;
      if (!info) return state;
      return action.progress.event === 'installing'
        ? { kind: 'installing', info }
        : {
            kind: 'downloading',
            info,
            downloaded: action.progress.downloaded,
            total: action.progress.total,
          };
    }
  }
}

const DISMISSED_KEY = 'stratum.update.dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Retraso de la comprobación automática: que no compita con el arranque. */
export const AUTO_CHECK_DELAY_MS = 5_000;

export interface Updates {
  phase: UpdatePhase;
  /** Versión que ofrecer en el banner (`null` si no hay, o si el usuario la aparcó). */
  offer: UpdateInfo | null;
  check: () => void;
  install: () => void;
  dismiss: () => void;
}

export function useUpdates(connected: boolean, autoCheck: boolean): Updates {
  const [phase, dispatch] = useReducer(updateReducer, { kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const autoDone = useRef(false);

  const run = useCallback((manual: boolean) => {
    dispatch({ type: 'check', manual });
    checkForUpdate()
      .then((info) => dispatch({ type: 'checked', info, at: Date.now() }))
      .catch((err) => {
        if (!manual) console.info('[stratum] comprobación de actualizaciones', err);
        dispatch({ type: 'failed', message: String(err) });
      });
  }, []);

  useEffect(() => {
    if (!connected || !autoCheck || autoDone.current) return;
    const t = window.setTimeout(() => {
      autoDone.current = true;
      run(false);
    }, AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [connected, autoCheck, run]);

  const install = useCallback(() => {
    dispatch({ type: 'progress', progress: { event: 'progress', downloaded: 0, total: null } });
    installUpdate((progress) => dispatch({ type: 'progress', progress })).catch((err) =>
      dispatch({ type: 'failed', message: String(err) }),
    );
  }, []);

  const offerInfo =
    phase.kind === 'available' || phase.kind === 'downloading' || phase.kind === 'installing'
      ? phase.info
      : phase.kind === 'error'
        ? (phase.info ?? null)
        : null;
  // Una versión aparcada no se ofrece, salvo si ya se está instalando.
  const installing = phase.kind === 'downloading' || phase.kind === 'installing';
  const offer = offerInfo && (installing || offerInfo.version !== dismissed) ? offerInfo : null;

  const dismiss = useCallback(() => {
    if (!offerInfo) return;
    try {
      localStorage.setItem(DISMISSED_KEY, offerInfo.version);
    } catch {
      /* no crítico */
    }
    setDismissed(offerInfo.version);
  }, [offerInfo]);

  const check = useCallback(() => run(true), [run]);
  return { phase, offer, check, install, dismiss };
}
